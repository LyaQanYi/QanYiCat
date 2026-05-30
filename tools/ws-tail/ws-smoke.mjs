import WebSocket from 'ws';

const password = 'qanyicat';
const loginR = await fetch('http://127.0.0.1:5800/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password }),
});
const { token } = await loginR.json();
console.log('login ok, token len =', token.length);

const url = `ws://127.0.0.1:5800/api/stream?token=${encodeURIComponent(token)}`;
const ws = new WebSocket(url);
const start = Date.now();
const frames = [];
ws.on('open', () => console.log('WS open after', Date.now() - start, 'ms'));
ws.on('message', (data) => {
  const frame = JSON.parse(data.toString());
  frames.push(frame);
  if (frame.type === 'hello') {
    console.log('frame: hello', JSON.stringify(frame).slice(0, 160));
  } else if (frame.type === 'log') {
    console.log('frame: log', frame.line?.label, frame.line?.level, (frame.line?.message ?? '').slice(0, 100));
  } else if (frame.type === 'event') {
    console.log('frame: event', frame.kind, JSON.stringify(frame.data).slice(0, 140));
  } else {
    console.log('frame:', frame.type, JSON.stringify(frame).slice(0, 200));
  }
});
ws.on('error', (e) => console.log('WS error:', e.message));
ws.on('close', () => console.log('WS closed; total frames =', frames.length));

// Give WS a sec to open
await new Promise((r) => setTimeout(r, 500));

// Trigger activity: create + delete a network entry → bridge logs OneBotManager reload twice
console.log('--- triggering POST + DELETE /api/config/networks ---');
const body = JSON.stringify({ kind: 'http-server', host: '127.0.0.1', port: 5798, protocol: 'v11' });
const post = await fetch('http://127.0.0.1:5800/api/config/networks', {
  method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body,
});
const postJson = await post.json();
const newId = postJson.config?.onebot?.networks?.find((n) => n.port === 5798)?.id;
console.log('  created id =', newId);
await new Promise((r) => setTimeout(r, 1500));
const del = await fetch(`http://127.0.0.1:5800/api/config/networks/${newId}`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
});
console.log('  delete status =', del.status);

// Wait for log poll cycles to fan out
await new Promise((r) => setTimeout(r, 1500));
ws.close();
await new Promise((r) => setTimeout(r, 500));
console.log('=== summary ===');
console.log('total =', frames.length);
console.log('by type =', frames.reduce((acc, f) => ((acc[f.type] = (acc[f.type] || 0) + 1), acc), {}));
