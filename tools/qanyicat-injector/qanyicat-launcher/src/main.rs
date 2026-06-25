//! qanyicat-launcher
//!
//! Spawns QQ.exe with `CREATE_SUSPENDED`, allocates remote memory, writes the
//! absolute path of `qanyicat-hook.dll` into it, then `CreateRemoteThread`s
//! `LoadLibraryW` as the entry point. Once the DLL maps in, resume the QQ
//! main thread.
//!
//! Usage:
//!   qanyicat-launcher.exe [OPTIONS] <qq.exe path> <qanyicat-hook.dll path> [...qq args]
//!
//! Options:
//!   --verbose, -v       Print step-by-step diagnostics to stderr.
//!   --resolve-qq        Look up QQ.exe path via the install registry key and
//!                       print it (use as a script helper). Doesn't inject.
//!   --version           Print version and exit.
//!   --help, -h          Print this help and exit.
//!
//! Exits non-zero on any injection failure. Always tries to clean up the
//! suspended process if injection fails halfway.

use std::env;
use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::PathBuf;
use std::process::ExitCode;

use windows::Win32::Foundation::{CloseHandle, ERROR_MORE_DATA, ERROR_SUCCESS, HANDLE, WAIT_TIMEOUT, WIN32_ERROR};
use windows::Win32::System::Diagnostics::Debug::WriteProcessMemory;
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::System::Memory::{
    MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE, VirtualAllocEx, VirtualFreeEx,
};
use windows::Win32::System::Registry::{
    HKEY, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, REG_SZ, REG_VALUE_TYPE, RegCloseKey,
    RegOpenKeyExW, RegQueryValueExW,
};
use windows::Win32::System::Threading::{
    CREATE_SUSPENDED, CreateProcessW, CreateRemoteThread, LPTHREAD_START_ROUTINE,
    PROCESS_INFORMATION, ResumeThread, STARTUPINFOW, TerminateProcess, WaitForSingleObject,
};
use windows::core::{PCWSTR, PWSTR};

const INJECT_TIMEOUT_MS: u32 = 30_000;
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Parsed command-line — exposed so unit tests can validate flag handling
/// without spawning processes.
#[derive(Debug, PartialEq)]
struct ParsedArgs {
    mode: Mode,
    verbose: bool,
    /// Positional args after flags: [qq.exe, hook.dll, ...qq_args].
    positional: Vec<String>,
}

#[derive(Debug, PartialEq)]
enum Mode {
    Inject,
    Help,
    Version,
    ResolveQq,
}

/// Hand-rolled flag parser (avoids a clap dep just for 4 flags). Stops at the
/// first non-flag positional and treats everything after as positional.
fn parse_args(args: &[String]) -> Result<ParsedArgs, String> {
    let mut parsed = ParsedArgs { mode: Mode::Inject, verbose: false, positional: Vec::new() };
    let mut iter = args.iter().skip(1); // skip argv[0]
    while let Some(a) = iter.next() {
        match a.as_str() {
            "--help" | "-h" => parsed.mode = Mode::Help,
            "--version" => parsed.mode = Mode::Version,
            "--resolve-qq" => parsed.mode = Mode::ResolveQq,
            "--verbose" | "-v" => parsed.verbose = true,
            "--" => {
                // Everything after `--` is positional, even if it starts with `-`.
                parsed.positional.extend(iter.cloned());
                break;
            }
            s if s.starts_with("--") || (s.len() > 1 && s.starts_with('-') && !s.starts_with('-')) => {
                return Err(format!("unknown flag: {s}"));
            }
            _ => {
                // First positional — rest are positional too.
                parsed.positional.push(a.clone());
                parsed.positional.extend(iter.cloned());
                break;
            }
        }
    }
    Ok(parsed)
}

