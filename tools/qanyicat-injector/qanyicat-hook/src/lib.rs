//! qanyicat-hook
//!
//! Injected into QQ.exe. Hooks (a) `LoadLibraryExW` to capture native modules
//! the moment Node loads them, then (b) `QQNT.dll!napi_module_register` to
//! intercept module registration so we can swap in our own
//! `nm_register_func`. When that wrapper fires we have a real `napi_env` from
//! QQ's V8 isolate — we use it to call `napi_run_script` and execute test
//! JavaScript inside QQ.
//!
//! v0.2 only proves the JS-execution chain works (the test script writes to
//! `%TEMP%\qanyicat-js.log`). v0.3+ will replace the test script with code
//! that loads our loader.cjs and bootstraps the QanYiCat worker.
//!
//! Safety contract:
//!   * `DllMain` does NO real work — only spawns a thread.
//!   * Every error is swallowed and logged. We must never crash QQ.
//!   * Hook thunks are re-entrant: a nested LoadLibrary call bypasses logging
//!     to avoid unbounded recursion.

use std::cell::Cell;
use std::ffi::{c_char, c_int, c_uint, c_void};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::process;
use std::sync::atomic::{AtomicPtr, AtomicUsize, Ordering};

use retour::static_detour;
use windows::Win32::Foundation::{HANDLE, HMODULE};
use windows::Win32::System::LibraryLoader::{
    GetModuleHandleW, GetProcAddress, LOAD_LIBRARY_FLAGS, LoadLibraryExW, LoadLibraryW,
};
use windows::Win32::System::SystemServices::{DLL_PROCESS_ATTACH, DLL_PROCESS_DETACH};
use windows::Win32::System::Threading::{CreateThread, THREAD_CREATION_FLAGS};
use windows::core::{BOOL, PCWSTR};

// ─── NAPI types & QQNT.dll function pointers ────────────────────────────────

#[allow(non_camel_case_types)]
type napi_env = *mut c_void;
#[allow(non_camel_case_types)]
type napi_value = *mut c_void;
#[allow(non_camel_case_types)]
type napi_status = c_int;

/// Signature of `nm_register_func` inside `napi_module`. Called by Node right
/// after `napi_module_register` to populate the module's exports.
#[allow(non_camel_case_types)]
type napi_addon_register_func =
    unsafe extern "C" fn(env: napi_env, exports: napi_value) -> napi_value;

/// Mirror of Node's `napi_module` struct. Layout is stable across Node-API
/// versions; only the `nm_version` field bumps.
#[repr(C)]
#[allow(non_camel_case_types)]
struct napi_module {
    nm_version: c_int,
    nm_flags: c_uint,
    nm_filename: *const c_char,
    nm_register_func: napi_addon_register_func,
    nm_modname: *const c_char,
    nm_priv: *mut c_void,
    reserved: [*mut c_void; 4],
}

#[allow(non_camel_case_types)]
type napi_create_string_utf8_fn = unsafe extern "C" fn(
    env: napi_env,
    str: *const c_char,
    length: usize,
    result: *mut napi_value,
) -> napi_status;

#[allow(non_camel_case_types)]
type napi_run_script_fn =
    unsafe extern "C" fn(env: napi_env, script: napi_value, result: *mut napi_value) -> napi_status;

#[allow(non_camel_case_types)]
type napi_module_register_fn = unsafe extern "C" fn(*mut napi_module);

// ─── retour detours ─────────────────────────────────────────────────────────

static_detour! {
    static LoadLibraryWHook: unsafe extern "system" fn(PCWSTR) -> HMODULE;
    static LoadLibraryExWHook: unsafe extern "system" fn(PCWSTR, HANDLE, LOAD_LIBRARY_FLAGS) -> HMODULE;
    static NapiModuleRegisterHook: unsafe extern "C" fn(*mut napi_module);
    /// Hooked once to capture a real napi_env from QQ's V8 isolate without
    /// disturbing any module init. Disables itself after first successful eval.
    static NapiCreateObjectHook: unsafe extern "C" fn(napi_env, *mut napi_value) -> napi_status;
}

