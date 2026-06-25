// qanyicat-loader.cjs — installed into QQ's resources/app/ to inject QanYiCat
// when QQ.exe starts. Replaces the original `main` entry of QQ's package.json.
//
// SAFETY CONTRACT
//   1. Any failure here MUST NOT prevent QQ from starting.
//   2. Always forward to the original main (read from package.json.qanyicat-backup)
//      so the QQ UI keeps booting normally.
//   3. Log everything to %TEMP%/qanyicat-loader.log for postmortem; if logging
//      fails too, swallow the secondary error.
//
// What we capture: the `wrapper.node` exports object the moment QQ loads it.
// That's the WrapperNodeApi shape (NodeIQQNTWrapperSession etc.). v0.1 of the
// real-NT path will use that captured object to drive Session.init.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LOG_PATH = path.join(os.tmpdir(), 'qanyicat-loader.log');

function log(line) {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch (_e) {
    // last-resort console; QQ may swallow stdout but better than nothing
    try {
      console.error('[qanyicat-loader]', line);
    } catch (_e2) {
      // truly nothing to do
    }
  }
}

log(`=== qanyicat-loader booting in PID ${process.pid} ===`);
log(`process.versions: ${JSON.stringify(process.versions)}`);
log(`__dirname: ${__dirname}`);

// Hook process.dlopen so we capture wrapper.node the moment QQ loads it.
// Re-export wrapper.node unmodified — we only observe, never modify, in v0.1.
const dlopenOrig = process.dlopen.bind(process);
let wrapperCaptured = null;
process.dlopen = function (module, filename, flags) {
  let ret;
  try {
    ret = dlopenOrig(module, filename, flags);
  } catch (err) {
    log(`dlopen FAILED for ${filename}: ${err && err.message}`);
    throw err; // cannot recover; let QQ surface the error
  }
  try {
    if (
      typeof filename === 'string' &&
      filename.toLowerCase().endsWith('wrapper.node') &&
      !wrapperCaptured
    ) {
      wrapperCaptured = module.exports;
      const keys = Object.keys(module.exports);
      log(`captured wrapper.node from ${filename}; ${keys.length} exports: ${keys.slice(0, 12).join(',')}${keys.length > 12 ? ',...' : ''}`);
      // Stash on global so the future QanYiCat worker can find it without
      // racing the load order.
      globalThis.__qanyicatWrapper = wrapperCaptured;
    }
  } catch (err) {
    log(`hook bookkeeping failed (non-fatal): ${err && err.message}`);
  }
  return ret;
};

// Forward to QQ's original main. We discover it from the backup package.json
// that `qanyicat install` wrote next to us.
function forwardToOriginalMain() {
  const backupPath = path.join(__dirname, 'package.json.qanyicat-backup');
  if (!fs.existsSync(backupPath)) {
    log(`no backup at ${backupPath}; cannot determine original main`);
    return;
  }
  let originalMain;
  try {
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    originalMain = backup.main;
  } catch (err) {
    log(`failed to read backup package.json: ${err && err.message}`);
    return;
  }
  if (!originalMain) {
    log('backup package.json has no "main" field');
    return;
  }
  log(`forwarding to original main: ${originalMain}`);
  try {
    // `__dirname` is resources/app/; original main is relative to that.
    require(path.join(__dirname, originalMain));
    log('original main require returned (sync)');
  } catch (err) {
    log(`forward FAILED: ${err && (err.stack || err.message)}`);
    throw err;
  }
}

forwardToOriginalMain();