fn print_usage(stream: &mut dyn std::io::Write, prog: &str) {
    let _ = writeln!(
        stream,
        "qanyicat-launcher {VERSION}\n\
         \n\
         USAGE:\n\
         \x20\x20{prog} [OPTIONS] <QQ.EXE> <HOOK.DLL> [QQ_ARGS...]\n\
         \n\
         OPTIONS:\n\
         \x20\x20-h, --help          Print this help and exit\n\
         \x20\x20    --version       Print launcher version and exit\n\
         \x20\x20-v, --verbose       Step-by-step diagnostics to stderr\n\
         \x20\x20    --resolve-qq    Print QQ.exe path resolved from HKLM uninstall key and exit\n\
         \n\
         ARGS:\n\
         \x20\x20<QQ.EXE>    Absolute path to Tencent QQ.exe\n\
         \x20\x20<HOOK.DLL>  Absolute path to qanyicat_hook.dll\n\
         \x20\x20[QQ_ARGS]   Optional extra args forwarded to QQ.exe\n\
         \n\
         EXIT CODES:\n\
         \x20\x200  injection succeeded\n\
         \x20\x201  injection failed at some Win32 step\n\
         \x20\x202  bad usage (missing args / file not found / bad flag)\n\
         \x20\x203  --resolve-qq couldn't find QQ in the registry"
    );
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    let prog = args.first().map(String::as_str).unwrap_or("qanyicat-launcher");

    let parsed = match parse_args(&args) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("error: {e}");
            print_usage(&mut std::io::stderr(), prog);
            return ExitCode::from(2);
        }
    };

    match parsed.mode {
        Mode::Help => {
            print_usage(&mut std::io::stdout(), prog);
            return ExitCode::SUCCESS;
        }
        Mode::Version => {
            println!("qanyicat-launcher {VERSION}");
            return ExitCode::SUCCESS;
        }
        Mode::ResolveQq => match resolve_qq_via_registry() {
            Ok(path) => {
                println!("{}", path.display());
                return ExitCode::SUCCESS;
            }
            Err(e) => {
                eprintln!("could not resolve QQ.exe via registry: {e}");
                return ExitCode::from(3);
            }
        },
        Mode::Inject => { /* fall through */ }
    }

    if parsed.positional.len() < 2 {
        eprintln!("error: missing required positional args\n");
        print_usage(&mut std::io::stderr(), prog);
        return ExitCode::from(2);
    }
    let qq_exe = PathBuf::from(&parsed.positional[0]);
    let hook_dll = PathBuf::from(&parsed.positional[1]);
    let qq_args = &parsed.positional[2..];

    if !qq_exe.exists() {
        eprintln!("QQ not found at: {}", qq_exe.display());
        return ExitCode::from(2);
    }
    if !hook_dll.exists() {
        eprintln!("hook DLL not found at: {}", hook_dll.display());
        return ExitCode::from(2);
    }

    if parsed.verbose {
        eprintln!("[launcher] version={VERSION}");
        eprintln!("[launcher] QQ.exe   = {}", qq_exe.display());
        eprintln!("[launcher] hook.dll = {}", hook_dll.display());
        eprintln!("[launcher] qq_args  = {qq_args:?}");
    }

    match inject(&qq_exe, &hook_dll, qq_args, parsed.verbose) {
        Ok(pid) => {
            println!("INJECTED. QQ.exe is now running as PID {pid} with qanyicat-hook.dll mapped in.");
            println!("Watch %TEMP%\\qanyicat-hook.log for hook activity.");
            ExitCode::SUCCESS
        }
        Err(msg) => {
            eprintln!("injection failed: {msg}");
            ExitCode::from(1)
        }
    }
}