thread_local! {
    static IN_HOOK: Cell<bool> = const { Cell::new(false) };
}

// ─── Process-wide captured state ────────────────────────────────────────────

static WRAPPER_NODE_HMODULE: AtomicUsize = AtomicUsize::new(0);
static MAJOR_NODE_HMODULE: AtomicUsize = AtomicUsize::new(0);

static LOAD_LIBRARY_W_CALLS: AtomicUsize = AtomicUsize::new(0);
static LOAD_LIBRARY_EX_W_CALLS: AtomicUsize = AtomicUsize::new(0);
static NAPI_MODULES_REGISTERED: AtomicUsize = AtomicUsize::new(0);
static JS_EVALUATED: AtomicUsize = AtomicUsize::new(0);

static NAPI_CREATE_STRING_UTF8: AtomicPtr<()> = AtomicPtr::new(std::ptr::null_mut());
static NAPI_RUN_SCRIPT: AtomicPtr<()> = AtomicPtr::new(std::ptr::null_mut());

/// Stash original nm_register_func for each module we wrap so we can call
/// through. Keyed by the address of the napi_module struct (stable for the
/// lifetime of the registration).
static ORIGINAL_REGISTER_FUNCS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<usize, napi_addon_register_func>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

// ─── DllMain ───────────────────────────────────────────────────────────────

#[unsafe(no_mangle)]
#[allow(non_snake_case, clippy::missing_safety_doc)]
pub unsafe extern "system" fn DllMain(
    _hinst: HMODULE,
    reason: u32,
    _reserved: *mut c_void,
) -> BOOL {
    match reason {
        DLL_PROCESS_ATTACH => {
            let _ = log_event("attach", &format!("pid={}", process::id()));
            unsafe {
                let _ = CreateThread(
                    None,
                    0,
                    Some(install_hooks_thread),
                    None,
                    THREAD_CREATION_FLAGS(0),
                    None,
                );
            }
        }
        DLL_PROCESS_DETACH => {
            let _ = log_event(
                "detach",
                &format!(
                    "pid={} LoadLibraryW={} LoadLibraryExW={} napi_module_register={} js_evaluated={}",
                    process::id(),
                    LOAD_LIBRARY_W_CALLS.load(Ordering::Relaxed),
                    LOAD_LIBRARY_EX_W_CALLS.load(Ordering::Relaxed),
                    NAPI_MODULES_REGISTERED.load(Ordering::Relaxed),
                    JS_EVALUATED.load(Ordering::Relaxed),
                ),
            );
        }
        _ => {}
    }
    BOOL(1)
}

// ─── Hook installation (worker thread) ─────────────────────────────────────

