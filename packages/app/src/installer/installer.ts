import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WrapperLoader } from '@qanyicat/core';
import loaderTemplate from './loader-template.cjs?raw';

/**
 * QQ install patcher: replace `package.json` `main` with our loader so that
 * QQ.exe boots through `qanyicat-loader.cjs` (which then forwards to QQ's
 * original main and gets a chance to capture `wrapper.node`).
 *
 * Files we touch under `<resourceDir>`:
 *   - package.json                       (rewritten; `main` → loader)
 *   - package.json.qanyicat-backup       (created on first install)
 *   - qanyicat-loader.cjs                (created)
 *
 * The install is idempotent: re-running install on an already-patched tree
 * refreshes the loader but never re-backs-up.
 */

const LOADER_FILENAME = 'qanyicat-loader.cjs';
const BACKUP_FILENAME = 'package.json.qanyicat-backup';
const LOADER_REL_MAIN = `./${LOADER_FILENAME}`;

export interface InstallOptions {
  /** Override the QQ binary path; otherwise auto-detected. */
  execPath?: string;
  /** Pin the QQ NT version when versionConfig.json is missing. */
  qqVersion?: string;
  /** When true, write the changes. When false, only describe. */
  apply: boolean;
}

export interface InstallReport {
  resourceDir: string;
  packageJsonPath: string;
  loaderPath: string;
  backupPath: string;
  alreadyPatched: boolean;
  willCreateBackup: boolean;
  willOverwriteLoader: boolean;
  applied: boolean;
}

export interface UninstallReport {
  resourceDir: string;
  packageJsonPath: string;
  loaderPath: string;
  backupPath: string;
  hadBackup: boolean;
  hadLoader: boolean;
  removed: boolean;
}

export function planInstall(opts: InstallOptions): InstallReport {
  const { resourceDir, packageJsonPath, loaderPath, backupPath } = locate(opts);
  const pkg = readPackageJson(packageJsonPath);
  const alreadyPatched = pkg.main === LOADER_REL_MAIN;
  return {
    resourceDir,
    packageJsonPath,
    loaderPath,
    backupPath,
    alreadyPatched,
    willCreateBackup: !existsSync(backupPath),
    willOverwriteLoader: existsSync(loaderPath),
    applied: false,
  };
}

export function applyInstall(opts: InstallOptions): InstallReport {
  const report = planInstall(opts);
  if (!opts.apply) return report;

  // Backup the *current* package.json only if no backup yet. The backup is the
  // source of truth for the original `main`; we don't want to overwrite it
  // with our patched version on a re-install.
  if (!existsSync(report.backupPath)) {
    copyFileSync(report.packageJsonPath, report.backupPath);
  }

  // Write loader from the embedded template.
  writeFileSync(report.loaderPath, loaderTemplate, { encoding: 'utf8' });

  // Patch package.json.main → loader. Preserve every other field byte-for-byte
  // by re-reading the on-disk JSON and only swapping `main`.
  const pkg = readPackageJson(report.packageJsonPath);
  if (pkg.main !== LOADER_REL_MAIN) {
    pkg.main = LOADER_REL_MAIN;
    writeFileSync(report.packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', { encoding: 'utf8' });
  }

  return { ...report, applied: true };
}

export function applyUninstall(opts: InstallOptions): UninstallReport {
  const { resourceDir, packageJsonPath, loaderPath, backupPath } = locate(opts);
  const hadBackup = existsSync(backupPath);
  const hadLoader = existsSync(loaderPath);

  if (!opts.apply) {
    return { resourceDir, packageJsonPath, loaderPath, backupPath, hadBackup, hadLoader, removed: false };
  }

  if (hadBackup) {
    copyFileSync(backupPath, packageJsonPath);
    rmSync(backupPath);
  }
  if (hadLoader) {
    rmSync(loaderPath);
  }

  return { resourceDir, packageJsonPath, loaderPath, backupPath, hadBackup, hadLoader, removed: true };
}

function locate(opts: InstallOptions): {
  resourceDir: string;
  packageJsonPath: string;
  loaderPath: string;
  backupPath: string;
} {
  const probeOpts: { execPath?: string; qqVersion?: string } = {};
  if (opts.execPath !== undefined) probeOpts.execPath = opts.execPath;
  if (opts.qqVersion !== undefined) probeOpts.qqVersion = opts.qqVersion;
  const install = WrapperLoader.probe(probeOpts);
  // The package.json that Electron actually reads is the one alongside
  // wrapper.node — which is the resourceDir's `resources/app` if present, or
  // resourceDir itself.
  const candidates = [
    join(install.resourceDir, 'package.json'),
    join(install.resourceDir, 'resources', 'app', 'package.json'),
  ];
  const packageJsonPath = candidates.find((p) => existsSync(p));
  if (!packageJsonPath) {
    throw new Error(
      `[installer] cannot find QQ package.json under ${install.resourceDir}; tried:\n  ` +
        candidates.join('\n  ')
    );
  }
  // Anchor backup + loader next to the real package.json, not whatever the
  // probe guessed for the resource dir.
  const anchor = packageJsonPath.replace(/[\\/]package\.json$/i, '');
  return {
    resourceDir: anchor,
    packageJsonPath,
    loaderPath: join(anchor, LOADER_FILENAME),
    backupPath: join(anchor, BACKUP_FILENAME),
  };
}

interface MinimalQQPackageJson {
  main?: string;
  [k: string]: unknown;
}

function readPackageJson(p: string): MinimalQQPackageJson {
  return JSON.parse(readFileSync(p, 'utf8')) as MinimalQQPackageJson;
}
