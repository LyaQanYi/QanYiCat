// Memory-mode demo driver: inject a fake "from another user" message that
// the echo-bot will treat as real and reply to. Uses the
// `_debug_inject_message` action that bootstrap registers when
// QANYICAT_MEMORY_MODE=1.
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:5700');
await new Promise((r) => ws.on('open', () => r()));

const echoMap = new Map();
ws.on('message', (data) => {
  let parsed;
  try {
    parsed = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (parsed.echo && echoMap.has(parsed.echo)) {
    echoMap.get(parsed.echo)(parsed);
    echoMap.delete(parsed.echo);
  }
});

const echo = 'drive-1';
echoMap.set(echo, (resp) => {
  console.log('inject result:', JSON.stringify(resp));
});
ws.send(
  JSON.stringify({
    action: '_debug_inject_message',
    params: {
      fromUin: '20000',
      fromNickname: 'pretend-user',
      peer: { type: 'user', id: '20000' },
      segments: [{ type: 'text', data: { text: 'echo hello world' } }],
    },
    echo,
  })
);

await new Promise((r) => setTimeout(r, 600));
ws.close();
process.exit(0);