unsafe extern "system" fn install_hooks_thread(_lp: *mut c_void) -> u32 {
    // 1. kernel32 LoadLibrary hooks — give us file-load visibility.
    let kernel32 = match unsafe { GetModuleHandleW(windows::core::w!("kernel32.dll")) } {
        Ok(h) => h,
        Err(e) => {
            let _ = log_event("hook-install-failed", &format!("kernel32: {e}"));
            return 1;
        }
    };
    if let Err(msg) = install_load_library_w(kernel32) {
        let _ = log_event("hook-install-failed", &format!("LoadLibraryW: {msg}"));
    } else {
        let _ = log_event("hook-install", "LoadLibraryW armed");
    }
    if let Err(msg) = install_load_library_ex_w(kernel32) {
        let _ = log_event("hook-install-failed", &format!("LoadLibraryExW: {msg}"));
    } else {
        let _ = log_event("hook-install", "LoadLibraryExW armed");
    }

    // 2. QQNT.dll napi hooks — Tencent's renamed Node runtime exports the NAPI
    // surface here. Wait briefly for it to load (it should already be in by
    // the time DllMain ran, but be defensive).
    for attempt in 0..50 {
        if let Some(h) = try_get_module(windows::core::w!("QQNT.dll")) {
            // Stash function pointers we'll call later from within the wrapped
            // nm_register_func.
            unsafe {
                if let Some(fp) = GetProcAddress(h, windows::core::s!("napi_create_string_utf8")) {
                    NAPI_CREATE_STRING_UTF8.store(fp as *mut (), Ordering::Release);
                }
                if let Some(fp) = GetProcAddress(h, windows::core::s!("napi_run_script")) {
                    NAPI_RUN_SCRIPT.store(fp as *mut (), Ordering::Release);
                }
            }

            if let Err(msg) = install_napi_module_register_hook(h) {
                let _ = log_event(
                    "hook-install-failed",
                    &format!("napi_module_register (logging only): {msg}"),
                );
            } else {
                let _ = log_event(
                    "hook-install",
                    &format!(
                        "napi_module_register armed (logging only); run_script={:p}, create_string={:p}",
                        NAPI_RUN_SCRIPT.load(Ordering::Acquire),
                        NAPI_CREATE_STRING_UTF8.load(Ordering::Acquire),
                    ),
                );
            }
            // The capture hook is the one that actually gives us napi_env
            // without disturbing module init.
            if let Err(msg) = install_napi_create_object_hook(h) {
                let _ = log_event(
                    "hook-install-failed",
                    &format!("napi_create_object (env capture): {msg}"),
                );
            } else {
                let _ = log_event(
                    "hook-install",
                    "napi_create_object armed; first call captures env + runs JS + uninstalls",
                );
            }
            return 0;
        }
        std::thread::sleep(std::time::Duration::from_millis(20 * (1 + attempt / 10)));
    }
    let _ = log_event(
        "hook-install-failed",
        "QQNT.dll never appeared after 50 attempts",
    );
    0
}

fn try_get_module(name: PCWSTR) -> Option<HMODULE> {
    unsafe { GetModuleHandleW(name).ok() }.filter(|h| !h.0.is_null())
}

fn install_load_library_w(kernel32: HMODULE) -> Result<(), String> {
    let target = unsafe { GetProcAddress(kernel32, windows::core::s!("LoadLibraryW")) }
        .ok_or("GetProcAddress(LoadLibraryW) returned null")?;
    unsafe {
        let real: unsafe extern "system" fn(PCWSTR) -> HMODULE = std::mem::transmute(target);
        LoadLibraryWHook
            .initialize(real, hooked_load_library_w)
            .map_err(|e| format!("initialize: {e}"))?;
        LoadLibraryWHook.enable().map_err(|e| format!("enable: {e}"))?;
    }
    Ok(())
}

fn install_load_library_ex_w(kernel32: HMODULE) -> Result<(), String> {
    let target = unsafe { GetProcAddress(kernel32, windows::core::s!("LoadLibraryExW")) }
        .ok_or("GetProcAddress(LoadLibraryExW) returned null")?;
    unsafe {
        let real: unsafe extern "system" fn(PCWSTR, HANDLE, LOAD_LIBRARY_FLAGS) -> HMODULE =
            std::mem::transmute(target);
        LoadLibraryExWHook
            .initialize(real, hooked_load_library_ex_w)
            .map_err(|e| format!("initialize: {e}"))?;
        LoadLibraryExWHook
            .enable()
            .map_err(|e| format!("enable: {e}"))?;
    }
    Ok(())
}

fn install_napi_module_register_hook(qqnt: HMODULE) -> Result<(), String> {
    let target = unsafe { GetProcAddress(qqnt, windows::core::s!("napi_module_register")) }
        .ok_or("GetProcAddress(QQNT!napi_module_register) returned null")?;
    unsafe {
        let real: napi_module_register_fn = std::mem::transmute(target);
        NapiModuleRegisterHook
            .initialize(real, |m| hooked_napi_module_register(m))
            .map_err(|e| format!("initialize: {e}"))?;
        NapiModuleRegisterHook
            .enable()
            .map_err(|e| format!("enable: {e}"))?;
    }
    Ok(())
}

