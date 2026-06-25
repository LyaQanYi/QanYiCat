import { Command } from 'commander';
import { applyUninstall } from '../../installer/installer';

export function uninstallCmd(): Command {
  return new Command('uninstall')
    .description('Revert a previous `qanyicat install` (restore QQ package.json from backup)')
    .option('--qq-exec <path>', 'override QQ binary path (skips auto-detect)')
    .option('--qq-version <ver>', 'pin a specific QQ NT version')
    .option('--apply', 'actually revert; without this, prints the plan only')
    .action((opts: { qqExec?: string; qqVersion?: string; apply?: boolean }) => {
      const installerOpts: { execPath?: string; qqVersion?: string; apply: boolean } = {
        apply: opts.apply === true,
      };
      if (opts.qqExec !== undefined) installerOpts.execPath = opts.qqExec;
      if (opts.qqVersion !== undefined) installerOpts.qqVersion = opts.qqVersion;

      try {
        const report = applyUninstall(installerOpts);
        printRow('package.json', report.packageJsonPath);
        printRow('loader file', report.loaderPath);
        printRow('backup file', report.backupPath);
        printRow('backup present', report.hadBackup ? 'yes' : 'no');
        printRow('loader present', report.hadLoader ? 'yes' : 'no');

        if (!opts.apply) {
          if (!report.hadBackup && !report.hadLoader) {
            console.log('\nNothing to uninstall: no QanYiCat artifacts in this QQ install.');
            return;
          }
          console.log('\nDRY RUN. Re-run with --apply to actually revert.');
          return;
        }

        if (!report.hadBackup && !report.hadLoader) {
          console.log('\nNothing to remove. (Already clean.)');
          return;
        }
        console.log('\nUNINSTALLED.');
        if (report.hadBackup) console.log('  - package.json restored from backup');
        if (report.hadLoader) console.log('  - loader file removed');
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function printRow(label: string, value: string): void {
  console.log(`  ${label.padEnd(22, ' ')}${value}`);
}
