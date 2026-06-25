import { Command } from 'commander';
import { loadConfig } from '@qanyicat/core';

export function configCmd(): Command {
  const cmd = new Command('config').description('Inspect or mutate runtime config');
  cmd
    .command('show')
    .description('Print the resolved config (defaults + env overrides applied)')
    .option('-c, --config <path>', 'config file path', './qanyicat.config.json')
    .action((opts: { config: string }) => {
      const cfg = loadConfig({ path: opts.config });
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(cfg, null, 2));
    });
  return cmd;
}