fn install_napi_create_object_hook(qqnt: HMODULE) -> Result<(), String> {
    let target = unsafe { GetProcAddress(qqnt, windows::core::s!("napi_create_object")) }
        .ok_or("GetProcAddress(QQNT!napi_create_object) returned null")?;
    unsafe {
        let real: unsafe extern "C" fn(napi_env, *mut napi_value) -> napi_status =
            std::mem::transmute(target);
        NapiCreateObjectHook
            .initialize(real, |env, out| hooked_napi_create_object(env, out))
            .map_err(|e| format!("initialize: {e}"))?;
        NapiCreateObjectHook
            .enable()
            .map_err(|e| format!("enable: {e}"))?;
    }
    Ok(())
}

// ─── Hook thunks ───────────────────────────────────────────────────────────

fn hooked_load_library_w(name: PCWSTR) -> HMODULE {
    LOAD_LIBRARY_W_CALLS.fetch_add(1, Ordering::Relaxed);
    let entered = enter_hook();
    if !entered {
        return unsafe { LoadLibraryWHook.call(name) };
    }
    let path = unsafe { name.to_string() }.unwrap_or_else(|_| "<invalid utf16>".into());
    let _ = log_event("LoadLibraryW", &path);
    let result = unsafe { LoadLibraryWHook.call(name) };
    note_interesting_module(&path, result);
    leave_hook();
    result
}

fn hooked_load_library_ex_w(name: PCWSTR, file: HANDLE, flags: LOAD_LIBRARY_FLAGS) -> HMODULE {
    LOAD_LIBRARY_EX_W_CALLS.fetch_add(1, Ordering::Relaxed);
    let entered = enter_hook();
    if !entered {
        return unsafe { LoadLibraryExWHook.call(name, file, flags) };
    }
    let path = unsafe { name.to_string() }.unwrap_or_else(|_| "<invalid utf16>".into());
    let _ = log_event(
        "LoadLibraryExW",
        &format!("flags={:#x} {}", flags.0, path),
    );
    let result = unsafe { LoadLibraryExWHook.call(name, file, flags) };
    note_interesting_module(&path, result);
    leave_hook();
    result
}

fn note_interesting_module(path: &str, h: HMODULE) {
    if h.0.is_null() {
        return;
    }
    let lower = path.to_ascii_lowercase();
    if lower.ends_with("wrapper.node") {
        let prev = WRAPPER_NODE_HMODULE.swap(h.0 as usize, Ordering::AcqRel);
        if prev == 0 {
            let _ = log_event(
                "captured",
                &format!("wrapper.node hmodule={:#x}", h.0 as usize),
            );
        }
    } else if lower.ends_with("major.node") {
        let prev = MAJOR_NODE_HMODULE.swap(h.0 as usize, Ordering::AcqRel);
        if prev == 0 {
            let _ = log_event(
                "captured",
                &format!("major.node hmodule={:#x}", h.0 as usize),
            );
        }
    }
}

/// Hook for `napi_module_register`. v0.2: just LOG which native modules
/// register, without modifying their `nm_register_func` (any modification
/// breaks per-module init because we can't distinguish which module is
/// calling our shared trampoline). Capture happens via `napi_create_object`
/// instead.
extern "C" fn hooked_napi_module_register(module: *mut napi_module) {
    NAPI_MODULES_REGISTERED.fetch_add(1, Ordering::Relaxed);
    if !module.is_null() {
        let modname = unsafe {
            let p = (*module).nm_modname;
            if p.is_null() {
                "<null>".to_string()
            } else {
                cstr_to_string(p, 256)
            }
        };
        let _ = log_event(
            "napi_register",
            &format!("modname={} module_addr={:#x}", modname, module as usize),
        );
    }
    unsafe { NapiModuleRegisterHook.call(module) }
}

