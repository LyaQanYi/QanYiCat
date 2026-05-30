import { Command } from 'commander';
import { runCmd } from './commands/run';
import { loginCmd } from './commands/login';
import { configCmd } from './commands/config';
import { doctorCmd } from './commands/doctor';
import { installCmd } from './commands/install';
import { uninstallCmd } from './commands/uninstall';

export function buildCli(): Command {
  const program = new Command();
  program
    .name('qanyicat')
    .description('QanYiCat — QQ NT protocol terminal (OneBot 11/12)')
    .version('0.0.1');

  program.addCommand(runCmd());
  program.addCommand(loginCmd());
  program.addCommand(configCmd());
  program.addCommand(doctorCmd());
  program.addCommand(installCmd());
  program.addCommand(uninstallCmd());

  // Default to `run` when invoked with no subcommand.
  program.action(() => {
    void runCmd().parseAsync([], { from: 'user' });
  });

  return program;
}
