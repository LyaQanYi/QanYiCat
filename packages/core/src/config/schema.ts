import { Type, type Static } from '@sinclair/typebox';

const ProtocolVersionSchema = Type.Union([Type.Literal('v11'), Type.Literal('v12')], { default: 'v11' });

const MessagePostFormatSchema = Type.Union(
  [Type.Literal('array'), Type.Literal('string')],
  { default: 'array' }
);

// Knobs every push-capable transport carries. Pulled out so the four adapter
// shapes below don't drift. These mirror the common OneBot 11 per-adapter
// settings (message post format, self-message reporting, heartbeat interval)
// so existing OneBot config files translate over with minimal changes.
//
// All optional in the type: missing fields fall back to defaults via
// `resolveTransportOptions` at the adapter boundary. This keeps existing
// `qanyicat.config.json` files and the inject-bridge inline default valid
// without forcing every entry to spell every knob out.
const CommonTransportKnobs = {
  messagePostFormat: Type.Optional(MessagePostFormatSchema),
  reportSelfMessage: Type.Optional(Type.Boolean({ default: false })),
  heartInterval: Type.Optional(Type.Integer({ default: 30000, minimum: 0 })),
  debug: Type.Optional(Type.Boolean()),
};

export const NetworkConfigEntrySchema = Type.Union([
  Type.Object({
    kind: Type.Literal('ws-server'),
    id: Type.String(),
    host: Type.String({ default: '127.0.0.1' }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    path: Type.Optional(Type.String()),
    accessToken: Type.Optional(Type.String()),
    protocol: ProtocolVersionSchema,
    ...CommonTransportKnobs,
  }),
  Type.Object({
    kind: Type.Literal('ws-client'),
    id: Type.String(),
    url: Type.String(),
    accessToken: Type.Optional(Type.String()),
    reconnectIntervalMs: Type.Integer({ default: 5000 }),
    protocol: ProtocolVersionSchema,
    ...CommonTransportKnobs,
  }),
  Type.Object({
    kind: Type.Literal('http-server'),
    id: Type.String(),
    host: Type.String({ default: '127.0.0.1' }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    accessToken: Type.Optional(Type.String()),
    protocol: ProtocolVersionSchema,
    ...CommonTransportKnobs,
  }),
  Type.Object({
    kind: Type.Literal('http-post'),
    id: Type.String(),
    url: Type.String(),
    secret: Type.Optional(Type.String()),
    timeoutMs: Type.Integer({ default: 5000 }),
    protocol: ProtocolVersionSchema,
    ...CommonTransportKnobs,
  }),
]);

export const QanYiCatConfigSchema = Type.Object({
  qq: Type.Object({
    execPath: Type.Optional(Type.String()),
    version: Type.Optional(Type.String()),
  }),
  log: Type.Object({
    level: Type.Union([
      Type.Literal('debug'),
      Type.Literal('info'),
      Type.Literal('warn'),
      Type.Literal('error'),
    ]),
    toFile: Type.Boolean({ default: false }),
    filePath: Type.Optional(Type.String()),
    /**
     * v0.4n-housekeeping-12: capacity of the WebUI ring buffer. Chatty bots
     * benefit from a larger window so /api/logs + /api/stream backfill catches
     * more recent activity after a reconnect. Default 500.
     * Env var `QANYICAT_RING_BUFFER_SIZE` overrides this at bridge boot time.
     */
    ringBufferSize: Type.Optional(Type.Integer({ minimum: 50, maximum: 100_000, default: 500 })),
  }),
  onebot: Type.Object({
    enable11: Type.Boolean({ default: true }),
    enable12: Type.Boolean({ default: false }),
    accessToken: Type.Optional(Type.String()),
    networks: Type.Array(NetworkConfigEntrySchema, { default: [] }),
  }),
  webui: Type.Optional(
    Type.Object({
      enable: Type.Boolean(),
      port: Type.Integer({ minimum: 1, maximum: 65535 }),
      jwtSecret: Type.Optional(Type.String()),
      password: Type.Optional(Type.String()),
    })
  ),
  process: Type.Object({
    multi: Type.Boolean({ default: true }),
    restartOnCrash: Type.Boolean({ default: true }),
  }),
});

export type QanYiCatConfig = Static<typeof QanYiCatConfigSchema>;
export type NetworkConfigEntry = Static<typeof NetworkConfigEntrySchema>;
export type ProtocolVersion = Static<typeof ProtocolVersionSchema>;
export type MessagePostFormat = Static<typeof MessagePostFormatSchema>;

/**
 * Runtime view of per-transport knobs — the protocol adapter (OB11 / OB12)
 * reads these off each `NetworkAdapter` to gate self-message emission, choose
 * the message-format-on-the-wire, and schedule per-transport heartbeats.
 */
export interface TransportRuntimeOptions {
  messagePostFormat: MessagePostFormat;
  reportSelfMessage: boolean;
  heartInterval: number;
  debug: boolean;
}
