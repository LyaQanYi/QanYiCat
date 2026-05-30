import Transport from 'winston-transport';

export interface RingBufferLogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  timestamp: number;
  label: string;
  message: string;
}

interface WinstonRecord {
  level: string;
  message: unknown;
  label?: string;
  timestamp?: string;
  [k: string]: unknown;
}

export interface RingBufferLogTransport {
  /** Snapshot the current contents — oldest first, newest last. */
  snapshot(): RingBufferLogLine[];
  /** Snapshot only lines newer than the given timestamp (ms since epoch). */
  since(ms: number): RingBufferLogLine[];
  /** Total messages observed across the buffer's lifetime (monotonic). */
  totalSeen(): number;
}

/**
 * Fixed-size circular buffer of log lines exposed to the WebUI. Old entries
 * silently drop off the end when the buffer fills.
 */
export class RingBufferTransport extends Transport implements RingBufferLogTransport {
  private readonly buf: (RingBufferLogLine | undefined)[];
  private head = 0;
  private count = 0;
  private seen = 0;

  constructor(capacity = 500) {
    super({ level: 'debug' });
    this.buf = new Array(capacity);
  }

  override log(info: WinstonRecord, callback: () => void): void {
    const level = normalizeLevel(info.level);
    const entry: RingBufferLogLine = {
      level,
      timestamp: parseTimestamp(info.timestamp),
      label: typeof info.label === 'string' ? info.label : 'qanyicat',
      message: typeof info.message === 'string' ? info.message : safeStringify(info.message),
    };
    this.buf[this.head] = entry;
    this.head = (this.head + 1) % this.buf.length;
    if (this.count < this.buf.length) this.count++;
    this.seen++;
    callback();
  }

  snapshot(): RingBufferLogLine[] {
    const out: RingBufferLogLine[] = new Array(this.count);
    const cap = this.buf.length;
    const start = (this.head - this.count + cap) % cap;
    for (let i = 0; i < this.count; i++) {
      out[i] = this.buf[(start + i) % cap]!;
    }
    return out;
  }

  since(ms: number): RingBufferLogLine[] {
    return this.snapshot().filter((line) => line.timestamp > ms);
  }

  totalSeen(): number {
    return this.seen;
  }
}

function normalizeLevel(raw: string): RingBufferLogLine['level'] {
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
