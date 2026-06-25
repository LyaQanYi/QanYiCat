# QanYiCat — Linux Port Plan

**Status:** design-only, not yet implemented. Written 2026-05-24.
**Scope:** what it would take to run QanYiCat against the Linux build of QQ NT.
**Audience:** anyone with a Linux box who wants to pick this up — the goal of
this doc is for the work to be well-scoped enough that you can estimate it in
days, not weeks.

---

## 1. Goal & non-goals

### Goal

A `quick-start.sh` (mirror of `quick-start.bat`) that, on a desktop Linux
distro with QQ NT installed, brings up QQ with the QanYiCat hook loaded such
that the bridge runs inside QQ's Node 22 / Electron main process and exposes
the same OneBot wire (`http://127.0.0.1:5700`, `ws://127.0.0.1:5710`, OB12
on `5720`) + WebUI (`5800`) we already ship on Windows.

Working definition of "ported":
1. `pnpm typecheck && pnpm test` still pass (today they do on every OS).
2. `cargo build --release` produces `qanyicat-launcher` + `libqanyicat_hook.so`
   on `x86_64-unknown-linux-gnu`.
3. `./quick-start.sh` launches QQ, the loader log fills in, OneBot
   `get_status` returns `online: true`, and a private msg from another
   account round-trips through `tools/echo-bot/index.mjs`.
4. `tools/smoke/live-curl.mjs` reports all probes green.

### Non-goals (explicitly out)

- macOS port. QQ NT has a macOS build but it's a different beast (codesign,
  notarization, SIP, hardened runtime). Worth a separate doc.
- ARM64 Linux. Likely works with minor cargo target changes once x64 is done;
  defer until somebody asks.
