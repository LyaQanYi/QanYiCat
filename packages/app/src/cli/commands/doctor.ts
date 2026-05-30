import { Command } from 'commander';
import { WrapperLoader } from '@qanyicat/core';

/**
 * `qanyicat doctor` — probe + dlopen wrapper.node, print a diagnostic table.
 *
 * Designed to run on a developer's machine before they bother wiring up a full
 * config: it confirms the QQ install path, version, and that the native
 * module is loadable. If this fails, real-mode bootstrap will too.
 */
export function doctorCmd(): Command {
  return new Command('doctor')
    .description('Probe the local QQ install and verify wrapper.node loads')
    .option('--qq-exec <path>', 'override QQ binary path (skips auto-detect)')
    .option('--qq-version <ver>', 'pin a specific QQ NT version')
    .option('--probe-only', "don't dlopen; only report resolved paths")
    .action((opts: { qqExec?: string; qqVersion?: string; probeOnly?: boolean }) => {
      const loadOpts: { execPath?: string; qqVersion?: string } = {};
      if (opts.qqExec !== undefined) loadOpts.execPath = opts.qqExec;
      if (opts.qqVersion !== undefined) loadOpts.qqVersion = opts.qqVersion;

      try {
        const install = WrapperLoader.probe(loadOpts);
        printRow('platform', process.platform);
        printRow('exec path', install.execPath);
        printRow('install root', install.installRoot);
        printRow('qq version', install.qqVersion || '<unresolved>');
        printRow('package.json version', install.packageVersion ?? '<not read>');
        printRow('quick-update config', install.fromQuickUpdateConfig ? 'yes' : 'no');
        printRow('resource dir', install.resourceDir);
        printRow('wrapper.node', install.wrapperPath);
        if (opts.probeOnly) {
          console.log('\nprobe-only: skipping dlopen.');
          return;
        }

        const { api } = WrapperLoader.load(loadOpts);
        const keys = Object.keys(api).sort();
        console.log(`\nwrapper.node loaded; ${keys.length} exported symbols:`);
        for (const k of keys.slice(0, 24)) console.log(`  - ${k}`);
        if (keys.length > 24) console.log(`  ... (${keys.length - 24} more)`);
        console.log('\nOK — QQ install is reachable. Real session.init lands in v0.2.');
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function printRow(label: string, value: string): void {
  const padded = label.padEnd(22, ' ');
  console.log(`  ${padded}${value}`);
}
