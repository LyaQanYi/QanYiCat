# qanyicat-injector

Native Windows DLL injector + hook DLL that boots QanYiCat inside QQ.exe's
Electron process — a "live inside QQ" injection path, written end-to-end in
Rust.

**Status: v0.4a — wrapper.node methods are not just captured but actually CALLED from our loader.** `engine.getDeviceInfo()`, `loginService.getMachineGuid()`, `loginService.getMsfStatus()` all return real data from QQ's NT runtime.

The hook DLL hands `napi_run_script` a tiny shim that `require()`s
[`tools/qq-loader/index.cjs`](../qq-loader/index.cjs). That CJS file then
hooks `process.dlopen` from the JS side and grabs `module.exports` when
Tencent's main JS loads `wrapper.node`. Captured exports include:

```
NodeIQQNTWrapperEngine, NodeIKernelLoginService, NodeIKernelMsgService,
NodeIQQNTWrapperSession, NodeIKernelGroupService, NodeIKernelBuddyService,
... 85 services in total
```

QQ keeps all 4 processes alive after injection — neither the native hook
nor the JS loader disturbs module init.

## Three binaries / one hook chain

| Binary | What it does |
|---|---|
| `qanyicat-launcher.exe` | Spawns QQ.exe with `CREATE_SUSPENDED`, allocates remote memory, calls `LoadLibraryW` via `CreateRemoteThread` to map our hook DLL, then resumes QQ. |
| `qanyicat_hook.dll` | Loaded into QQ.exe. DllMain spawns a worker thread (avoids loader lock) that installs four detours: `LoadLibraryW`, `LoadLibraryExW`, `QQNT.dll!napi_module_register`, `QQNT.dll!napi_create_object`. |
| [`tools/qq-loader/index.cjs`](../qq-loader/index.cjs) | The CJS entry our hook DLL `require()`s inside QQ. v0.3 logs runtime info and captures wrapper.node's exports via a JS-level `process.dlopen` hook. v0.4 will replace it with a thin shim that loads the bundled QanYiCat worker. |

Zero file modifications under `C:\Program Files\Tencent\QQNT\`. No admin
required. Doesn't trigger `application.json` signature checks.

## Why these specific hooks

QQ's modified Electron exposes the entire Node-API surface from **`QQNT.dll`**
(it's their renamed `node.dll`). We discovered this by dumping `wrapper.node`
with `objdump -p` and finding its NAPI imports tagged with
`DLL Name: QQNT.dll`. Key exports:

| Symbol | Used for |
|---|---|
| `napi_module_register` | Hooked to log every native module registration (so we know when `wrapper.node` lands). |
| `napi_create_object` | Hooked **once** — first call captures a live `napi_env` from QQ's V8 isolate, then we disable the hook. |
| `napi_create_string_utf8` | Resolved as a function pointer at hook-install time; called from inside `napi_create_object`'s thunk to build the JS source string. |
| `napi_run_script` | Same — called with the captured env to evaluate our JS in QQ's global Realm. |

The reason we don't intercept `wrapper.node`'s `nm_register_func` (the
obvious-looking target) is that a shared trampoline can't distinguish which
module is being initialized. Hooking the universal `napi_create_object`
sidesteps this entirely — it's called by **every** module during init and
gives us `napi_env` without touching the module struct.

## Build

From the repo root, the helper script handles the MinGW PATH + the Chinese-path
`CARGO_TARGET_DIR` workaround + copy-back:

```powershell
.\build-injector.ps1
```

Or build directly (ensure MinGW-w64's `bin` is on PATH first):

```powershell
cd tools\qanyicat-injector
cargo build --release
```

Toolchain (one-time):
- **Rust nightly** (pinned via `rust-toolchain.toml` to `nightly-2026-05-15`)
  — needed because `retour 0.3` uses unstable `tuple_trait` /
  `unboxed_closures`. Pin is workspace-local.
- **MinGW-w64** on PATH — needed by `x86_64-pc-windows-gnu` for linking.

Outputs:
- `target\release\qanyicat-launcher.exe` (~260 KB)
- `target\release\qanyicat_hook.dll` (~270 KB)

## Smoke test

```powershell
Get-Process QQ -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item (Join-Path $env:TEMP 'qanyicat-hook.log'),
            (Join-Path $env:TEMP 'qanyicat-js.log') -ErrorAction SilentlyContinue

& .\target\release\qanyicat-launcher.exe `
    'C:\Program Files\Tencent\QQNT\QQ.exe' `
    .\target\release\qanyicat_hook.dll

Start-Sleep 10
Get-Content (Join-Path $env:TEMP 'qanyicat-js.log')
```

Expected:
- `INJECTED. QQ.exe is now running as PID <N>` from launcher
- QQ window appears, 4 QQ processes visible
- `qanyicat-js.log` contains the runtime banner above

The full hook log (`%TEMP%\qanyicat-hook.log`) shows the chain step by step:

```
... attach: pid=N
... hook-install: LoadLibraryW armed
... hook-install: LoadLibraryExW armed
... hook-install: napi_module_register armed (logging only)
... hook-install: napi_create_object armed; first call captures env + runs JS
... napi_register: modname=major
... napi_register: modname=QQNT          ← that's wrapper.node
... env-captured: first napi_create_object env=0x...
... js-eval-ok: test script dispatched
... napi_register: modname=QQNTIPC       ← still working after our hook
... napi_register: modname=NODE_GYP_MODULE_NAME
```

## v0.3 work plan

1. **Replace the test JS with a real loader.** The script we hand to
   `napi_run_script` becomes a one-liner:
   `process.mainModule.require('D:/.../qanyicat-loader.cjs')`
   — pulling in the existing CJS loader template, which then has full Node
   access (require, fs, child_process, IPC, …) inside QQ's Electron process.
2. **Bridge the captured `wrapper.node`** — once our loader is running we
   already know the HMODULE of `wrapper.node` (recorded in
   `WRAPPER_NODE_HMODULE`). We pass that pointer into JS via a global the
   loader reads, or directly via the captured exports object.
3. **Bootstrap CoreBootstrap.start()** — the existing
   `packages/core/src/session/bootstrap.ts` flow becomes runnable. Session
   init, listener registration, NT API wiring — all the v0.2 TODOs from the
   protocol layer.
4. **Optional: IPC channel from DLL → external worker** — if we want the
   QanYiCat worker to be a separate process (rather than running inside QQ),
   add a named pipe. Right now everything runs inside QQ's Electron.

## Files

```
qanyicat-injector/
├── Cargo.toml                       workspace + retour/windows deps
├── rust-toolchain.toml              pins nightly-2026-05-15 to this workspace
├── qanyicat-launcher/               CreateProcess + remote-thread injection
│   ├── Cargo.toml
│   └── src/main.rs
└── qanyicat-hook/                   the hook DLL
    ├── Cargo.toml
    └── src/lib.rs                   ← all the logic above lives here
```
