import { Command } from 'commander';
import { applyInstall, planInstall } from '../../installer/installer';

export function installCmd(): Command {
  return new Command('install')
    .description('Patch the QQ install so QQ.exe boots into QanYiCat (writes to QQ resources/app)')
    .option('--qq-exec <path>', 'override QQ binary path (skips auto-detect)')
    .option('--qq-version <ver>', 'pin a specific QQ NT version')
    .option('--apply', 'actually write the changes; without this, prints the plan only')
    .action((opts: { qqExec?: string; qqVersion?: string; apply?: boolean }) => {
      const installerOpts: { execPath?: string; qqVersion?: string; apply: boolean } = {
        apply: opts.apply === true,
      };
      if (opts.qqExec !== undefined) installerOpts.execPath = opts.qqExec;
      if (opts.qqVersion !== undefined) installerOpts.qqVersion = opts.qqVersion;

      try {
        const report = opts.apply === true ? applyInstall(installerOpts) : planInstall(installerOpts);
        printRow('package.json', report.packageJsonPath);
        printRow('loader will be at', report.loaderPath);
        printRow('backup file', report.backupPath);
        printRow('already patched?', report.alreadyPatched ? 'yes' : 'no');
        printRow('will create backup', report.willCreateBackup ? 'yes' : 'no (already exists)');
        printRow('will overwrite loader', report.willOverwriteLoader ? 'yes' : 'no');
        if (!opts.apply) {
          console.log('\nDRY RUN. Re-run with --apply to actually patch QQ.');
          console.log('After applying: start QQ.exe, then `tail %TEMP%\\qanyicat-loader.log` to verify.');
          return;
        }
        console.log('\nINSTALLED.');
        console.log(`  - QQ.exe will now boot via ${report.loaderPath}`);
        console.log(`  - The loader logs to %TEMP%\\qanyicat-loader.log on every QQ start`);
        console.log(`  - Run \`qanyicat uninstall --apply\` to revert (restores ${report.backupPath})`);
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function printRow(label: string, value: string): void {
  console.log(`  ${label.padEnd(22, ' ')}${value}`);
}