/// Hook for `napi_create_object`. Called by virtually every native module
/// during init (and many JS operations besides). On the first call we have a
/// real `napi_env` — capture it, run our test JS, then immediately disable
/// this hook so we never re-enter and never disturb the rest of QQ's startup.
extern "C" fn hooked_napi_create_object(env: napi_env, out: *mut napi_value) -> napi_status {
    let already_fired = JS_EVALUATED.fetch_add(1, Ordering::AcqRel) > 0;
    if !already_fired {
        let _ = log_event(
            "env-captured",
            &format!("first napi_create_object env={env:p}"),
        );
        let _ = try_run_test_js(env);
        // Disable the hook so subsequent calls go straight to the real
        // implementation. We deliberately do this AFTER running JS so the
        // forwarded call below already uses the native path.
        let _ = unsafe { NapiCreateObjectHook.disable() };
    }
    unsafe { NapiCreateObjectHook.call(env, out) }
}

fn try_run_test_js(env: napi_env) -> Result<(), ()> {
    let create_string_ptr = NAPI_CREATE_STRING_UTF8.load(Ordering::Acquire);
    let run_script_ptr = NAPI_RUN_SCRIPT.load(Ordering::Acquire);
    if create_string_ptr.is_null() || run_script_ptr.is_null() {
        let _ = log_event("js-eval-failed", "missing napi function pointer");
        return Err(());
    }
    let create_string: napi_create_string_utf8_fn = unsafe { std::mem::transmute(create_string_ptr) };
    let run_script: napi_run_script_fn = unsafe { std::mem::transmute(run_script_ptr) };

    // Resolve the in-QQ loader path. Priority: env var (override for testing)
    // → bundled path next to qanyicat_hook.dll → fall back to source-tree
    // location (only valid in dev). Forward slashes so JS string is safe.
    let loader_path = resolve_in_qq_loader_path();

    // Tiny shim: try multiple require strategies (because napi_run_script's
    // Realm doesn't have `require`), then `require()` our loader.cjs which
    // does all the heavy work. Errors land in the same %TEMP% log file
    // qanyicat-js.log so we can postmortem.
    let script = format!(
        r#"
(function() {{
  var fs2;
  function err(msg) {{
    try {{
      if (!fs2) {{
        try {{ fs2 = (typeof require !== 'undefined' ? require('fs') : null); }} catch (_) {{}}
        if (!fs2 && typeof process !== 'undefined' && process.binding) {{
          try {{ fs2 = process.binding('fs'); }} catch (_) {{}}
        }}
      }}
      if (fs2 && fs2.appendFileSync) {{
        fs2.appendFileSync('C:/Windows/Temp/qanyicat-js-error.log', new Date().toISOString() + ' ' + msg + '\n');
      }}
      globalThis.__qanyicat_js_error = msg;
    }} catch (_) {{}}
  }}
  function tryRequire() {{
    if (typeof process === 'undefined') throw new Error('no process global');
    if (process.mainModule && typeof process.mainModule.require === 'function') {{
      return process.mainModule.require.bind(process.mainModule);
    }}
    if (typeof require === 'function') return require;
    throw new Error('no require path available');
  }}
  try {{
    var req = tryRequire();
    req({loader_path:?});
    globalThis.__qanyicat_alive = Date.now();
  }} catch (e) {{
    err('top-level loader load failed: ' + (e && (e.stack || e.message) || String(e)));
  }}
}})();
"#,
        loader_path = loader_path
    );
    let mut script_bytes = script.into_bytes();
    let len = script_bytes.len();
    script_bytes.push(0);

    let mut script_value: napi_value = std::ptr::null_mut();
    let status1 = unsafe {
        create_string(
            env,
            script_bytes.as_ptr() as *const c_char,
            len,
            &mut script_value,
        )
    };
    if status1 != 0 {
        let _ = log_event(
            "js-eval-failed",
            &format!("napi_create_string_utf8 status={status1}"),
        );
        return Err(());
    }

    let mut result: napi_value = std::ptr::null_mut();
    let status2 = unsafe { run_script(env, script_value, &mut result) };
    if status2 != 0 {
        let _ = log_event("js-eval-failed", &format!("napi_run_script status={status2}"));
        return Err(());
    }
    let _ = log_event("js-eval-ok", "test script dispatched");
    Ok(())
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn enter_hook() -> bool {
    IN_HOOK.with(|c| {
        if c.get() {
            false
        } else {
            c.set(true);
            true
        }
    })
}

fn leave_hook() {
    IN_HOOK.with(|c| c.set(false));
}

/// Find the qq-loader CJS file. Order:
///   1. `QANYICAT_QQ_LOADER_PATH` env var (operator override)
///   2. DLL-relative walk-up — find `tools/qq-loader/index.cjs` somewhere
///      above the directory containing this DLL. Works for the
///      `tools/qanyicat-injector/target/release/qanyicat_hook.dll` layout
///      regardless of where the repo lives on disk (no hardcoded path).
///   3. CWD-relative fallback — for unusual installations where the DLL
///      sits standalone but the working directory is the repo root.
/// Always returns forward-slash paths so the JS string literal stays sane.
fn resolve_in_qq_loader_path() -> String {
    if let Ok(env_path) = std::env::var("QANYICAT_QQ_LOADER_PATH") {
        if !env_path.is_empty() {
            return env_path.replace('\\', "/");
        }
    }
    if let Some(dll_path) = current_dll_path() {
        if let Some(found) = walk_up_for_loader(&dll_path) {
            return path_to_forward(&found);
        }
    }
    // Last resort: walk up from cwd.
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(found) = walk_up_for_loader(&cwd) {
            return path_to_forward(&found);
        }
    }
    // Truly hopeless: hand back a relative path that'll likely 404 with a
    // clear log message. The JS error handler picks this up.
    "./tools/qq-loader/index.cjs".to_string()
}

