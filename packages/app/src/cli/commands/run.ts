import { Command } from 'commander';
import { ProcessManager } from '../../master/process-manager';
import { loadConfig } from '@qanyicat/core';

const DEFAULT_CONFIG_PATH = './qanyicat.config.json';

export function runCmd(): Command {
  return new Command('run')
    .description('Start QanYiCat (default command)')
    .option('-c, --config <path>', 'config file path (defaults to $QANYICAT_CONFIG_PATH or ./qanyicat.config.json)')
    .option('--no-multi-process', 'run in the foreground without a master/worker split')
    .action(async (opts: { config?: string; multiProcess: boolean }) => {
      // CLI flag > env var > built-in default. We don't put the default on
      // commander's option directly because that would overwrite a legitimate
      // QANYICAT_CONFIG_PATH set by an outer process or hook.
      const configPath = opts.config ?? process.env['QANYICAT_CONFIG_PATH'] ?? DEFAULT_CONFIG_PATH;

      if (!opts.multiProcess) {
        process.env['QANYICAT_WORKER'] = '1';
        process.env['QANYICAT_CONFIG_PATH'] = configPath;
        const { runWorker } = await import('../../worker/bootstrap');
        await runWorker();
        return;
      }
      const cfg = loadConfig({ path: configPath });
      const pm = new ProcessManager({
        restartOnCrash: cfg.process.restartOnCrash,
        configPath,
      });
      pm.start();
    });
}
