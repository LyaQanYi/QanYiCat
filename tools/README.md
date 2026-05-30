# tools/

Standalone scripts for poking the running bridge. All are pure Node 22 + `ws`
(workspace dep already, no extra install) — drop into `node tools/<name>/...`
once `quick-start.bat` is up and the OneBot wire is on its default ports
(`5700` HTTP, `5710` WS, `5720` OB12 HTTP).

## Smoke / probes

| Script | Purpose | Env |
|---|---|---|
| `smoke/live-curl.mjs` | One-shot health check: probes 5 common OB11 actions + optional `/api/health`. Exit code = failures. | `QYC_BASE`, `QYC_ACCESS_TOKEN`, `QYC_HEALTH_BASE`, `QYC_TIMEOUT_MS` |
| `smoke-client.mjs` | SDK-driven WS round-trip against memory-mode bridge. | — |
| `smoke-ob12.mjs` | Raw OB12 wire shape verification. | — |
| `smoke-dual-stack.mjs` | OB11 + OB12 in parallel on a single bridge. | — |
| `ws-tail/index.mjs` | Tail the OB11 WS event stream in real time. | — |
| `ws-tail/ws-smoke.mjs` | WebUI `/api/stream` smoke (hello + event + log frames). | `QYC_WEBUI_TOKEN` |

Quick health check after `quick-start.bat`:
```
pnpm smoke
```

## Bot examples

| Script | What it shows | Env |
|---|---|---|
| `echo-bot/index.mjs` | WS-stream subscriber + send_msg action. Echoes every private msg (or also group with `QANYICAT_ECHO_GROUPS=1`). | `QANYICAT_WS_URL`, `QANYICAT_ACCESS_TOKEN`, `QANYICAT_ECHO_PREFIX`, `QANYICAT_ECHO_GROUPS`, `QANYICAT_RECONNECT_MS` |
| `group-archive/index.mjs` | Paginates `get_group_msg_history` (or `_friend_`) → flattens segments → markdown file. | `--group` / `--friend` / `--count` / `--batch` / `--out` / `--base` / `--token` / `--raw`. Also `QYC_BASE`, `QYC_ACCESS_TOKEN`. |
| `file-watcher/index.mjs` | Subscribes to msg.recv, archives every incoming file/image/video/voice via `get_file`/`get_image`/`get_video`/`get_record` to a local dir. | `QANYICAT_WS_URL`, `QANYICAT_HTTP_URL`, `QANYICAT_ACCESS_TOKEN`, `QANYICAT_FILES_DIR`, `QANYICAT_KINDS`, `QANYICAT_ONLY_GROUPS`, `QANYICAT_ONLY_USERS` |
| `drive-user.mjs` | Programmatic user-driver loop (legacy). | — |

## Internal tooling

| Script | Purpose |
|---|---|
| `bump-version.mjs` | Sync workspace package versions. |
| `release.mjs` | Publish helper. |
| `qanyicat-injector/` | Rust workspace producing `qanyicat-launcher.exe` + `qanyicat_hook.dll`. Build via `..\build-injector.ps1` from repo root. |
| `qq-loader/index.cjs` | The CJS loader the hook DLL injects into QQ's V8. |
| `test-fixtures/` | Saved JSON request bodies used during live-smoke verification of each milestone. |

## Common pattern (raw HTTP)

Most of the bot examples don't need the SDK — a 5-line `fetch` POST covers the
OB11 wire format:

```js
const r = await fetch('http://127.0.0.1:5700/get_status', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
const { data } = await r.json();  // { online: true, good: true }
```

Add `headers.authorization = 'Bearer <token>'` when the network adapter has
an `accessToken` configured.
