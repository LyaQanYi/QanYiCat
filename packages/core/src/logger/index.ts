import { createLogger as winstonCreate, format, transports, type Logger } from 'winston';
import { RingBufferTransport } from './ring-buffer';

export interface CreateLoggerOptions {
  label?: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  toFile?: boolean;
  filePath?: string;
  /** When supplied, log lines are also written to this in-memory ring buffer. */
  ringBuffer?: RingBufferTransport;
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const { label = 'qanyicat', level = 'info', toFile = false, filePath, ringBuffer } = opts;
  const t: import('winston').transport[] = [new transports.Console()];
  if (toFile && filePath) t.push(new transports.File({ filename: filePath }));
  if (ringBuffer) t.push(ringBuffer);
  return winstonCreate({
    level,
    format: format.combine(
      format.label({ label }),
      format.timestamp(),
      format.printf((info) => `${info['timestamp']} [${info['label']}] ${info.level}: ${info.message}`)
    ),
    transports: t,
  });
}

export type { Logger };
export { RingBufferTransport };
export type { RingBufferLogLine, RingBufferLogTransport } from './ring-buffer';