fn inject(
    qq_exe: &PathBuf,
    hook_dll: &PathBuf,
    qq_args: &[String],
    verbose: bool,
) -> Result<u32, String> {
    let abs_hook = hook_dll
        .canonicalize()
        .map_err(|e| format!("canonicalize hook dll: {e}"))?;
    if verbose { eprintln!("[launcher] canonicalize → {}", abs_hook.display()); }

    let mut command_line = build_command_line(qq_exe, qq_args);

    let si = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut pi = PROCESS_INFORMATION::default();

    let qq_exe_w = wide(qq_exe.as_os_str());

    if verbose { eprintln!("[launcher] CreateProcessW SUSPENDED..."); }
    let create = unsafe {
        CreateProcessW(
            PCWSTR(qq_exe_w.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            false,
            CREATE_SUSPENDED,
            None,
            None,
            &si,
            &mut pi,
        )
    };
    create.map_err(|e| format!("CreateProcessW: {e}"))?;
    if verbose { eprintln!("[launcher] QQ.exe spawned suspended; PID={}", pi.dwProcessId); }

    // From here on, every error path must `TerminateProcess + Close` so we
    // never leak a suspended QQ process the user can't see.
    let result = (|| -> Result<u32, String> {
        let dll_path_w = wide(abs_hook.as_os_str());
        let dll_path_bytes = dll_path_w.len() * std::mem::size_of::<u16>();

        if verbose { eprintln!("[launcher] VirtualAllocEx {dll_path_bytes} bytes in remote..."); }
        let remote_buf = unsafe {
            VirtualAllocEx(
                pi.hProcess,
                None,
                dll_path_bytes,
                MEM_COMMIT | MEM_RESERVE,
                PAGE_READWRITE,
            )
        };
        if remote_buf.is_null() {
            return Err("VirtualAllocEx returned null".into());
        }

        let mut written = 0usize;
        unsafe {
            WriteProcessMemory(
                pi.hProcess,
                remote_buf,
                dll_path_w.as_ptr().cast(),
                dll_path_bytes,
                Some(&mut written),
            )
        }
        .map_err(|e| {
            let _ = unsafe { VirtualFreeEx(pi.hProcess, remote_buf, 0, MEM_RELEASE) };
            format!("WriteProcessMemory: {e}")
        })?;
        if verbose { eprintln!("[launcher] WriteProcessMemory wrote={written} bytes"); }

        let kernel32 = unsafe { GetModuleHandleW(windows::core::w!("kernel32.dll")) }
            .map_err(|e| format!("GetModuleHandleW(kernel32): {e}"))?;
        let load_library_w = unsafe { GetProcAddress(kernel32, windows::core::s!("LoadLibraryW")) };
        let Some(load_library_w) = load_library_w else {
            return Err("GetProcAddress(LoadLibraryW) returned null".into());
        };
        let start_routine: LPTHREAD_START_ROUTINE = unsafe {
            std::mem::transmute::<unsafe extern "system" fn() -> isize, _>(load_library_w)
        };

        if verbose { eprintln!("[launcher] CreateRemoteThread(LoadLibraryW)..."); }
        let remote_thread = unsafe {
            CreateRemoteThread(
                pi.hProcess,
                None,
                0,
                start_routine,
                Some(remote_buf),
                0,
                None,
            )
        }
        .map_err(|e| format!("CreateRemoteThread: {e}"))?;

        // Wait for LoadLibraryW to return so we know mapping completed (or
        // failed) before we resume QQ. If it hangs > timeout, give up.
        let wait = unsafe { WaitForSingleObject(remote_thread, INJECT_TIMEOUT_MS) };
        if wait == WAIT_TIMEOUT {
            return Err("LoadLibraryW timed out in remote process".into());
        }
        if verbose { eprintln!("[launcher] remote LoadLibraryW returned"); }

        unsafe {
            let _ = CloseHandle(remote_thread);
            let _ = VirtualFreeEx(pi.hProcess, remote_buf, 0, MEM_RELEASE);
        }

        if verbose { eprintln!("[launcher] ResumeThread..."); }
        let resumed = unsafe { ResumeThread(pi.hThread) };
        if resumed == u32::MAX {
            return Err("ResumeThread failed".into());
        }
        Ok(pi.dwProcessId)
    })();

    match &result {
        Ok(_) => {
            unsafe {
                let _ = CloseHandle(pi.hThread);
                let _ = CloseHandle(pi.hProcess);
            }
        }
        Err(_) => {
            unsafe {
                let _ = TerminateProcess(pi.hProcess, 1);
                let _ = CloseHandle(pi.hThread);
                let _ = CloseHandle(pi.hProcess);
            }
        }
    }

    result
}

fn build_command_line(qq_exe: &PathBuf, args: &[String]) -> Vec<u16> {
    let mut s = OsString::from("\"");
    s.push(qq_exe);
    s.push("\"");
    for a in args {
        s.push(" ");
        s.push(a);
    }
    wide(&s)
}

fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

/// Reads `HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ`'s
/// `UninstallString`, drops the trailing `Uninstall.exe`, and returns the
/// implied `QQ.exe`. Returns Err when the key is absent (QQ not installed, or
/// installed somewhere we can't see).
fn resolve_qq_via_registry() -> Result<PathBuf, String> {
    let subkey: Vec<u16> = wide(std::ffi::OsStr::new(
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ",
    ));
    let mut hkey = HKEY::default();
    // KEY_WOW64_32KEY forces the WOW6432Node redirector even on 64-bit hosts,
    // matching the bat's `HKLM\SOFTWARE\WOW6432Node\…` path.
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(subkey.as_ptr()),
            None,
            KEY_READ | KEY_WOW64_32KEY,
            &mut hkey,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("RegOpenKeyExW status={status:?}"));
    }

    let value = wide(std::ffi::OsStr::new("UninstallString"));
    let mut buf: Vec<u16> = vec![0; 1024];
    let mut byte_len: u32 = (buf.len() * 2) as u32;
    let mut value_type = REG_VALUE_TYPE(0);
    let query = unsafe {
        RegQueryValueExW(
            hkey,
            PCWSTR(value.as_ptr()),
            None,
            Some(&mut value_type),
            Some(buf.as_mut_ptr().cast()),
            Some(&mut byte_len),
        )
    };
    // Grow buffer once if the value didn't fit.
    let query: WIN32_ERROR = if query == ERROR_MORE_DATA {
        buf = vec![0; (byte_len as usize / 2) + 1];
        byte_len = (buf.len() * 2) as u32;
        unsafe {
            RegQueryValueExW(
                hkey,
                PCWSTR(value.as_ptr()),
                None,
                Some(&mut value_type),
                Some(buf.as_mut_ptr().cast()),
                Some(&mut byte_len),
            )
        }
    } else { query };
    let _ = unsafe { RegCloseKey(hkey) };
    if query != ERROR_SUCCESS {
        return Err(format!("RegQueryValueExW status={query:?}"));
    }
    if value_type != REG_SZ {
        return Err(format!("UninstallString unexpected type={value_type:?}"));
    }

    // wide → OsString → trim trailing NUL + optional surrounding quotes
    let chars = byte_len as usize / 2;
    let end = buf[..chars]
        .iter()
        .position(|&c| c == 0)
        .unwrap_or(chars);
    let raw = OsString::from_wide(&buf[..end])
        .into_string()
        .map_err(|_| "non-UTF16 path in registry".to_string())?;
    let trimmed = raw.trim_matches('"').to_string();
    let mut path = PathBuf::from(trimmed);
    // Drop "Uninstall.exe" filename, push "QQ.exe"
    let _ = path.pop();
    path.push("QQ.exe");
    if !path.exists() {
        return Err(format!(
            "derived path doesn't exist: {} (registry might point at a moved install)",
            path.display()
        ));
    }
    Ok(path)
}

