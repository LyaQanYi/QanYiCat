# QanYiCat

QQ NT 协议端，OneBot 11 / 12 双栈。从零起步、TypeScript 全栈、Rust 注入。

> **当前状态（v0.4n-housekeeping-13，2026-05-24）**：DLL 注入 → 真 QQ.exe 进程内运行 → OneBot 11/12 wire E2E 全通。消息收发、撤回、历史、多转发（id-ref + 自构造内容）、文件 / 图片 / 语音 (silk via ffmpeg+silk-wasm) / 视频 (真缩略图 via ffmpeg) 全部双向；群通知（admin set/unset + member join/leave/kick + kick_me + group_request）全覆盖；好友 / 加群请求 receive + send + accept/reject 闭环；uid↔uin 跨非好友解析；message_sent 自发事件；OB11/OB12 双线协议。**WebUI 8/9 页实化**（基础信息 / 网络配置 / 运行日志 / 接口调试 / 实时调试 / 文件管理 / 系统配置 / 关于；密码 + JWT 自动生成持久化；WS 实时事件 + 日志推送；config CRUD 热重载）。**仓库 path-portable** + **三个 on-disk 缓存跨 QQ 重启存活**（passkey / mediaIndex / uidUin）。**built-in: `pnpm smoke` 健康探测 + 三个 `tools/` 示例 bot（echo-bot WS / group-archive / file-watcher）+ `build-injector.ps1` 一键 Rust 构建 + `.github/workflows/ci.yml` + `docs/linux-port-plan.md`**。**287 个单元 + 集成测试全绿（273 JS + 14 Rust）**。详见 [memory/qanyicat_status.md](#)（项目记忆）。

## 一句话

> 启动 → 一个浏览器页面 + 一个 OneBot 11/12 wire 端口，外部 NoneBot / Koishi / Kotori 等机器人框架直接接入。

## 架构

七个 workspace 包：

| 包 | 路径 | 职责 |
| --- | --- | --- |
| `@qanyicat/core` | `packages/core` | wrapper.node 加载、Session、原生 listener/API、IoC、配置、日志 |
| `@qanyicat/protocol` | `packages/protocol` | 协议中性 UnifiedMessage/Event/Action 模型 + 归一化器 + 统一 action 注册表 |
| `@qanyicat/onebot` | `packages/onebot` | OB11/OB12 双适配器 + 4 种网络通道（ws-server/ws-client/http-server/http-post） |
| `@qanyicat/inject-bridge` | `packages/inject-bridge` | 在 QQ.exe 内动态导入运行的桥；持有 UidUinCache / MediaIndex / MsgIndex / OneBotManager 等运行时状态 |
| `@qanyicat/sdk` | `packages/sdk` | 对外发布的 NPM 客户端 SDK |
| `@qanyicat/webui` | `packages/webui` | React + Vite 管理面板 + Hono 后端（可条件编译剥离） |
| `@qanyicat/app` | `packages/app` | CLI + 多进程 master/worker，唯一可执行入口 |

数据流：

```
QQ.exe (内含 inject-bridge)
  └─ NT kernel listener ─▶ NTEventBus ─▶ CoreToUnified ─▶ OneBotManager
                                                          ├─▶ OB11Adapter ─▶ ws-server : 5710
                                                          ├─▶ OB11Adapter ─▶ http-server : 5700
                                                          └─▶ OB12Adapter ─▶ http-server : 5720
  └─ Bridge 内置 WebUI server : 5800
      └─ /api/{login,instance,config,logs,stream,wire,media,health}
```

## 快速跑通（推荐：quick-start.bat）

Windows + 已装 QQ NT 即可：

```powershell
# 一次性
pnpm install
pnpm -r build
.\build-injector.ps1     # MinGW + CARGO_TARGET_DIR=C:\qyc-cargo-target + copy-back 全包了
                         # 自动找 ..\node22\mingw64\bin / msys2 / choco / PATH 上的 MinGW
                         # -Clean / -Dev / -SkipCopy / -TargetDir / -MingwBin 可调

# 日常启动
.\quick-start.bat
```

**quick-start.bat 做的事**：
1. `launcher --resolve-qq` 走 launcher 二进制读 HKLM 注册表拿 QQ 路径（housekeeping-7 起从 bat 内联 reg query 改过来的），失败回退到 `C:\Program Files\Tencent\QQNT\QQ.exe`
2. KillQQ.bat 等价的 taskkill 清掉残留 QQ.exe 进程
3. 启 launcher.exe 注入 hook.dll 进 QQ.exe
4. 轮询 `http://127.0.0.1:5700/get_status` 直到 OneBot wire 上线（≤120s，等扫码登录）
5. 浏览器打开 `http://127.0.0.1:5800`（WebUI）
6. 同窗口 powershell `Get-Content -Wait -Tail 50` 持续滚 loader log

**停 bot 不重启全流程**：`.\KillQQ.bat`（一行 `taskkill /F /IM QQ.exe /T`）。

### quick-start.bat 设的环境变量

启动时自动注入 bridge 的几个 opt-in 路径（删 / 注释掉就退化成内存态）：

| Env | 落盘文件 | 作用 |
| --- | --- | --- |
| `QANYICAT_WEBUI_PASSKEY_PATH` | `<project>/qanyicat.webui.passkey.json` | WebUI 密码 + jwtSecret 持久化（housekeeping-2） |
| `QANYICAT_MEDIA_INDEX_PATH` | `<project>/qanyicat.media-index.json` | 图片/视频/语音/文件 lookup 表跨重启（housekeeping-9，无需 `get_*_msg_history` 重 prime） |
| `QANYICAT_UID_UIN_CACHE_PATH` | `<project>/qanyicat.uid-uin-cache.json` | uid↔uin + nick 缓存跨重启（housekeeping-12，省一轮 friend list prime） |
| `QANYICAT_RING_BUFFER_SIZE` | （未设置） | WebUI 日志 ring buffer 容量；默认 500，可调 [50, 100_000]（housekeeping-12，也可走 `config.log.ringBufferSize`） |

三个 `*.json` 都进了 `.gitignore`。

## WebUI

地址：`http://127.0.0.1:5800`。

**密码**：首次启动 bridge 自动生成 16 字节 hex password + 32 字节 jwtSecret，写到 `qanyicat.webui.passkey.json`（项目根，quick-start.bat 锁定路径）。重启读回同文件，密码稳定。

- 想换密码：关 QQ → 删该文件 → 重启
- 想 force 指定密码：set 环境变量 `QANYICAT_WEBUI_PASSWORD=…`（env 永远胜过文件且不写回）
- 想换文件路径：set `QANYICAT_WEBUI_PASSKEY_PATH=…`

### 9 个 sidebar tab

| Tab | 状态 | 说明 |
| --- | --- | --- |
| 基础信息 | ✅ | UIN / 昵称 / 在线状态 / QQ 版本 + CPU/内存 gauge（mock，暂无 metrics API） + 5 个 stat tile（各 kind 网络通道数） |
| 网络配置 | ✅ | filter tab 按 kind 分组 + 卡片网格 + 新建/编辑/删除 modal；保存即热重载 OneBotManager（POST 加 → 端口立即开，DELETE → 端口立即关） |
| 运行日志 | ✅ | 实时 / 历史 segmented；level 多选 chip；终端式 viewer + tag 着色 + autoscroll + 下载 .log + pause/clear |
| 接口调试 | ✅ | OB11/12 action 输入 + 30 个 preset + JSON params 编辑器 + echo 字段 + 复制 curl + 10 条 localStorage 历史 + 响应面板（elapsed ms 徽章） |
| 实时调试 | ✅ | NT 事件 firehose；kind 多选 chip + 行可展开看完整 JSON + 下载 NDJSON + 300 条 cap |
| 文件管理 | ✅ | 浏览 MediaIndex 的图片 / 视频 / 语音 / 文件；kind 过滤 + 卡片网格 + 获取 file:// URL（走 /api/wire） + 复制路径 |
| 系统配置 | ✅ | 主题（亮/暗）/ 密度（紧凑/舒适/宽松）/ 强调色（5 个）切换；runtime stats；passkey 说明 |
| 关于我们 | ✅ | 项目简介 + 特性 + 资源 + 技术栈 |
| 系统终端 | ⏸ | 占位，安全考虑暂不实现 |

### 后端 endpoint

| 路径 | 鉴权 | 用途 |
| --- | --- | --- |
| `POST /api/login` | 公开 | `{password}` → `{token, expiresAt}` |
| `GET /api/health` | **公开** | `{status, uin, online, uptimeSec, qqVersion, startedAt}` — docker/监控用，零敏感泄漏 |
| `GET /api/instance` | JWT | UIN / 昵称 / 在线状态 / QQ 版本 / 运行时长 |
| `GET /api/config` | JWT | 完整 sanitized config（含网络通道 + 每条 per-adapter knob） |
| `PUT /api/config/onebot` | JWT | 改 enable11/12 + accessToken；触发热重载 |
| `POST /api/config/networks` | JWT | 加一条 adapter；触发热重载 |
| `PUT /api/config/networks/:id` | JWT | 改一条；触发热重载 |
| `DELETE /api/config/networks/:id` | JWT | 删一条；触发热重载 |
| `POST /api/config/export` | JWT | 把当前内存配置写到磁盘 |
| `GET /api/logs?since=ms` | JWT | 500 条 ring-buffer 日志 |
| `GET /api/stream` | JWT (querystring `?token=…`) | WebSocket 实时推送 `hello` / `event` / `log` 帧 |
| `POST /api/wire/:action?protocol=v11\|v12` | JWT | in-process 调用 OneBot action（绕过 HTTP 端口，走 `OneBotManager.invokeAction`） |
| `GET /api/media` | JWT | MediaIndex 浏览（文件管理页用） |

### 设计系统

CSS 落在 [packages/webui/frontend/src/design.css](packages/webui/frontend/src/design.css)，由 Claude Design 的设计稿（[tools/design-spec/qanyicat/](tools/design-spec/qanyicat/)）逐字搬运 + 适配。OKLCH 主题 token、密度三档、Anthropic Sans + JetBrains Mono 字体栈、iOS 风开关、终端式 log viewer、modal scrim+pop。

## 内存模式（无 QQ 跑通）

调试 wire 层 / 对接 NoneBot 等框架可以不开 QQ：

```powershell
pnpm -r build
copy qanyicat.example.config.json qanyicat.config.json
$env:QANYICAT_MEMORY_MODE = "1"
$env:QANYICAT_MEMORY_UIN = "10000"
node packages/app/dist/bin.mjs run --no-multi-process
```

- `ws://127.0.0.1:5700` 接受标准 OneBot 11 正向 WebSocket
- `lifecycle.connect` meta + 每 30 秒 `heartbeat`
- `get_login_info` / `get_status` / `get_version_info` 立即返真实数据
- `send_msg` 走内存回环：发出的消息会被原样作为 `message` 事件回推

实现完成的动作请见 [packages/protocol/src/actions/](packages/protocol/src/actions/)。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test        # 16 core + 31 protocol + 92 onebot + 40 webui-backend + 94 inject-bridge = 273 JS
                 # (+ 14 Rust = 287 total; Rust 单独 cargo test --release in tools/qanyicat-injector)
pnpm -r build    # 全 7 包 dist 同步；改 onebot/webui-backend 必须重 build dist 才能让 QQ 内 bridge 拿到
pnpm smoke       # bridge 起来后跑一遍 get_status / get_login_info / get_version_info / get_friend_list / get_group_list
                 # 失败数即 exit code；QYC_BASE / QYC_ACCESS_TOKEN / QYC_HEALTH_BASE 可调
```

### CI

`.github/workflows/ci.yml` 两个并行 job：
- **js** (ubuntu): pnpm install --frozen-lockfile --ignore-scripts → typecheck → test → build
- **rust** (windows-latest): MinGW 加 PATH → Swatinem/rust-cache → `cargo test --release` + `cargo build --release` → 上传 launcher.exe + hook.dll 作 14 天 artifact

`--ignore-scripts` 是有意：ffmpeg-static 的 postinstall CDN 时常 502（fact #66），而那个 binary 只在 QQ 内 silk 路径用，vite 已经 externalize 了，所以 build 不需要它落地。

剥离 WebUI 编译：

```bash
pnpm run build:no-webui
```

**关键 dev 流程提示**（吃过亏，写在这里）：

> bridge 在 QQ.exe 里跑，它通过 pnpm 符号链接读 `@qanyicat/onebot` / `@qanyicat/webui-backend` 的 **dist**（不是 src）。改了那两个包的源码后必须重 build 它们的 dist + 重启 QQ，否则 `pnpm typecheck` 全绿但 live wire 行为还是旧的。详见 [memory/qanyicat_injection_facts.md](#) 事实 #74。

## doctor：检查 QQ 安装

`qanyicat doctor` 不进入 Session，只完成「探测 + dlopen」并打印诊断信息：

```powershell
node packages/app/dist/bin.mjs doctor              # 全量：探测 + 加载 + 列出 native 导出
node packages/app/dist/bin.mjs doctor --probe-only # 只探测路径，不加载 wrapper.node
node packages/app/dist/bin.mjs doctor --qq-exec "D:\Custom\QQ.exe"
```

**Node 版本要求**：`wrapper.node` 是为 QQ 内嵌的 Electron Node 编译的 NAPI 模块（NODE_MODULE_VERSION 与主线 Node 22 不同）。独立 Node 进程**无论什么版本都加载不了** —— `qanyicat doctor` 的 dlopen 步骤注定失败，仅 probe 路径 + 报告版本能用。真接 QQ 必须走注入路径。

## 走进 QQ —— native 注入器

QQ 启动期对 `application.asar` / `wrapper.node` / `major.node` / `package.json` 做 RSA 签名校验，改动任何一个都会让 QQ 静默退出。所以 QanYiCat 不碰安装文件：**注入 DLL 进 QQ.exe 自己的进程**，借 QQ 的 Electron Node 加载 wrapper.node。

实现在 [tools/qanyicat-injector/](tools/qanyicat-injector/)，纯 Rust，含两个二进制：
- `qanyicat-launcher.exe` —— `CreateProcess SUSPENDED` + `CreateRemoteThread(LoadLibraryW)` 注入
- `qanyicat_hook.dll` —— 被加载进 QQ.exe，hook `QQNT.dll!napi_create_object` 拿 `napi_env`

完整链路：
1. `quick-start.bat` 调 launcher 启 QQ
2. launcher 注入 hook DLL
3. DLL hook `napi_create_object` 拿到 `napi_env` → `napi_run_script` 把 [`tools/qq-loader/index.cjs`](tools/qq-loader/index.cjs) `require()` 进 QQ
4. loader hook `process.dlopen` 捕获 wrapper.node 的 85 个服务
5. loader 等 `session.init()` 完成（`getSessionId() !== "0"`），然后动态 `import('file:///…/packages/inject-bridge/dist/index.mjs')` 启 bridge
6. bridge 启 OneBotManager + 可选 WebUI

详见 [tools/qanyicat-injector/README.md](tools/qanyicat-injector/README.md) + [memory/qanyicat_injection_facts.md](#)。

## v0.4 里程碑（注入跑起来之后）

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| v0.4b | `getNTWrapperSession('nt_1')` 观察 QQ 自起的 session（不重复 init） | ✅ |
| v0.4c-α/β | `msgService.sendMsg` 真发文本 + 注入内 hono HTTP 外部 curl E2E | ✅ |
| v0.4d-α/β/γ | inject-bridge 在 QQ.exe 内启 OneBotManager + ws-server + OB11 wire-params adapter | ✅ |
| v0.4e-α/β/γ + g | uid↔uin 缓存 + CQ-code 解析 + NTApis 全实现 + 昵称 enrich | ✅ |
| v0.4f-α/β | `message_sent` 自发事件 + OB12 双线全套 | ✅ |
| v0.4h-α…ζ | 图片(本地路径/URL/base64) + 文件 + 语音(silk via ffmpeg+silk-wasm) + 视频(真缩略图 via ffmpeg) + WebP/BMP/GIF 维度探测 | ✅ |
| v0.4i-α/β | `recall_message` + `get_msg` + `get_*_msg_history` | ✅ |
| v0.4j-α/β-1/γ/δ/ε | 撤回 notice + 好友请求 receive + 群成员/管理通知 + sysmsg protobuf 解码 + `kick_me` 区分 + **phantom-recall fix** (msgType=5 AND subMsgType=4) | ✅ |
| v0.4k + verify | 好友请求 SEND `addBuddyService.addBuddy` shape | ✅ shape verified（投递受 Tencent 服务端账号风控影响） |
| v0.4o | `set_friend_add_request` / `set_group_add_request` 闭环 | ✅ |
| v0.4m-α/polish/β-content | 多转发：id-ref + 自构造内容（Option C，per-line sender override 需要 Packet 层） | ✅ |
| v0.4n-α/β/γ | 媒体接收下载 URL：getVideoPlayUrlV2 + 本地 cache 路径 + 内联文件下载 + **triggerType=0 绕频控** | ✅ |
| v0.4p | per-adapter knob 扩展（messagePostFormat / reportSelfMessage / heartInterval / debug） + WebUI config CRUD 热重载 + WS `/api/stream` | ✅ live-smoke green |
| v0.4p-design | Claude Design 设计稿落地：OKLCH 主题 + 8 个 page + theme/density/accent hook | ✅ |
| v0.4n-housekeeping-{1,2,3,4} | KillQQ.bat + image-dim 测试 + WebUI passkey 持久化 + 实时调试页 + 接口调试页 + 系统配置页 + 文件管理页 + /api/health | ✅ live-smoke green |
| v0.4n-housekeeping-{5,6} | 顶层 README 同步 + launcher CLI（`--help` / `--version` / `--resolve-qq` / `--verbose`） + hook.dll loader.cjs DLL-relative walk-up（删硬编码路径） | ✅ |
| v0.4n-housekeeping-7 | A. DX/build flow: `build-injector.ps1` + `quick-start.bat` 改走 `launcher --resolve-qq` + `.github/workflows/ci.yml` | ✅ |
| v0.4n-housekeeping-8 | B. Tests: `OneBotManager.invokeAction` 直测 + bridge↔webui memory-mode 集成 + `pnpm smoke` 脚本 | ✅ |
| v0.4n-housekeeping-9 | C. Known-issue: silk duration 改 PCM-bytes（fact #75 FIXED） + friend.list primeNicks 失败 warn log + **MediaIndex 文件持久化** | ✅ |
| v0.4n-housekeeping-10 | D. Examples: echo-bot 改 WS-stream + group-archive (msg_history → markdown) + file-watcher (msg.recv → get_<media> → 落盘) + `tools/README.md` | ✅ |
| v0.4n-housekeeping-11 | qq-loader BRIDGE_PATH `__filename` 走 walk-up（接 housekeeping-6 的 DLL 路径解析） | ✅ |
| v0.4n-housekeeping-12 | F. Performance: **UidUinCache 文件持久化** + `log.ringBufferSize` 可配（schema + env） + WS server backpressure 观察日志（>1MB bufferedAmount warn，per-client 30s rate-limit） | ✅ |
| v0.4n-housekeeping-13 | WS backpressure observer 单测（housekeeping-12 遗留 +6 tests in onebot pkg） + 顶层 README 同步到 housekeeping-12 | ✅ |
| E. design-only | [`docs/linux-port-plan.md`](docs/linux-port-plan.md) ~500 行：LD_PRELOAD + frida-gum-rs + platform trait 推荐方案、~15-25h 工作量估算 | ✅ |

**唯一 open feature**：`v0.4m-β-names` —— 多转发卡片按行 sender name override，需要 Packet 层 + 外部 sign service，重资产，default defer。

## tools/ 示例

[tools/README.md](tools/README.md) 三表索引。三个开箱即用的 bot 例子：

| 脚本 | 用途 | 环境 |
| --- | --- | --- |
| `tools/echo-bot/index.mjs` | WS 订阅 5710 → 收到私聊 / 群（QANYICAT_ECHO_GROUPS=1）→ 加 prefix 回声。auto-reconnect。 | `QANYICAT_WS_URL` / `QANYICAT_ACCESS_TOKEN` / `QANYICAT_ECHO_PREFIX` / `QANYICAT_ECHO_GROUPS` |
| `tools/group-archive/index.mjs` | 纯 fetch，分页 `get_group_msg_history` / `get_friend_msg_history`，segments 扁平化输出 markdown（按天分节 + blockquote + CQ-flatten）。`--raw` 顺便存 JSON。 | `--group` / `--friend` / `--count` / `--batch` / `--out` |
| `tools/file-watcher/index.mjs` | WS 订阅 msg.recv → 遍历 segments 找 file/image/video/record → HTTP `get_*` 拿 URL → local file 直接 copy / 远程 URL 流式下载 → `QANYICAT_FILES_DIR`。 | `QANYICAT_FILES_DIR` / `QANYICAT_KINDS` / `QANYICAT_ONLY_GROUPS` / `QANYICAT_ONLY_USERS` |

## 值得标出来的发现

写在 [memory/qanyicat_injection_facts.md](#) 项目记忆里，挑几条最反直觉的：

- **`addBuddyService.addBuddy('FriendsServiceImpl', {targetInfo:{uid:null, uin, phoneNum:null, openid:null}, reqMsg, sourceId:3001}, {})`** —— 逆向出来的能让 NT 接受调用的发好友请求 shape（arg2 必须把身份嵌在 `targetInfo` 里，扁平传会抛 `Cannot convert undefined or null to object`）。
- **NT NAPI 服务方法挂在原型链上**，`Object.keys(svc)` 永远是 `[]`；摘下来调 (`const fn = svc.method; fn()`) 会丢 `this` 抛 `Illegal invocation`。必须 `svc.method(...)` 或 `.call(svc, ...)`。
- **NT 9.9 不会服务端转码非 SILK 语音**。发 mp3 进去 NT 接受上传（fileErrCode:0），但对端点开是哑的。必须前端用 silk-wasm + ffmpeg 提前编。
- **NT 把"自己被踢"等事件经 `onRecvSysMsg(byteArray)`（裸 protobuf）下发**，typed listener 不覆盖；contentHead.type 33/34/44 是群成员/管理变动判别码。[`packages/inject-bridge/src/sysmsg-decode.ts`](packages/inject-bridge/src/sysmsg-decode.ts) 实现了解码。
- **非好友 uid 解析要走多步 fallback 链**：先试 `uixConvertService.getUin([uid])`（覆盖陌生人），再 profileService。仅 profileService 对非群友返回 `'0'`。
- **NT `onMsgInfoListUpdate` msgType=5 不止表示撤回**。还有非撤回的 delivery-state 更新（multi-forward 完成后 6–14s 触发）。必须 gate `msgType=5 AND subMsgType=4` 才是真撤回 —— 否则会触发幻象 group_recall。

详见 v0.4 fact 表（集中在 [memory/qanyicat_injection_facts.md](#)）。
