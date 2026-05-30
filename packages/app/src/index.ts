import { buildCli } from './cli/parser';

export async function main(argv: string[]): Promise<void> {
  if (process.env['QANYICAT_WORKER'] === '1') {
    const { runWorker } = await import('./worker/bootstrap');
    await runWorker();
    return;
  }
  const program = buildCli();
  await program.parseAsync(argv, { from: 'user' });
}

export { runWorker } from './worker/bootstrap';
export { ProcessManager } from './master/process-manager';
export type { WorkerMessage } from './master/pipe';