/// Absolute path of `qanyicat_hook.dll` itself, resolved at runtime via
/// `GetModuleFileNameW(GetModuleHandleW("qanyicat_hook.dll"))`. Returns None
/// if either Win32 call fails (extremely unusual — the DLL is mapped in by
/// definition when this code runs).
fn current_dll_path() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::System::LibraryLoader::GetModuleFileNameW;
    let h = unsafe { GetModuleHandleW(windows::core::w!("qanyicat_hook.dll")) }.ok()?;
    let mut buf = vec![0u16; 1024];
    let len = unsafe { GetModuleFileNameW(Some(h), &mut buf) };
    if len == 0 { return None; }
    let s = std::ffi::OsString::from_wide(&buf[..len as usize]);
    Some(PathBuf::from(s))
}

/// Walk up from `start` looking for `tools/qq-loader/index.cjs`. Caps at 8
/// levels to keep this O(1) on weird relocations. Exposed for unit testing
/// — the production caller passes either the DLL path or cwd.
fn walk_up_for_loader(start: &std::path::Path) -> Option<PathBuf> {
    let mut cur = if start.is_file() { start.parent()? } else { start };
    for _ in 0..8 {
        let candidate = cur.join("tools").join("qq-loader").join("index.cjs");
        if candidate.exists() {
            return Some(candidate);
        }
        cur = cur.parent()?;
    }
    None
}

