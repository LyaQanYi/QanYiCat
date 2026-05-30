import { Command } from 'commander';

export function loginCmd(): Command {
  return new Command('login')
    .description('Quick-login by UIN (uses cached credentials when available)')
    .option('-q, --uin <uin>', 'QQ UIN to log in as')
    .action((_opts: { uin?: string }) => {
      // TODO(v0.1): wire to CoreBootstrap with explicit quick-login UIN.
      // eslint-disable-next-line no-console
      console.log('login command not implemented yet');
    });
}
