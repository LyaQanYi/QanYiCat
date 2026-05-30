// Connect to both OB11 (5700) and OB12 (5712) endpoints in parallel; verify
// that each emits its own wire format and the memory-mode loopback bounces
// the send_message echo to *both* protocols.
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const ob11 = await openProtocol('ob11', 'ws://127.0.0.1:5700', { echoStyle: 'string' });
const ob12 = await openProtocol('ob12', 'ws://127.0.0.1:5712', { echoStyle: 'uuid' });

const r11 = await ob11.call('get_login_info', {});
const r12 = await ob12.call('get_login_info', {});
console.log('OB11 get_login_info:', r11);
console.log('OB12 get_login_info:', r12);

await ob11.call('send_message', {
  peer: { type: 'user', id: '20000' },
  segments: [{ type: 'text', data: { text: 'from ob11' } }],
});
await ob12.call('send_message', {
  peer: { type: 'user', id: '20000' },
  segments: [{ type: 'text', data: { text: 'from ob12' } }],
});

await new Promise((r) => setTimeout(r, 400));

const ob11Events = ob11.events.filter((e) => e.post_type === 'message' || e.post_type === 'message_sent');
const ob12Events = ob12.events.filter((e) => e.type === 'message');
console.log('OB11 message events received:', ob11Events.length);
ob11Events.forEach((e) => console.log('  raw_message=', JSON.stringify(e.raw_message ?? '')));
console.log('OB12 message events received:', ob12Events.length);
ob12Events.forEach((e) => console.log('  alt_message=', JSON.stringify(e.alt_message ?? '')));

ob11.close();
ob12.close();
process.exit(0);

function openProtocol(label, url, opts) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const events = [];
    let counter = 0;
    ws.on('open', () => {
      resolve({
        call(action, params) {
          const echo = opts.echoStyle === 'uuid' ? randomUUID() : `${label}-${++counter}`;
          return new Promise((r) => {
            pending.set(echo, r);
            ws.send(JSON.stringify({ action, params, echo }));
          });
        },
        get events() {
          return events;
        },
        close() {
          ws.close();
        },
      });
    });
    ws.on('message', (data) => {
      let parsed;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      const isResponse =
        parsed.retcode !== undefined && parsed.type === undefined && parsed.post_type === undefined;
      if (isResponse) {
        const cb = pending.get(parsed.echo);
        if (cb) {
          pending.delete(parsed.echo);
          cb(parsed.data);
        }
        return;
      }
      events.push(parsed);
    });
  });
}