fn path_to_forward(p: &std::path::Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

unsafe fn cstr_to_string(p: *const c_char, max: usize) -> String {
    let mut len = 0usize;
    while len < max && unsafe { *p.add(len) } != 0 {
        len += 1;
    }
    let slice = unsafe { std::slice::from_raw_parts(p as *const u8, len) };
    String::from_utf8_lossy(slice).into_owned()
}

#[allow(dead_code)]
fn _keep_imports() {
    let _ = unsafe { LoadLibraryW(windows::core::w!("kernel32.dll")) };
    let _ = unsafe {
        LoadLibraryExW(
            windows::core::w!("kernel32.dll"),
            None,
            LOAD_LIBRARY_FLAGS(0),
        )
    };
}

fn log_event(kind: &str, detail: &str) -> std::io::Result<()> {
    let path = log_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    writeln!(
        f,
        "{} qanyicat-hook[{}] {}: {}",
        now,
        std::env::current_exe()
            .map(|p| p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default())
            .unwrap_or_default(),
        kind,
        detail
    )
}

fn log_path() -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push("qanyicat-hook.log");
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering as TestOrdering};

    /// std-only "temp dir" helper. Created under `std::env::temp_dir()`, name
    /// includes pid + a process-local counter so concurrent test invocations
    /// don't clash. Caller is responsible for not leaking it on early return
    /// (we use the Drop guard below).
    struct TmpRepo(PathBuf);
    impl TmpRepo {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, TestOrdering::SeqCst);
            let dir = std::env::temp_dir().join(format!("qyc-hook-test-{}-{}-{}", tag, process::id(), n));
            fs::create_dir_all(&dir).unwrap();
            TmpRepo(dir)
        }
        fn path(&self) -> &std::path::Path { &self.0 }
    }
    impl Drop for TmpRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Build a fake repo layout matching what the bridge expects:
    ///   <root>/tools/qq-loader/index.cjs
    ///   <root>/tools/qanyicat-injector/target/release/qanyicat_hook.dll
    fn fake_repo() -> (TmpRepo, PathBuf) {
        let tmp = TmpRepo::new("repo");
        let root = tmp.path().to_path_buf();
        fs::create_dir_all(root.join("tools").join("qq-loader")).unwrap();
        fs::write(root.join("tools").join("qq-loader").join("index.cjs"), b"// stub").unwrap();
        let dll_dir = root.join("tools").join("qanyicat-injector").join("target").join("release");
        fs::create_dir_all(&dll_dir).unwrap();
        let dll_path = dll_dir.join("qanyicat_hook.dll");
        fs::write(&dll_path, b"// fake").unwrap();
        (tmp, dll_path)
    }

    #[test]
    fn walk_up_finds_loader_from_dll_dir() {
        let (_tmp, dll_path) = fake_repo();
        let found = walk_up_for_loader(&dll_path).expect("loader found");
        assert!(found.exists());
        let s = found.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("tools/qq-loader/index.cjs"), "got {s}");
    }

    #[test]
    fn walk_up_caps_at_8_levels() {
        // Deep but valid path with NO loader anywhere — should return None
        // rather than walking to filesystem root forever.
        let tmp = TmpRepo::new("deep");
        let mut deep = tmp.path().to_path_buf();
        for i in 0..12 { deep = deep.join(format!("d{i}")); }
        fs::create_dir_all(&deep).unwrap();
        assert_eq!(walk_up_for_loader(&deep), None);
    }

    #[test]
    fn walk_up_returns_none_when_no_repo_above() {
        let tmp = TmpRepo::new("bare");
        assert_eq!(walk_up_for_loader(tmp.path()), None);
    }

    #[test]
    fn walk_up_handles_file_path_input() {
        // Caller may pass the DLL file path (not its containing dir);
        // walk-up should still find the loader.
        let (_tmp, dll_path) = fake_repo();
        assert!(dll_path.is_file());
        assert!(walk_up_for_loader(&dll_path).is_some());
    }

    #[test]
    fn path_to_forward_normalizes_separators() {
        let p = PathBuf::from("C:\\foo\\bar\\baz.cjs");
        assert_eq!(path_to_forward(&p), "C:/foo/bar/baz.cjs");
    }
}
