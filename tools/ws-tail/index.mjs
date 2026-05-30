// External ws-tail — connects to the QanYiCat OneBot 11 ws-server transport
// and prints every frame the OneBotManager pushes (heartbeats, meta events,
// message events). Use this to verify the receive-direction wire from inside
// QQ.exe out to an external client.
//
// Run with:  pnpm --filter @qanyicat/onebot exec node ../../tools/ws-tail/index.mjs
// (uses the workspace `ws` install; alternative: bring your own ws dep)

import WebSocket from 'ws';

const URL = process.env.QANYICAT_WS_URL || 'ws://127.0.0.1:5710';

const ws = new WebSocket(URL);
ws.on('open', () => console.log(`[${new Date().toISOString()}] connected ${URL}`));
ws.on('close', (code, reason) => {
  console.log(`[${new Date().toISOString()}] closed code=${code} reason=${reason?.toString() || ''}`);
  process.exit(0);
});
ws.on('error', (e) => console.error(`[${new Date().toISOString()}] error: ${e.message}`));
ws.on('message', (data) => {
  const raw = data.toString();
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { console.log(`[${new Date().toISOString()}] <non-JSON> ${raw.slice(0, 200)}`); return; }
  // Compact one-line summary + full payload
  const kind = parsed.post_type ?? parsed.type ?? '?';
  const sub  = parsed.message_type ?? parsed.sub_type ?? parsed.meta_event_type ?? '';
  console.log(`[${new Date().toISOString()}] ${kind}${sub ? '/' + sub : ''}: ${JSON.stringify(parsed)}`);
});

process.on('SIGINT', () => { try { ws.close(); } catch {} process.exit(0); });
