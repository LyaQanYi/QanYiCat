/** Master ↔ worker IPC envelope. */
export type WorkerMessage =
  | { type: 'restart' }
  | { type: 'shutdown' }
  | { type: 'login-success'; uin: string }
  | { type: 'login-failed'; reason: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };
