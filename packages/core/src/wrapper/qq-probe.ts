import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Resolved QQ installation metadata. Always produced before WrapperLoader.load
 * runs — `wrapperPath` is the file dlopen will receive.
 */
export interface QQInstallInfo {
  /** Absolute path to the QQ.exe / QQ.app / QQ binary. */
  execPath: string;
  /** Directory containing the QQ binary. */
  installRoot: string;
  /** Best-effort QQ NT version, e.g. "9.9.15-30000". May be empty when probing fails. */
  qqVersion: string;
  /** Where `wrapper.node` should live. Existence guaranteed when this is set. */
  wrapperPath: string;
  /** Resource directory backing this version (`versions/<ver>` on Windows, `Resources/app` on macOS). */
  resourceDir: string;
  /** True when version came from versionConfig.json (post quick-update), false for the static default. */
  fromQuickUpdateConfig: boolean;
  /** Best-effort QQ NT app version from `<resource>/package.json` (often duplicates qqVersion). */
  packageVersion?: string;
}

export interface ProbeOptions {
  /** Explicit override (CLI flag or QANYICAT_QQ_EXEC_PATH). */
  execPath?: string;
  /** Force a version when versionConfig.json is missing or unreadable. */
  qqVersion?: string;
}

/**
 * Probe a QQ install. Resolution rules per platform:
 *   - Windows:  <install>/versions/<ver>/wrapper.node
 *   - macOS:    <QQ.app>/Contents/Resources/app/wrapper.node
 *   - Linux:    <install>/resources/app/wrapper.node
 *
 * Env `QANYICAT_WRAPPER_PATH` short-circuits the whole probe — useful when
 * users have a non-standard install layout we can't predict.
 */
export class QQBasicInfoProbe {
  static probe(opts: ProbeOptions = {}): QQInstallInfo {
    const wrapperOverride = process.env['QANYICAT_WRAPPER_PATH'];
    if (wrapperOverride && existsSync(wrapperOverride)) {
      return {
        execPath: '<override>',
        installRoot: dirname(wrapperOverride),
        qqVersion: opts.qqVersion ?? '0.0.0-override',
        wrapperPath: wrapperOverride,
        resourceDir: dirname(wrapperOverride),
        fromQuickUpdateConfig: false,
      };
    }

    const execPath = opts.execPath ?? QQBasicInfoProbe.detectExecPath();
    if (!execPath) {
      throw new Error('[QQBasicInfoProbe] QQ binary not found; set QANYICAT_QQ_EXEC_PATH or pass --qq-exec');
    }
    if (!existsSync(execPath)) {
      throw new Error(`[QQBasicInfoProbe] QQ binary not found at: ${execPath}`);
    }

    const installRoot = QQBasicInfoProbe.resolveInstallRoot(execPath);
    const versionInfo = QQBasicInfoProbe.readVersionConfig(installRoot, opts.qqVersion);
    const resourceDir = QQBasicInfoProbe.resolveResourceDir(installRoot, versionInfo.qqVersion);
    const wrapperPath = QQBasicInfoProbe.resolveWrapperPath(resourceDir, installRoot, versionInfo.qqVersion);

    if (!existsSync(wrapperPath)) {
      throw new Error(
        `[QQBasicInfoProbe] wrapper.node not found at: ${wrapperPath}\n` +
          `  installRoot=${installRoot}\n` +
          `  qqVersion=${versionInfo.qqVersion}\n` +
          `  resourceDir=${resourceDir}\n` +
          `Hint: set QANYICAT_WRAPPER_PATH to the absolute path of wrapper.node.`
      );
    }

    const pkgVersion = QQBasicInfoProbe.readPackageVersion(resourceDir);
    return {
      execPath,
      installRoot,
      qqVersion: versionInfo.qqVersion,
      wrapperPath,
      resourceDir,
      fromQuickUpdateConfig: versionInfo.fromQuickUpdateConfig,
      ...(pkgVersion !== undefined ? { packageVersion: pkgVersion } : {}),
    };
  }

  /** Search platform-default install locations; returns undefined when nothing matched. */
  static detectExecPath(): string | undefined {
    if (process.platform === 'win32') {
      const candidates = [
        process.env['ProgramFiles'] && join(process.env['ProgramFiles'], 'Tencent', 'QQNT', 'QQ.exe'),
        process.env['ProgramW6432'] && join(process.env['ProgramW6432'], 'Tencent', 'QQNT', 'QQ.exe'),
        'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
      ].filter((p): p is string => typeof p === 'string');
      return candidates.find((p) => existsSync(p));
    }
    if (process.platform === 'darwin') {
      const candidate = '/Applications/QQ.app/Contents/MacOS/QQ';
      return existsSync(candidate) ? candidate : undefined;
    }
    const linuxCandidates = ['/opt/QQ/qq', '/usr/share/linuxqq/qq', '/usr/bin/qq'];
    return linuxCandidates.find((p) => existsSync(p));
  }

  private static resolveInstallRoot(execPath: string): string {
    // On macOS, the binary lives in QQ.app/Contents/MacOS/; the install root
    // (which contains Resources/app) is the parent.
    if (process.platform === 'darwin') {
      return resolve(dirname(execPath), '..');
    }
    return dirname(execPath);
  }

  /**
   * Read versionConfig.json (post quick-update) when present, otherwise scan
   * `<install>/versions/*` for the latest directory name. Returns the version
   * we'll plug into the resource path.
   */
  private static readVersionConfig(
    installRoot: string,
    forced: string | undefined
  ): { qqVersion: string; fromQuickUpdateConfig: boolean } {
    if (forced) return { qqVersion: forced, fromQuickUpdateConfig: false };

    const cfgPath = join(installRoot, 'versions', 'config.json');
    if (existsSync(cfgPath)) {
      try {
        const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as { curVersion?: string };
        if (typeof raw.curVersion === 'string' && raw.curVersion.length > 0) {
          return { qqVersion: raw.curVersion, fromQuickUpdateConfig: true };
        }
      } catch {
        // fall through to directory scan
      }
    }

    const versionsDir = join(installRoot, 'versions');
    if (existsSync(versionsDir)) {
      const entries = readdirSync(versionsDir)
        .filter((name) => {
          const stat = statSync(join(versionsDir, name), { throwIfNoEntry: false });
          return stat?.isDirectory() === true;
        })
        .sort(compareVersionsDescending);
      if (entries[0]) return { qqVersion: entries[0], fromQuickUpdateConfig: false };
    }
    return { qqVersion: '', fromQuickUpdateConfig: false };
  }

  private static resolveResourceDir(installRoot: string, qqVersion: string): string {
    if (process.platform === 'darwin') {
      return join(installRoot, 'Resources', 'app');
    }
    if (process.platform === 'linux') {
      return join(installRoot, 'resources', 'app');
    }
    if (!qqVersion) {
      // Some Windows installs ship resources at <root>/resources/app directly
      return join(installRoot, 'resources', 'app');
    }
    return join(installRoot, 'versions', qqVersion);
  }

  private static resolveWrapperPath(resourceDir: string, installRoot: string, qqVersion: string): string {
    const primary = join(resourceDir, 'wrapper.node');
    if (existsSync(primary)) return primary;

    // Nested resources/app fallback (some Windows installers)
    const nested = join(resourceDir, 'resources', 'app', 'wrapper.node');
    if (existsSync(nested)) return nested;

    // Legacy: <install>/resources/app/versions/<ver>/wrapper.node
    if (qqVersion) {
      const legacy = join(installRoot, 'resources', 'app', 'versions', qqVersion, 'wrapper.node');
      if (existsSync(legacy)) return legacy;
    }
    return primary; // return the most-likely path; caller checks existence and throws
  }

  private static readPackageVersion(resourceDir: string): string | undefined {
    const candidates = [
      join(resourceDir, 'package.json'),
      join(resourceDir, 'resources', 'app', 'package.json'),
    ];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try {
        const pkg = JSON.parse(readFileSync(p, 'utf8')) as { version?: string };
        if (typeof pkg.version === 'string') return pkg.version;
      } catch {
        // skip unreadable / non-json files
      }
    }
    return undefined;
  }
}

/** Sort version strings like "9.9.15-30000" so the newest comes first. */
function compareVersionsDescending(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return bi - ai;
  }
  return 0;
}

function parseVersion(s: string): number[] {
  return s
    .replace(/[^\d.\-]/g, '')
    .split(/[.\-]/)
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => !Number.isNaN(n));
}
