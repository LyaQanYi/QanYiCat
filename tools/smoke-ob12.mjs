// OB12 wire-format smoke: connect raw ws, send a v12-style action with `id`
// echo, capture meta.connect + heartbeat-style events, observe message echo
// after send_message (which the memory loopback bounces back).
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const ws = new WebSocket('ws://127.0.0.1:5700');

const expected = new Map();
const events = [];

ws.on('open', async () => {
  await call('get_login_info', {});
  await call('get_status', {});
  await call('send_message', {
    peer: { type: 'user', id: '20000' },
    segments: [{ type: 'text', data: { text: 'ob12 hello' } }],
  });
  setTimeout(() => {
    console.log('events captured:', events.length);
    for (const e of events) {
      console.log(' -', e.type ?? e.post_type, JSON.stringify(e).slice(0, 200));
    }
    ws.close();
    process.exit(0);
  }, 400);
});

ws.on('message', (data) => {
  const parsed = JSON.parse(data.toString());
  // OB12 frames carry top-level `type`. OB11 carries `post_type`. Action
  // responses carry `retcode` (no type/post_type).
  if (parsed.retcode !== undefined && parsed.type === undefined && parsed.post_type === undefined) {
    const pending = expected.get(parsed.echo);
    if (pending) {
      expected.delete(parsed.echo);
      pending(parsed);
    }
    return;
  }
  events.push(parsed);
});

function call(action, params) {
  return new Promise((resolve) => {
    const echo = randomUUID();
    expected.set(echo, (resp) => {
      console.log(`${action} →`, JSON.stringify(resp));
      resolve(resp);
    });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}
