// Tiny echo bot. Connects to a running QanYiCat instance over OneBot 11
// WebSocket and replies to any message starting with "echo ".
import {
  Actions,
  MessageChain,
  QanYiCatApiClient,
  parseCommand,
  plainText,
} from '../../packages/sdk/dist/index.js';

const WS_URL = process.env.QANYICAT_WS ?? 'ws://127.0.0.1:5700';

const client = new QanYiCatApiClient({ ws: WS_URL });

client.on('meta', (e) => {
  console.log(`[meta] ${JSON.stringify(e).slice(0, 120)}`);
});

client.on('message', async (e) => {
  const msg = e.message;
  const text = plainText(msg);
  console.log(`[msg] from=${msg.sender.uin} scene=${msg.scene} text=${JSON.stringify(text)}`);

  // Skip self-sent echoes to avoid an infinite loop in memory loopback mode.
  if (msg.sender.uin === msg.selfId) return;

  const cmd = parseCommand(msg, 'echo ');
  if (!cmd) return;

  const reply = new MessageChain()
    .text(`echo: ${cmd.name}${cmd.args.length ? ' ' + cmd.args.join(' ') : ''}`)
    .build();

  const result = await client.callAction(Actions.SendMessage, {
    peer: msg.peer,
    segments: reply,
  });
  console.log(`[reply sent] message_id=${result.messageId}`);
});

console.log(`echo-bot connecting to ${WS_URL}...`);
console.log('send "echo hello world" from any OneBot 11 client to test');
