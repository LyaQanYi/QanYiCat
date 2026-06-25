# Echo Bot

Minimal demo bot using `@qanyicat/sdk`. When anyone sends a message that starts
with `echo `, the bot replies with the rest of that message. Demonstrates:

- Connecting via the SDK over OneBot 11 WebSocket
- Listening for `message` events
- Building a reply with `MessageChain`
- Calling the `send_message` action

## Run against the memory-mode server

In one terminal:

```powershell
cd ..\..
$env:QANYICAT_MEMORY_MODE = "1"
$env:QANYICAT_CONFIG_PATH = "./qanyicat.example.config.json"
node packages/app/dist/bin.mjs run --no-multi-process
```

In another:

```powershell
node examples/echo-bot/index.mjs
```

The bot prints every received message; type `echo hello world` into your
OneBot client and watch the reply come back through the memory loopback.