#[allow(dead_code)]
fn close(h: HANDLE) {
    if !h.is_invalid() {
        let _ = unsafe { CloseHandle(h) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        std::iter::once("launcher").chain(args.iter().copied()).map(String::from).collect()
    }

    #[test]
    fn parse_default_is_inject_mode() {
        let p = parse_args(&argv(&["qq.exe", "hook.dll"])).unwrap();
        assert_eq!(p.mode, Mode::Inject);
        assert!(!p.verbose);
        assert_eq!(p.positional, vec!["qq.exe", "hook.dll"]);
    }

    #[test]
    fn parse_help_short_and_long() {
        assert_eq!(parse_args(&argv(&["--help"])).unwrap().mode, Mode::Help);
        assert_eq!(parse_args(&argv(&["-h"])).unwrap().mode, Mode::Help);
    }

    #[test]
    fn parse_version() {
        assert_eq!(parse_args(&argv(&["--version"])).unwrap().mode, Mode::Version);
    }

    #[test]
    fn parse_resolve_qq() {
        let p = parse_args(&argv(&["--resolve-qq"])).unwrap();
        assert_eq!(p.mode, Mode::ResolveQq);
        assert!(p.positional.is_empty());
    }

    #[test]
    fn parse_verbose_with_positional() {
        let p = parse_args(&argv(&["--verbose", "qq.exe", "hook.dll"])).unwrap();
        assert_eq!(p.mode, Mode::Inject);
        assert!(p.verbose);
        assert_eq!(p.positional, vec!["qq.exe", "hook.dll"]);
    }

    #[test]
    fn parse_short_verbose_flag() {
        let p = parse_args(&argv(&["-v", "qq.exe", "hook.dll"])).unwrap();
        assert!(p.verbose);
    }

    #[test]
    fn parse_unknown_flag_is_error() {
        let err = parse_args(&argv(&["--no-such-flag"])).unwrap_err();
        assert!(err.contains("unknown flag"));
    }

    #[test]
    fn parse_double_dash_terminator_before_positionals() {
        // `--` as the FIRST token after argv[0] is the conventional flag
        // terminator. After it, everything is positional regardless of leading
        // dashes. (When `--` appears AFTER a positional, it's already too late
        // — the first-positional-stops-flags rule wins; see the next test.)
        let p = parse_args(&argv(&["--", "qq.exe", "hook.dll"])).unwrap();
        assert_eq!(p.mode, Mode::Inject);
        assert_eq!(p.positional, vec!["qq.exe", "hook.dll"]);
    }

    #[test]
    fn parse_first_positional_stops_flag_parsing() {
        // After the first positional, even strings starting with -- are positional
        // (avoids confusion when QQ args have leading dashes).
        let p = parse_args(&argv(&["qq.exe", "--would-be-flag", "hook.dll"])).unwrap();
        assert_eq!(p.positional, vec!["qq.exe", "--would-be-flag", "hook.dll"]);
    }
}