- Anything that requires modifying QQ's install files. Same rule as Windows
  (fact #1): NT does RSA signature verification on `application.asar` /
  `wrapper.node` / `package.json`. Likely true on Linux too. Stay injection-only.
- Linux service / systemd integration. The bot should still be launched
  interactively for v1; daemonizing is a follow-up.
- Multi-account on a single Linux box. Single bot per process, same as Windows.

---

## 2. Current Windows-only surface (what we'd be porting)

A grep for `windows`, `Win32`, `wide`, `cdylib`, `dll` across the repo
returns three concentric circles:

### 2a. `tools/qanyicat-injector/` (Rust, hard Windows lock-in)

- **`qanyicat-launcher`** (`Cargo.toml` deps `windows = …`): one binary that
  `CreateProcessW(QQ.exe, CREATE_SUSPENDED)` → `VirtualAllocEx` →
  `WriteProcessMemory(dllPath)` → `CreateRemoteThread(LoadLibraryW)` →
  `ResumeThread`. Plus a `--resolve-qq` mode that reads
  `HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ`.
- **`qanyicat-hook`** (`crate-type = ["cdylib"]`, deps `windows` + `retour`):
  the DLL loaded by the launcher. On `DllMain(DLL_PROCESS_ATTACH)` it spawns
  a thread that hooks `QQNT.dll!napi_create_object` via `retour::static_detour`
  to capture a `napi_env`, then calls `napi_run_script(env, <require loader.cjs>)`.
- **`build-injector.ps1`**: encapsulates the
  `CARGO_TARGET_DIR=C:\qyc-cargo-target` + MinGW PATH workaround for
  Chinese-path repos.

### 2b. `tools/qq-loader/index.cjs` (Node, mostly portable)

CJS loader that runs inside QQ's Node 22 via `napi_run_script`. It:
- Walks `process.dlopen` to capture `wrapper.node` exports when QQ's
  `app_launcher` loads them.
- Attaches kernel listeners (msg, buddy, group).
- After login completes, dynamic-imports the bridge:
  `await import('file:///<abs>/packages/inject-bridge/dist/index.mjs').bootInsideQQ(...)`.
- **Linux-relevant gotcha** (fixed in v0.4n-housekeeping-11): the `BRIDGE_PATH`
  env-or-fallback used to point at a hardcoded absolute dev path. Now
  walks up from `__filename` (8-level cap) to find
  `packages/inject-bridge/dist/index.mjs`, mirroring `walk_up_for_loader` in
  the hook DLL (v0.4n-housekeeping-6). Env var still wins for operator overrides.

### 2c. `quick-start.bat` + `KillQQ.bat` + `build-injector.ps1`

Windows-shell automation. Each gets a sibling `.sh`:
- `quick-start.bat` → `quick-start.sh`
- `KillQQ.bat` → `KillQQ.sh` (one-liner: `pkill -f /opt/QQ/qq`)
- `build-injector.ps1` → `build-injector.sh` (no Chinese-path workaround
  needed — Linux toolchains don't choke on UTF-8 paths.)

### 2d. Nothing else needs changing in theory

Everything in `packages/` is plain TS/Node — no `path.win32`, no `cmd.exe`
spawn, no `process.platform === 'win32'` branches that aren't already
defensive. `ffmpeg-static` ships Linux x64 binaries. `silk-wasm` is pure
WASM. Hono / @hono/node-server / ws all cross-platform.

**One real concern**: `image-upload.ts` writes to NT cache paths like
`<Documents>/Tencent Files/<uin>/nt_qq/nt_data/Pic/...`. On Linux these are
under `~/.config/QQ/nt_qq/...` or similar. We get the path from NT
(`msgService.getRichMediaFilePathForGuild`), so as long as that returns the
right Linux path, our `fs.copyFile` to it should work.

---

## 3. QQ for Linux landscape

### Distributions

- Official `.deb` and `.rpm` available from `im.qq.com/linuxqq/`.
- AppImage flavor too (less common; harder to inject into because it
  self-extracts into a private tmpdir per launch).
- Most users run the .deb on Ubuntu / Debian / Mint. Recommend targeting
  .deb-installed layout first, document AppImage as a separate path.

### Install layout (assumed; verify on first port attempt)

| Path | Windows equivalent |
|---|---|
| `/opt/QQ/qq` | `C:\Program Files\Tencent\QQNT\QQ.exe` |
| `/opt/QQ/resources/app/` | `<install>\versions\<ver>\resources\app\` |
| `/opt/QQ/resources/app/wrapper.node` | same filename — Node native module |
| `/opt/QQ/resources/app/application.asar` | same |
| `/opt/QQ/resources/app/application.json` | same — the RSA signatures table |
| `/opt/QQ/libQQNT.so` (?) | `versions\<ver>\QQNT.dll` |
| `/usr/share/applications/qq.desktop` | Start menu shortcut |
| `~/.config/QQ/` | `<Documents>\Tencent Files\<uin>\nt_qq\` (per-user data) |

The renamed-Node-runtime question is the big one. On Windows QQ ships
`QQNT.dll` exporting `napi_*` symbols. On Linux that's either:
- **(a)** `libQQNT.so` similarly renamed and dynamically linked, OR
- **(b)** Node statically linked into the QQ binary (more common on Linux
  Electron builds), in which case `napi_create_object` is a non-exported
  symbol inside `qq` itself and we'd need to find it via `dlsym(RTLD_DEFAULT, ...)`
  or by scanning the binary's symtab.

**Action for the porter:** the first 30 minutes of work is `ldd /opt/QQ/qq`
and `objdump -T /opt/QQ/qq | grep napi_` to determine which world we're in.

### Electron / Node versions

QQ for Linux's Electron version may differ from Windows by a minor. As long as
it's Electron 28+ / Node 22+, our bridge runs unchanged (we use only built-in
APIs + ESM + hono). Older Electron would break ESM dynamic-import path
resolution.

### Sign verification

Almost certainly present and architecturally identical to fact #1. Treat as
true and stay injection-only until disproven.

---

## 4. Injection strategies

Three real options. Recommendation: **A (LD_PRELOAD)** for v1, **B (ptrace)**
later if A's "must launch via wrapper script" UX becomes annoying.

### A. `LD_PRELOAD` (recommended for v1)

Set `LD_PRELOAD=/path/to/libqanyicat_hook.so` in QQ's environment before
exec'ing the QQ binary. The dynamic linker loads our `.so` before any of QQ's
own dependencies; our `__attribute__((constructor))` (or Rust `#[ctor]`) fires
before `main`, at which point we hook `napi_create_object` via PLT/GOT
overwrite or by calling `dlsym(RTLD_NEXT, "napi_create_object")` and using
an inline-hook crate.

**Pros:**
- No process-launch dance — just `LD_PRELOAD=… exec /opt/QQ/qq`.
- No special privileges.
- Standard, well-supported, debuggable.
- Maps cleanly to `qanyicat-launcher.exe`'s role today: build the env, exec.

**Cons:**
- User can't double-click the QQ desktop icon and get the bot. They must
  launch via `quick-start.sh` (or we install a wrapper at
  `/usr/local/bin/qq-with-qanyicat` they can pin to the dock).
- Doesn't work against an already-running QQ — has to be a fresh launch.
  Same limitation as Windows today (`quick-start.bat` kills + relaunches QQ
  every run anyway), so no real loss.
- LD_PRELOAD is sometimes disabled for setuid binaries. QQ isn't setuid so
  this doesn't apply.

**Hooking inside `LD_PRELOAD`:**
- If `napi_create_object` is an exported dynamic symbol (case 3a above),
  `dlsym(RTLD_NEXT, "napi_create_object")` returns the real one and we
  define our own at file scope — the dynamic linker will resolve QQ's call
  sites to OUR symbol first because of LD_PRELOAD's interposition rules.
- If it's statically linked (case 3b), we need inline hooking. Crates:
  - **`frida-gum-rs`** — cross-platform, the obvious replacement for
    `retour`. ~5 MB binary footprint.
  - **`subhook`** — much smaller, x86/x64 only, simpler API.
  - **hand-rolled PLT/GOT patcher** — ~100 lines, zero deps, but more risk.

  Recommend `frida-gum-rs` — mature, widely used for exactly this kind of
  inline hooking, feature-complete, and we can wrap it behind a thin trait so
  the Windows side stays on `retour`.

### B. `ptrace`-based injection (forklift Windows architecture)

A direct port of the current Windows launcher: spawn QQ (or attach), use
`ptrace(PTRACE_ATTACH)`, allocate memory in the remote process via
`mmap` syscall (injected by `ptrace(PTRACE_POKEDATA)` + register setup),
write the .so path, `ptrace`-call `__libc_dlopen_mode` (or `dlopen`), detach.

**Pros:**
- Architecturally symmetric with Windows (same `CreateRemoteThread`-ish flow).
- Can target an already-running QQ.

**Cons:**
- 5-10× more code than LD_PRELOAD path.
- Yama LSM on modern distros (`/proc/sys/kernel/yama/ptrace_scope = 1`)
  prevents ptrace except parent-child or with `CAP_SYS_PTRACE`. Means the
  launcher either needs to fork-exec QQ as its child, or run as root, or
  the user has to `echo 0 > /proc/sys/kernel/yama/ptrace_scope`. All three
  options have terrible UX.
- glibc has been moving target symbols around (`__libc_dlopen_mode` got
  renamed in glibc 2.34). Brittle.

Defer.

### C. Pre-loaded native module via QQ's Node `require`

Modify `NODE_PATH` so QQ's `require('wrapper.node')` finds our shim instead.
The shim would dlopen the real `wrapper.node` and instrument it.

**Pros:**
- No native injection at all; we're just adding a JS shim.

**Cons:**
- The signature verification (fact #1) probably includes the require path
  too. If `application.asar` hardcodes `require('./wrapper.node')` (relative),
  NODE_PATH won't redirect it. If it uses an absolute path, we can't shim it.
- Even if it works, requires figuring out QQ's exact require call sites.
- More fragile than A or B because it depends on QQ's internals not changing.

Defer. Useful only as a fallback if A and B both turn out to be blocked.

### Decision matrix

| Criterion | A. LD_PRELOAD | B. ptrace | C. Node shim |
|---|---|---|---|
| Implementation effort | **low** (1-2 days) | high (1 week) | medium (3-4 days) |
| Code volume | ~200 lines Rust | ~600 lines Rust | ~100 lines JS + config |
| Privileges needed | none | yama=0 OR root | none |
| Works on already-running QQ | no | yes | no |
| Survives QQ update | yes | yes (until glibc breaks) | brittle (NODE_PATH semantics) |
| Cross-distro robustness | high | medium | low |

---

## 5. `inject` crate refactor

Goal: keep the Windows code working, add a Linux backend, share the parts
that don't care about the OS.

### Proposed module layout

```
tools/qanyicat-injector/
├── qanyicat-launcher/
│   └── src/
│       ├── main.rs            # CLI parsing (already cross-platform)
│       ├── platform/
│       │   ├── mod.rs         # trait Platform { fn launch(...); fn resolve_qq() }
│       │   ├── windows.rs     # current CreateProcessW + reg query
│       │   └── linux.rs       # LD_PRELOAD + execv
│       └── lib.rs             # re-exports
├── qanyicat-hook/
│   └── src/
│       ├── lib.rs             # platform-agnostic entry: bootstrap() + run_loader_script()
│       ├── platform/
│       │   ├── mod.rs         # trait Hooks { fn install_napi_create_object_hook(...) }
│       │   ├── windows.rs     # retour-based static_detour, current code
│       │   └── linux.rs       # frida-gum-rs OR dlsym(RTLD_NEXT) interposition
│       └── loader.rs          # napi_run_script bookkeeping (already cross-platform)
└── shared/
    └── src/
        └── lib.rs             # path resolution, hex-md5 utils, … (TBD if needed)
```

### Cargo features for conditional compilation

```toml
# qanyicat-launcher/Cargo.toml
[target.'cfg(windows)'.dependencies]
windows = { workspace = true }

[target.'cfg(unix)'.dependencies]
nix = { version = "0.30" }       # for execvp + setenv ergonomics

# qanyicat-hook/Cargo.toml
[target.'cfg(windows)'.dependencies]
windows = { workspace = true }
retour = { version = "0.3", features = ["static-detour"] }

[target.'cfg(unix)'.dependencies]
frida-gum = "0.13"               # or whatever pins to current frida-core
libc = "0.2"
ctor = "0.4"                     # for __attribute__((constructor))
```

The `[target.'cfg(...)']` blocks let us drop platform-specific deps; the
remaining workspace deps are os-agnostic.

### Trait sketch (launcher)

```rust
// platform/mod.rs
pub trait Platform {
    /// Find QQ.exe / qq via the OS-native install registry.
    fn resolve_qq() -> Result<PathBuf, String>;

    /// Launch QQ with our hook mapped in. Returns the PID once it's running.
    fn launch(qq: &Path, hook: &Path, args: &[String], verbose: bool) -> Result<u32, String>;
}

#[cfg(windows)]  pub use self::windows::WindowsPlatform as Current;
#[cfg(unix)]     pub use self::linux::LinuxPlatform as Current;
```

`linux.rs::launch` is then:

```rust
fn launch(qq: &Path, hook: &Path, args: &[String], _verbose: bool) -> Result<u32, String> {
    use nix::unistd::{execvp, fork, ForkResult};
    use std::ffi::CString;
    use std::os::unix::process::CommandExt;
    use std::env;
    env::set_var("LD_PRELOAD", hook);
    // Optional: env::set_var("QANYICAT_BRIDGE_PATH", ...)
    let mut cmd = std::process::Command::new(qq);
    cmd.args(args);
    let child = cmd.spawn().map_err(|e| format!("spawn: {e}"))?;
    Ok(child.id())
}
```

`linux.rs::resolve_qq` checks a fixed list:
```
/opt/QQ/qq
/usr/bin/qq
/usr/local/bin/qq
/snap/bin/qq
```

…and returns the first one that exists, mirroring the Windows registry probe
with stat() checks. Could also read `~/.local/share/applications/qq.desktop`
for non-standard installs.

### Trait sketch (hook)

```rust
// platform/mod.rs
pub trait Hooks {
    /// Install an inline hook on whatever the platform calls `napi_create_object`.
    /// `callback` receives the captured napi_env on first fire.
    fn install_napi_capture(callback: Box<dyn Fn(*mut c_void) + Send + Sync>) -> Result<(), String>;
}
```

Linux impl is roughly:

```rust
#[ctor::ctor]
fn linux_init() {
    std::thread::spawn(|| {
        if let Err(e) = install_napi_capture(Box::new(|env| run_loader_script(env))) {
            eprintln!("[qanyicat-hook] {e}");
        }
    });
}

fn install_napi_capture(cb: ...) -> Result<(), String> {
    // Case A: napi_create_object is exported dynamically → use frida-gum
    // Case B: it's static — extract from QQ binary's symtab, then patch
    // For v1 we attempt Case A first and fall back to B with a clear log.
    ...
}
```

### Build commands

```bash
# replaces build-injector.ps1
./build-injector.sh
# wraps:
cargo build --release \
  --target x86_64-unknown-linux-gnu \
  --manifest-path tools/qanyicat-injector/Cargo.toml
cp tools/qanyicat-injector/target/release/qanyicat-launcher tools/qanyicat-injector/target/release/qanyicat-launcher
cp tools/qanyicat-injector/target/release/libqanyicat_hook.so tools/qanyicat-injector/target/release/
```

No copy-back dance needed (no Chinese-path issue on Linux). The default
`target/` lives next to the workspace; CI / dev both just use it directly.

### Toolchain pinning

`rust-toolchain.toml` already pins nightly-2026-05-15. Linux side:
```toml
targets = ["x86_64-pc-windows-gnu", "x86_64-unknown-linux-gnu"]
```
…so a single repo checkout on a Linux machine has the right toolchain
auto-installed by rustup.

---

## 6. JS / bridge layer audit (the cheap part)

Verify before declaring no changes needed:

- [ ] `packages/inject-bridge/src/index.ts` — uses `process.cwd()`, `os.tmpdir()`,
      `path.*`. All cross-platform. No `\\` literals.
- [ ] `packages/inject-bridge/src/image-upload.ts` — calls `ffmpeg-static` via
      `spawn`. ffmpeg-static ships Linux x64 binaries. The pnpm
      `onlyBuiltDependencies: ["ffmpeg-static"]` allowlist is OS-agnostic.
- [ ] `packages/inject-bridge/src/silk-encode.ts` — silk-wasm is pure WASM,
      no native dep. ffmpeg same as above.
- [ ] `packages/inject-bridge/src/webui-passkey.ts` — file path resolution
      reads `QANYICAT_WEBUI_PASSKEY_PATH` env. Default `process.cwd() + 'qanyicat.webui.passkey.json'` works fine on Linux.
- [ ] `packages/inject-bridge/src/media-index.ts` — same pattern with
      `QANYICAT_MEDIA_INDEX_PATH`.
- [x] `tools/qq-loader/index.cjs` — **fixed in v0.4n-housekeeping-11.**
      `__filename`-relative walk-up (8-level cap) now finds
      `packages/inject-bridge/dist/index.mjs` without an env var. Mirrors
      `walk_up_for_loader` from the hook DLL (v0.4n-housekeeping-6).
      `QANYICAT_BRIDGE_PATH` env still wins as operator override; bails with
      a clear log line if neither resolves.
- [ ] All `child_process.spawn` / `fork` calls — check `{ windowsHide: true }`
      options for any harm on Linux (they're no-ops, so fine).
- [ ] No file path literals beyond the BRIDGE_PATH fallback. Verified via
      `grep -r "D:\\\\" packages/` returning empty.

Expected outcome: bridge `dist/` built on a Windows machine should run inside
Linux QQ with **zero** code changes. The platform-specific concerns are all
in the inject crate + shell scripts.

---

## 7. `quick-start.sh` sketch

```sh
#!/usr/bin/env bash
# QanYiCat quick-start (Linux) — kills QQ, clears logs, relaunches with hook.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="$PROJECT_DIR/tools/qanyicat-injector/target/release/qanyicat-launcher"
HOOK="$PROJECT_DIR/tools/qanyicat-injector/target/release/libqanyicat_hook.so"
QQ_FALLBACK="/opt/QQ/qq"
ONEBOT_PORT="${ONEBOT_PORT:-5700}"
WEBUI_PORT="${WEBUI_PORT:-5800}"

# Persistence paths (mirror the bat)
export QANYICAT_WEBUI_ENABLE=1
export QANYICAT_WEBUI_PORT="$WEBUI_PORT"
export QANYICAT_WEBUI_PASSKEY_PATH="$PROJECT_DIR/qanyicat.webui.passkey.json"
export QANYICAT_MEDIA_INDEX_PATH="$PROJECT_DIR/qanyicat.media-index.json"

# Resolve QQ via launcher (same --resolve-qq convention)
QQ_EXE=""
if [[ -x "$LAUNCHER" ]]; then
  QQ_EXE="$("$LAUNCHER" --resolve-qq 2>/dev/null || true)"
fi
[[ -z "$QQ_EXE" && -x "$QQ_FALLBACK" ]] && QQ_EXE="$QQ_FALLBACK"
[[ -z "$QQ_EXE" ]] && { echo "[X] could not find qq binary"; exit 1; }

echo "QQ:    $QQ_EXE"
echo "hook:  $HOOK"
echo "wire:  http://127.0.0.1:$ONEBOT_PORT  /  ws://127.0.0.1:5710"
echo "webui: http://127.0.0.1:$WEBUI_PORT"
echo

# Kill running QQ, clear logs
pkill -f "$QQ_EXE" 2>/dev/null || true
sleep 1
rm -f /tmp/qanyicat-hook.log /tmp/qanyicat-loader-in-qq.log

# Inject + launch (LD_PRELOAD route via the launcher)
"$LAUNCHER" "$QQ_EXE" "$HOOK" "$@" &
LAUNCHER_PID=$!

# Wait for OneBot
echo "waiting for OneBot HTTP $ONEBOT_PORT (up to 120s, QR scan may be needed)..."
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$ONEBOT_PORT/get_status" -X POST -H 'content-type: application/json' -d '{}' >/dev/null; then
    echo "OneBot up after ${i}×2s"
    xdg-open "http://127.0.0.1:$WEBUI_PORT" 2>/dev/null || true
    break
  fi
  sleep 2
  printf "."
done

echo
echo "tailing loader log (Ctrl-C exits tail; QQ keeps running):"
tail -F /tmp/qanyicat-loader-in-qq.log
```

`KillQQ.sh`:
```sh
#!/usr/bin/env bash
pkill -f /opt/QQ/qq && echo "qq stopped" || echo "(no qq running)"
```

`build-injector.sh`:
```sh
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/tools/qanyicat-injector"
cargo build --release
echo "built: target/release/qanyicat-launcher + libqanyicat_hook.so"
```

---

## 8. Open questions to resolve at port time

1. **`napi_create_object` symbol visibility.** Static-linked or dynamic? See
   §3 — first 30 minutes of porting answer this. Determines whether
   `dlsym(RTLD_NEXT, ...)` works or whether we need full inline hooking.

2. **Does Linux QQ also do RSA verification on `application.asar`?** Try
   touching a comment in one of its JS files; if QQ refuses to start,
   answer is yes. Almost certainly yes per fact #1.

3. **`wrapper.node` ABI compat.** Our v0.4d ESM dynamic-import works on
   Windows because QQ ships Electron 28 / Node 22.16. If Linux QQ ships a
   different minor we should still be fine, but a major Electron version
   shift could break things (especially ESM resolver behavior).

4. **AppImage path.** When the user launches the AppImage build, QQ's
   binary lives in `/tmp/.mount_QQ.../...` which changes per launch. Either:
   - Treat AppImage as unsupported (recommend the .deb).
   - Discover the AppImage mount path at launch time and re-resolve QQ.
   - Inject *through* the AppImage's apprun shim.

5. **NT cache path layout.** Where does NT actually put `Pic/2026-05/Ori/<md5>.jpg`
   on Linux? Likely `~/.config/QQ/nt_qq/nt_data/Pic/...` but unverified.
   Affects `image-upload.ts`'s `stage*ForSend` flow — though we trust the
   path NT returns from `getRichMediaFilePathForGuild`, so as long as that
   call works, the staging should be transparent.

6. **Yama ptrace_scope.** Not a problem for LD_PRELOAD (recommended path),
   but document it as a known blocker if anyone tries ptrace-based injection.

7. **glibc version target.** ffmpeg-static is built against a particular
   glibc minor. If a user's distro is older (e.g. CentOS 7), they may need
   to upgrade or build ffmpeg locally. Document supported glibc minimum.

8. **rust-toolchain.toml multi-target sanity.** Pinning both
   `x86_64-pc-windows-gnu` AND `x86_64-unknown-linux-gnu` doubles toolchain
   install time on first build. Acceptable but worth noting.

9. **Does `cargo test` for the launcher still pass on Linux?** The 9 unit
   tests are currently flag-parsing logic only — pure Rust, no Windows
   API calls. They should pass on Linux with no changes.

10. **The hook crate's 5 unit tests** (`walk_up_for_loader` etc.) — same
    story; pure path math, cross-platform.

---

## 9. Acceptance criteria (recap)

The Linux port lands when all of these are true on a fresh Ubuntu 24.04 + QQ
NT install:

- [ ] `cargo build --release` succeeds, produces `qanyicat-launcher` +
      `libqanyicat_hook.so`.
- [ ] `cargo test --release` in `tools/qanyicat-injector` reports the same
      14 tests green as Windows.
- [ ] `pnpm typecheck && pnpm test` green (unchanged from current CI).
- [ ] `./quick-start.sh` launches QQ, the loader log fills in within ~10s
      of login.
- [ ] `pnpm smoke` reports all 5 OB11 probes green against the live bridge.
- [ ] An external account can send a private message and `tools/echo-bot/index.mjs`
      echoes it back.
- [ ] `.github/workflows/ci.yml` gains a `rust-linux` job mirroring the
      windows-latest one but with `runs-on: ubuntu-latest`.
- [ ] `docs/linux-port-plan.md` updated with a "Status: implemented in v0.4q"
      header and the §8 questions replaced by their actual answers as
      footnotes / facts in `qanyicat_injection_facts.md`.

---

## 10. Effort estimate

For someone familiar with Rust + Linux dynamic linking + a working Linux QQ install:

| Phase | Hours |
|---|---|
| §3 reconnaissance (ldd / objdump / locate cache paths) | 1-2 |
| Fix `qq-loader BRIDGE_PATH` walk-up (Windows-too) | 0.5 |
| Refactor inject crate into `platform/` modules; Windows-side regression-test | 4-6 |
| Write Linux launcher (LD_PRELOAD env + exec) | 1 |
| Write Linux hook (frida-gum or RTLD_NEXT) + napi_run_script call | 3-5 |
| `quick-start.sh` + `KillQQ.sh` + `build-injector.sh` | 1 |
| First-light live smoke + bug bash | 3-6 |
| CI matrix expansion + docs update | 1-2 |
| **Total** | **~15-25 hours** (≈ 2-3 focused days) |

If reconnaissance reveals static-linked `napi_create_object` we add 4-6 hours
for binary scanning + offset calibration. If sign verification turns out to
intersect the inject path somehow (unlikely), all bets are off.

---

## 11. References

- Windows-side facts the Linux port should mirror or contrast against:
  `memory/qanyicat_injection_facts.md` — especially facts #1-#9 (sign
  verification, wrapper.node, QQNT.dll, napi_create_object hooking), #17
  (`getNTWrapperSession('nt_1')`), #28 (ESM dynamic-import inside QQ).
- `frida-gum-rs` docs: https://github.com/frida/frida-rust
- ctor crate: https://docs.rs/ctor
- Yama LSM: https://www.kernel.org/doc/Documentation/security/Yama.txt
