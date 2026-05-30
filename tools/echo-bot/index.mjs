// External echo bot — connects to the QanYiCat OneBot 11 WebSocket and
// echoes every incoming private (or group) message back with a prefix.
//
// v0.4n-housekeeping-10: rewritten from the old HTTP-listener model (which
// needed the bridge to be configured with an http-post adapter forwarding
// events to this process) to a WS-stream subscriber. The default bridge
// config (set in packages/inject-bridge/src/index.ts) already exposes
// ws://127.0.0.1:5710 — so this example now works out of the box without
// editing qanyicat.config.json.
//
// Run:
//   node tools/echo-bot/index.mjs                       # private only
//   QANYICAT_ECHO_GROUPS=1 node tools/echo-bot/index.mjs # also echo group msgs
//
// Env:
//   QANYICAT_WS_URL          default ws://127.0.0.1:5710
//   QANYICAT_ACCESS_TOKEN    optional bearer for the WS upgrade
//   QANYICAT_ECHO_PREFIX     default "[echo-bot] "
//   QANYICAT_ECHO_GROUPS     "1" to also echo group messages (default off)
//   QANYICAT_RECONNECT_MS    reconnect backoff base (default 1000)

import WebSocket from 'ws';

const WS_URL = process.env.QANYICAT_WS_URL || 'ws://127.0.0.1:5710';
const TOKEN = process.env.QANYICAT_ACCESS_TOKEN;
const PREFIX = process.env.QANYICAT_ECHO_PREFIX ?? '[echo-bot] ';
const ECHO_GROUPS = process.env.QANYICAT_ECHO_GROUPS === '1';
const RECONNECT_MS_BASE = Number(process.env.QANYICAT_RECONNECT_MS ?? 1000);

let echoCounter = 0;

function connect() {
  const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
  const ws = new WebSocket(WS_URL, { headers });
  let backoff = RECONNECT_MS_BASE;

  ws.on('open', () => {
    backoff = RECONNECT_MS_BASE;
    log(`connected ${WS_URL}${ECHO_GROUPS ? ' (group echo enabled)' : ''}`);
  });

  ws.on('message', (data) => {
    let event;
    try { event = JSON.parse(data.toString()); }
    catch { return; }
    if (event.post_type !== 'message') return;
    if (event.message_type === 'group' && !ECHO_GROUPS) return;

    const text = (event.raw_message || '').trim();
    if (!text) return;
    if (text.startsWith(PREFIX)) return; // loop guard

    const reply = PREFIX + text;
    log(`← ${event.message_type} sender=${event.sender?.user_id ?? event.user_id} msg_id=${event.message_id} text=${JSON.stringify(text).slice(0, 80)}`);

    const params =
      event.message_type === 'group'
        ? { message_type: 'group', group_id: event.group_id, message: reply }
        : { message_type: 'private', user_id: event.user_id, message: reply };

    sendAction(ws, 'send_msg', params)
      .then((resp) => log(`→ send_msg ok message_id=${resp?.message_id ?? '?'}`))
      .catch((e) => log(`→ send_msg FAILED: ${e.message}`));
  });

  ws.on('close', () => {
    log(`disconnected; reconnecting in ${backoff}ms`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });

  ws.on('error', (e) => {
    log(`ws error: ${e.message}`);
    // 'close' fires too; reconnect happens there.
  });
}

/** Send an OB11 action over the WS and await its echo'd response. */
function sendAction(ws, action, params) {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) return reject(new Error('ws not open'));
    const echo = `echo-bot-${++echoCounter}`;
    const timer = setTimeout(() => {
      ws.removeListener('message', onMsg);
      reject(new Error('timeout waiting for response'));
    }, 5000);
    const onMsg = (raw) => {
      let r;
      try { r = JSON.parse(raw.toString()); }
      catch { return; }
      if (r.echo !== echo) return;
      clearTimeout(timer);
      ws.removeListener('message', onMsg);
      if (r.status === 'failed') {
        reject(new Error(`retcode=${r.retcode} msg=${r.message ?? ''}`));
      } else {
        resolve(r.data);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

function log(s) {
  console.log(`[${new Date().toISOString()}] ${s}`);
}

connect();
