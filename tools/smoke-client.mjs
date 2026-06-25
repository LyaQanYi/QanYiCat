// Quick end-to-end smoke: connect via SDK, verify lifecycle + heartbeat events
// arrive, call get_login_info, send_msg into memory loopback, observe echo.
import { QanYiCatApiClient, MessageChain, Actions } from '../packages/sdk/dist/index.js';

const client = new QanYiCatApiClient({ ws: 'ws://127.0.0.1:5700' });

const events = [];
client.on('meta', (e) => events.push({ kind: 'meta', e }));
client.on('message', (e) => events.push({ kind: 'message', e }));

await new Promise((r) => setTimeout(r, 500));

const info = await client.callAction(Actions.GetLoginInfo, {});
console.log('get_login_info →', info);

const status = await client.callAction(Actions.GetStatus, {});
console.log('get_status →', status);

const send = await client.callAction(Actions.SendMessage, {
  peer: { type: 'user', id: '20000' },
  segments: new MessageChain().text('hello from smoke').build(),
});
console.log('send_message →', send);

await new Promise((r) => setTimeout(r, 300));

console.log('events received:', events.length);
for (const e of events.slice(0, 6)) {
  console.log(' -', e.kind, JSON.stringify(e.e).slice(0, 160));
}

client.close();
process.exit(0);
