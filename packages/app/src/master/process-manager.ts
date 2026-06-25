import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { WorkerMessage } from './pipe';

export interface ProcessManagerOptions {
  restartOnCrash: boolean;
  crashBudget?: { count: number; windowMs: number };
  configPath: string;
}

/**
 * Forks a worker process running this same binary with QANYICAT_WORKER=1.
 * Restart policy uses a sliding crash budget — give up after N crashes inside
 * a window to avoid spin loops when the wrapper.node is unloadable.
 */
export class ProcessManager {
  private child: ChildProcess | null = null;
  private crashTimestamps: number[] = [];

  constructor(private readonly opts: ProcessManagerOptions) {}

  start(): void {
    const here = dirname(fileURLToPath(import.meta.url));
    const entry = resolve(here, 'bin.mjs');
    const child = fork(entry, [], {
      env: { ...process.env, QANYICAT_WORKER: '1', QANYICAT_CONFIG_PATH: this.opts.configPath },
      stdio: 'inherit',
    });
    this.child = child;

    child.on('message', (m) => this.onWorkerMessage(m as WorkerMessage));
    child.on('exit', (code) => this.onWorkerExit(code));
  }

  private onWorkerMessage(msg: WorkerMessage): void {
    if (msg.type === 'login-success') {
      // eslint-disable-next-line no-console
      console.log(`[master] worker login-success uin=${msg.uin}`);
    }
  }

  private onWorkerExit(code: number | null): void {
    // eslint-disable-next-line no-console
    console.warn(`[master] worker exited code=${code}`);
    if (!this.opts.restartOnCrash) return;
    const now = Date.now();
    const window = this.opts.crashBudget?.windowMs ?? 10_000;
    const max = this.opts.crashBudget?.count ?? 3;
    this.crashTimestamps = this.crashTimestamps.filter((t) => now - t < window);
    this.crashTimestamps.push(now);
    if (this.crashTimestamps.length > max) {
      // eslint-disable-next-line no-console
      console.error(`[master] crash budget exhausted (${max} in ${window}ms); giving up`);
      process.exit(1);
    }
    this.start();
  }

  stop(): void {
    this.opts.restartOnCrash = false;
    this.child?.kill('SIGTERM');
  }
}
