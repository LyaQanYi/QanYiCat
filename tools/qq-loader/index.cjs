// qanyicat-loader-in-qq
//
// Loaded by qanyicat-hook.dll via `napi_run_script(...require(__filename))`
// the moment a napi_env becomes available. Runs INSIDE QQ.exe's Electron
// process; full Node access (require, fs, child_process, …).
//
// v0.4d-α — hand off to @qanyicat/inject-bridge once login + services are up.
//   The bridge ESM module is dynamically imported (from
//   packages/inject-bridge/dist/index.mjs) and given the live wrapper /
//   session / msgService / selfUid / selfUin. It owns OneBotManager from
//   then on (one http-server transport on 127.0.0.1:5700 by default).
//   The loader keeps its diagnostic listener for visibility but no longer
//   contains any OneBot wire of its own.
//
// Architecture note: QQ's app_launcher (application.asar/app_launcher/index.js)
// already drives engine.initWithDeskTopConfig + loginService.initConfig + UI.
// Driving those a second time from inside the same process would collide with
// QQ's own startup. So we attach kernel listeners passively, log everything,
// and after login completes we grab the live session via getNTWrapperSession.
//
// Safety contract: any error here MUST NOT crash QQ. Wrap everything.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// Walk up from `start` looking for `packages/inject-bridge/dist/index.mjs`.
// Caps at 8 levels — matches the Rust walk_up_for_loader pattern in
// tools/qanyicat-injector/qanyicat-hook/src/lib.rs (v0.4n-housekeeping-6).
function walkUpForBridge(start) {
  let cur = start;
  try {
    if (fs.statSync(cur).isFile()) cur = path.dirname(cur);
  } catch (_) { /* assume directory */ }
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(cur, 'packages', 'inject-bridge', 'dist', 'index.mjs');
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch (_) {}
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

// Resolve the inject-bridge ESM entrypoint. Order:
//   1. QANYICAT_BRIDGE_PATH env var (operator override)
//   2. __filename-relative walk-up to packages/inject-bridge/dist/index.mjs
// Returns null if the bridge cannot be located — caller must log and bail.
function resolveBridgePath() {
  const envOverride = process.env.QANYICAT_BRIDGE_PATH;
  if (envOverride && envOverride.length > 0) return envOverride;
  return walkUpForBridge(__filename);
}

const BRIDGE_PATH = resolveBridgePath();

const LOG_PATH = path.join(os.tmpdir(), 'qanyicat-loader-in-qq.log');

function log(line) {
  try {
    fs.appendFileSync(
      LOG_PATH,
      `${new Date().toISOString()} qanyicat-loader[pid=${process.pid}] ${line}\n`
    );
  } catch (_) {
    try { console.error('[qanyicat-loader]', line); } catch (_) {}
  }
}

function safe(label, fn) {
  try { return fn(); }
  catch (e) {
    log(`${label} threw: ${e && (e.stack || e.message) || String(e)}`);
    return undefined;
  }
}

function compactJson(v, max = 600) {
  try {
    const s = JSON.stringify(v, (_k, val) => {
      if (val instanceof Uint8Array) return `<u8[${val.length}]>`;
      if (val && typeof val === 'object' && val.constructor && val.constructor.name === 'Buffer') {
        return `<buf[${val.length}]>`;
      }
      return val;
    });
    if (!s) return String(v);
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch (e) {
    return `<unserializable: ${e && e.message}>`;
  }
}

log('=== boot (v0.4b observe-mode) ===');
log(`__filename=${__filename}`);
log(`BRIDGE_PATH=${BRIDGE_PATH || '<unresolved — bridge handoff will be skipped>'}`);
log(`cwd=${process.cwd()}`);
log(`execPath=${process.execPath}`);
log(`platform=${process.platform} arch=${process.arch}`);
log(`electron=${process.versions.electron} node=${process.versions.node} napi=${process.versions.napi}`);
log(`mainModule=${process.mainModule && process.mainModule.filename}`);
log(`argv=${JSON.stringify(process.argv)}`);

// ─── Hook process.dlopen so we capture wrapper.node load ────────────────────
safe('hook-dlopen', () => {
  if (process.dlopen.__qanyicatHooked) return;
  const origDlopen = process.dlopen.bind(process);
  process.dlopen = function hookedDlopen(module, filename) {
    const result = origDlopen(module, filename);
    try {
      if (/wrapper\.node$/i.test(filename) && !globalThis.__qanyicatWrapperExports) {
        globalThis.__qanyicatWrapperExports = module.exports;
        const ek = Object.keys(module.exports || {});
        log(`dlopen captured wrapper.node → ${ek.length} keys`);
      }
    } catch (e) {
      log(`dlopen-inspect threw: ${e && e.message}`);
    }
    return result;
  };
  process.dlopen.__qanyicatHooked = true;
});

// Already-loaded wrapper.node?
safe('locate-wrapper-now', () => {
  const cache = require.cache || {};
  for (const key of Object.keys(cache)) {
    if (/wrapper\.node$/i.test(key)) {
      const exp = cache[key] && cache[key].exports;
      if (exp) {
        globalThis.__qanyicatWrapperExports = exp;
        log(`require.cache hit: wrapper.node already loaded (${Object.keys(exp).length} keys)`);
      }
    }
  }
});

log('=== boot done ===');

// ═══════════════════════════════════════════════════════════════════════════
// Duck-type adapter / listener classes
//
// wrapper.node calls expected method names on whatever object we pass in.
// We log every callback so we can see what QQ's kernel actually emits.
// ═══════════════════════════════════════════════════════════════════════════

function listenerLogger(prefix) {
  return (...args) => {
    try {
      log(`${prefix} ← ${args.map((a) => compactJson(a, 400)).join(' | ')}`);
    } catch (e) {
      log(`${prefix} ← <log-failure ${e && e.message}>`);
    }
  };
}

// All Node*Adapter / NodeIKernel*Listener method names harvested from QQ's
// own wrapper.node at runtime. We don't need to do anything; just receive events.

class QanYiCatDependsAdapter {
  onMSFStatusChange(...a) { listenerLogger('depends.onMSFStatusChange')(...a); }
  onMSFSsoError(...a)    { listenerLogger('depends.onMSFSsoError')(...a); }
  getGroupCode(...a)     { listenerLogger('depends.getGroupCode')(...a); }
}

class QanYiCatDispatcherAdapter {
  dispatchRequest(...a)        { listenerLogger('dispatcher.dispatchRequest')(...a); }
  dispatchCall(...a)           { listenerLogger('dispatcher.dispatchCall')(...a); }
  dispatchCallWithJson(...a)   { listenerLogger('dispatcher.dispatchCallWithJson')(...a); }
}

class QanYiCatGlobalAdapter {
  onLog(...a)                  { /* too noisy to log every line */ }
  onGetSrvCalTime(...a)        { listenerLogger('global.onGetSrvCalTime')(...a); }
  onShowErrUITips(...a)        { listenerLogger('global.onShowErrUITips')(...a); }
  fixPicImgType(...a)          { listenerLogger('global.fixPicImgType')(...a); }
  getAppSetting(...a)          { listenerLogger('global.getAppSetting')(...a); }
  onInstallFinished(...a)      { listenerLogger('global.onInstallFinished')(...a); }
  onUpdateGeneralFlag(...a)    { listenerLogger('global.onUpdateGeneralFlag')(...a); }
  onGetOfflineMsg(...a)        { listenerLogger('global.onGetOfflineMsg')(...a); }
}

class QanYiCatSessionListener {
  onNTSessionCreate(...a)         { listenerLogger('session.onNTSessionCreate')(...a); }
  onGProSessionCreate(...a)       { listenerLogger('session.onGProSessionCreate')(...a); }
  onSessionInitComplete(...a)     { listenerLogger('session.onSessionInitComplete')(...a); }
  onOpentelemetryInit(...a)       { listenerLogger('session.onOpentelemetryInit')(...a); }
  onUserOnlineResult(...a)        { listenerLogger('session.onUserOnlineResult')(...a); }
  onGetSelfTinyId(...a)           { listenerLogger('session.onGetSelfTinyId')(...a); }
}

class QanYiCatLoginListener {
  onLoginConnected(...a)              { listenerLogger('login.onLoginConnected')(...a); }
  onLoginDisConnected(...a)           { listenerLogger('login.onLoginDisConnected')(...a); }
  onLoginConnecting(...a)             { listenerLogger('login.onLoginConnecting')(...a); }
  onQRCodeGetPicture(arg)             {
    const url = arg && arg.qrcodeUrl;
    log(`login.onQRCodeGetPicture qrcodeUrl=${url || '<none>'} pngLen=${arg && arg.pngBase64QrcodeData && arg.pngBase64QrcodeData.length}`);
  }
  onQRCodeLoginPollingStarted(...a)   { listenerLogger('login.onQRCodeLoginPollingStarted')(...a); }
  onQRCodeSessionUserScaned(...a)     { listenerLogger('login.onQRCodeSessionUserScaned')(...a); }
  onQRCodeLoginSucceed(arg)           {
    log(`login.onQRCodeLoginSucceed ${compactJson(arg, 600)}`);
    globalThis.__qanyicatLoginResult = arg;
    if (arg && arg.uid) globalThis.__qanyicatSelfUid = arg.uid;
    if (arg && arg.uin) globalThis.__qanyicatSelfUin = arg.uin;
  }
  onQRCodeSessionFailed(...a)         { listenerLogger('login.onQRCodeSessionFailed')(...a); }
  onLoginFailed(...a)                 { listenerLogger('login.onLoginFailed')(...a); }
  onLogoutSucceed(...a)               { listenerLogger('login.onLogoutSucceed')(...a); }
  onLogoutFailed(...a)                { listenerLogger('login.onLogoutFailed')(...a); }
  onUserLoggedIn(arg)                 { log(`login.onUserLoggedIn ${compactJson(arg, 200)}`); }
  onQRCodeSessionQuickLoginFailed(...a) { listenerLogger('login.onQRCodeSessionQuickLoginFailed')(...a); }
  onPasswordLoginFailed(...a)         { listenerLogger('login.onPasswordLoginFailed')(...a); }
  OnConfirmUnusualDeviceFailed(...a)  { listenerLogger('login.OnConfirmUnusualDeviceFailed')(...a); }
  onQQLoginNumLimited(...a)           { listenerLogger('login.onQQLoginNumLimited')(...a); }
  onLoginState(...a)                  { listenerLogger('login.onLoginState')(...a); }
  onLoginRecordUpdate(...a)           { listenerLogger('login.onLoginRecordUpdate')(...a); }
}

// Expose for repl-style debugging.
globalThis.__qanyicatClasses = {
  QanYiCatDependsAdapter,
  QanYiCatDispatcherAdapter,
  QanYiCatGlobalAdapter,
  QanYiCatSessionListener,
  QanYiCatLoginListener,
};

// ═══════════════════════════════════════════════════════════════════════════
// Wait for wrapper.node, then attach our login listener in observe mode.
// ═══════════════════════════════════════════════════════════════════════════

function attachLoginListener() {
  const wrapper = globalThis.__qanyicatWrapperExports;
  if (!wrapper) return false;
  if (globalThis.__qanyicatLoginAttached) return true;

  let loginService;
  try {
    loginService = wrapper.NodeIKernelLoginService.get();
  } catch (e) {
    log(`attachLoginListener: LoginService.get() threw: ${e && e.message}`);
    return false;
  }
  if (!loginService) return false;

  const listener = new QanYiCatLoginListener();
  try {
    const r = loginService.addKernelLoginListener(listener);
    log(`addKernelLoginListener → ${typeof r}: ${compactJson(r, 120)}`);
    globalThis.__qanyicatLoginAttached = true;
    globalThis.__qanyicatLoginService = loginService;
    return true;
  } catch (e) {
    log(`addKernelLoginListener threw: ${e && (e.stack || e.message)}`);
    return false;
  }
}

// State watcher — log changes in msfStatus, hasLoginInfo, loginList shape.
let lastWatcherSnapshot = '';
function watchState(label) {
  const wrapper = globalThis.__qanyicatWrapperExports;
  if (!wrapper) return;
  let loginService;
  try { loginService = wrapper.NodeIKernelLoginService.get(); }
  catch (e) { return; }
  if (!loginService) return;

  const snap = {
    msf: safe('getMsfStatus', () => loginService.getMsfStatus()),
    loginList: safe('getLoginList', () => {
      try {
        const r = loginService.getLoginList();
        // May be a promise or plain object — handle both.
        if (r && typeof r.then === 'function') return '<promise>';
        if (r && r.LocalLoginInfoList) {
          return r.LocalLoginInfoList.map((u) => ({ uin: u.uin, isQuickLogin: u.isQuickLogin, nickName: u.nickName }));
        }
        return r;
      } catch (e) { return `<threw: ${e && e.message}>`; }
    }),
  };
  const s = compactJson(snap, 400);
  if (s !== lastWatcherSnapshot) {
    log(`[watch:${label}] ${s}`);
    lastWatcherSnapshot = s;
  }
}

// Try several keys for the live session.
function probeLiveSession() {
  const wrapper = globalThis.__qanyicatWrapperExports;
  if (!wrapper || !wrapper.NodeIQQNTWrapperSession) return;
  if (globalThis.__qanyicatLiveSession) return; // already found
  const candidates = ['nt_1', 'nt_0', 'NT_1', 'NT_0', 'default'];
  for (const key of candidates) {
    safe(`getNTWrapperSession(${key})`, () => {
      const s = wrapper.NodeIQQNTWrapperSession.getNTWrapperSession(key);
      if (!s) return;
      let alive = '?';
      try { s.getSessionId(); alive = 'YES'; }
      catch (e) {
        alive = (e && e.message && e.message.includes('not valid')) ? 'no-impl' : `err: ${e && e.message}`;
      }
      log(`session[${key}] alive=${alive}`);
      if (alive === 'YES') {
        globalThis.__qanyicatLiveSession = s;
        globalThis.__qanyicatLiveSessionKey = key;
      }
    });
  }
}

// After we have a live session, poll for services to become available.
// session.init() is called by QQ after login → services attach lazily.
let serviceProbeCount = 0;
let lastServiceSig = '';
function probeServices() {
  const s = globalThis.__qanyicatLiveSession;
  if (!s) return;
  if (globalThis.__qanyicatMsgListenerAttached) return; // done

  serviceProbeCount++;
  const sig = {};

  const probe = (name) => safe(`s.${name}`, () => {
    const obj = s[name] && s[name].call(s);
    if (obj === undefined || obj === null) { sig[name] = String(obj); return null; }
    const protoOwn = Object.getOwnPropertyNames(Object.getPrototypeOf(obj) || {});
    sig[name] = `${typeof obj}[${protoOwn.length}m]`;
    return obj;
  });

  const msgService     = probe('getMsgService');
  const buddyService   = probe('getBuddyService');
  const groupService   = probe('getGroupService');
  const profileService = probe('getProfileService');
  const ticketService  = probe('getTicketService');

  // sessionId / accountPath — useful liveness data
  safe('s.getSessionId', () => { sig.sessionId = s.getSessionId(); });
  safe('s.getAccountPath', () => {
    // getAccountPath needs 1 arg per earlier probe; try 0 and 1
    try { sig.accountPath = s.getAccountPath(0); }
    catch (e1) {
      try { sig.accountPath = s.getAccountPath('nt_1'); }
      catch (e2) { sig.accountPath = `<err>`; }
    }
  });

  const sigStr = compactJson(sig, 600);
  if (sigStr !== lastServiceSig) {
    log(`[services tick=${serviceProbeCount}] ${sigStr}`);
    lastServiceSig = sigStr;
  }

  // If msgService is a real object with methods, attach a diagnostic listener
  // (for visibility / debugging) and hand off to @qanyicat/inject-bridge which
  // owns the actual OneBot 11 wire.
  if (msgService && typeof msgService.addKernelMsgListener === 'function') {
    safe('attach msgListener', () => {
      const msgListener = {};
      // Generic catch-all: capture every kernel callback name we know about
      const msgEvents = [
        'onAddSendMsg', 'onRecvMsg', 'onRecvMsgSvrRspTransInfo', 'onRecvSysMsg',
        'onMsgInfoListUpdate', 'onMsgInfoListAdd', 'onMsgBoxChanged',
        'onRecvOnlineFileMsg', 'onUnreadCntUpdate', 'onRecvUDCFlag',
        'onLineDev', 'onKickedOffLine', 'onLogLevelChanged',
        'onUserOnlineStatusChanged', 'onUserTabStatusChanged',
        'onUserSecQualityRes', 'onContactUnreadCntUpdate',
        'onCustomWithdrawConfigUpdate', 'onDraftUpdate',
        'onDraftPreSendUpdate', 'onEmojiDownloadComplete',
        'onEmojiResourceUpdate', 'onFeedEventUpdate',
        'onFileMsgCome', 'onFirstViewDirectMsgUpdate',
        'onFirstViewGroupGuildMapping', 'onGrabPasswordRedBag',
        'onGroupFileInfoAdd', 'onGroupFileInfoUpdate',
        'onGroupGuildUpdate', 'onGroupTransferInfoUpdate',
        'onGuildInteractiveUpdate', 'onGuildMsgAbFlagChanged',
        'onGuildNotificationAbstractUpdate', 'onHitCsRelatedEmojiResult',
        'onHitEmojiKeywordResult', 'onImportOldDbProgressUpdate',
        'onInputStatusPush', 'onKickedOffline', 'onMsgAbstractUpdate',
        'onMsgEventListUpdate', 'onMsgQRCodeStatusChanged',
        'onMsgRecall', 'onMsgSecurityNotify', 'onMsgSettingUpdate',
        'onNTMsgClientGuildAtNoticeRsp', 'onNtFirstViewMsgSyncEnd',
        'onNtMsgSyncEnd', 'onNtMsgSyncStart', 'onReadFeedEventUpdate',
        'onRecvGroupGuildFlag', 'onRichMediaDownloadComplete',
        'onRichMediaProgerssUpdate', 'onRichMediaUploadComplete',
        'onSearchGroupFileInfoUpdate', 'onSendMsgError',
        'onSysMsgNotification', 'onTempChatInfoUpdate',
        'onUnreadCntAfterFirstView', 'onUserChannelTabStatusChanged',
        'onUserOnlineStatusChanged'
      ];
      for (const ev of msgEvents) {
        msgListener[ev] = (...args) => {
          try {
            log(`msg.${ev} ← ${args.map((a) => compactJson(a, 300)).join(' | ')}`);
          } catch (e) {
            log(`msg.${ev} ← <log-failure>`);
          }
        };
      }
      const r = msgService.addKernelMsgListener(msgListener);
      log(`addKernelMsgListener(diag) → ${typeof r}: ${compactJson(r, 80)}`);
      globalThis.__qanyicatMsgService = msgService;
      globalThis.__qanyicatMsgListener = msgListener;
      globalThis.__qanyicatMsgListenerAttached = true;

      // Hand off to @qanyicat/inject-bridge.
      bootInjectBridge(msgService);
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// inject-bridge handoff — dynamic ESM import to start OneBotManager.
// ═══════════════════════════════════════════════════════════════════════════

function bootInjectBridge(msgService) {
  if (globalThis.__qanyicatBridgeBooted) return;
  if (!BRIDGE_PATH) {
    log('bridge import skipped: could not locate packages/inject-bridge/dist/index.mjs '
      + `from __filename=${__filename}. Set QANYICAT_BRIDGE_PATH to the absolute path of `
      + 'the bridge ESM module to override.');
    return;
  }
  globalThis.__qanyicatBridgeBooted = true;
  // v0.4n-housekeeping-15: switched from manual `file:///` + slash-flip to
  // Node's `pathToFileURL`. The hand-rolled version mangled Windows extended-
  // length paths (`\\?\D:\...` → `file:///?/D:/...`, missing the `D:` slashes),
  // crashing the import with ERR_INVALID_FILE_URL_PATH. NT 9.9.30 reports
  // `__filename` with the extended prefix on at least some installs.
  const url = pathToFileURL(BRIDGE_PATH).href;
  log(`bridge import: ${url}`);
  import(url).then(async (mod) => {
    if (typeof mod.bootInsideQQ !== 'function') {
      log(`bridge module loaded but bootInsideQQ is missing — keys: ${Object.keys(mod).join(',')}`);
      return;
    }
    const result = await mod.bootInsideQQ({
      wrapper:    globalThis.__qanyicatWrapperExports,
      session:    globalThis.__qanyicatLiveSession,
      msgService,
      selfUin:    globalThis.__qanyicatSelfUin || '',
      selfUid:    globalThis.__qanyicatSelfUid || '',
      qqVersion:  '9.9.29-47149',
      log: (line) => log(`bridge ${line}`),
    });
    globalThis.__qanyicatBridge = result;
    log('bridge.bootInsideQQ resolved');
  }).catch((e) => {
    log(`bridge import/boot threw: ${e && (e.stack || e.message)}`);
    globalThis.__qanyicatBridgeBooted = false; // allow retry
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Main loop: poll for wrapper → attach → tick watcher every 2s.
// ═══════════════════════════════════════════════════════════════════════════

let bootAttempts = 0;
const bootInterval = setInterval(() => {
  bootAttempts++;
  if (!globalThis.__qanyicatWrapperExports) {
    if (bootAttempts > 200) {
      log('gave up waiting for wrapper.node after 20s');
      clearInterval(bootInterval);
    }
    return;
  }
  if (!globalThis.__qanyicatLoginAttached) {
    if (attachLoginListener()) {
      log('=== loginListener attached, entering watch loop ===');
    } else if (bootAttempts > 100) {
      log('attach attempts exceeded budget, giving up');
      clearInterval(bootInterval);
      return;
    }
  }
}, 100);

setInterval(() => watchState('periodic'), 2000);
setInterval(() => {
  if (globalThis.__qanyicatLoginAttached && !globalThis.__qanyicatLiveSession) {
    probeLiveSession();
  }
}, 3000);
// Services come up after QQ calls session.init() post-login. Keep probing
// until the msg-service listener is attached.
setInterval(() => probeServices(), 2000);
