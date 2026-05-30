import type { WrapperNodeApi } from './types';
import { QQBasicInfoProbe, type QQInstallInfo } from './qq-probe';

export interface WrapperLoadOptions {
  /** Override the QQ binary path. Falls back to platform default. */
  execPath?: string;
  /** Pin a specific QQ NT version (skips versionConfig.json detection). */
  qqVersion?: string;
}

/**
 * Resolves the QQ install, loads `wrapper.node` via `process.dlopen`, and
 * returns the resulting native module's exports. The probe result is exposed
 * so callers (CoreBootstrap, the `doctor` command) can report what was found.
 */
export class WrapperLoader {
  /**
   * Path-only resolution. Useful for the `doctor` command and unit tests —
   * does not load the native module.
   */
  static probe(opts: WrapperLoadOptions = {}): QQInstallInfo {
    return QQBasicInfoProbe.probe(opts);
  }

  static load(opts: WrapperLoadOptions = {}): { api: WrapperNodeApi; install: QQInstallInfo } {
    const install = QQBasicInfoProbe.probe(opts);
    // wrapper.node has side-dependencies (ssl/protobuf/...) that the OS DLL
    // loader expects to find in QQ's install layout. Inside the real QQ
    // process this is free; from standalone Node we have to widen the search.
    WrapperLoader.augmentDllSearchPath(install);
    const nativeModule: { exports: WrapperNodeApi } = { exports: {} as WrapperNodeApi };
    try {
      process.dlopen(nativeModule, install.wrapperPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const hint = WrapperLoader.dlopenHint(msg);
      throw new Error(`[WrapperLoader] process.dlopen failed for ${install.wrapperPath}: ${msg}\n${hint}`);
    }
    return { api: nativeModule.exports, install };
  }

  private static dlopenHint(message: string): string {
    if (/self-register/i.test(message)) {
      return (
        'Hint: this is almost always a Node ABI mismatch. wrapper.node targets the\n' +
        '  Node version QQ ships (currently ~22.x). Run QanYiCat under a matching\n' +
        '  Node version — `nvm install 22 && nvm use 22` is the usual fix.\n' +
        `  (current: ${process.version})`
      );
    }
    if (/specified module could not be found/i.test(message)) {
      return (
        'Hint: side DLLs (ssl/protobuf/...) could not be resolved. Make sure the\n' +
        '  QQ install root is intact, or set QANYICAT_WRAPPER_PATH explicitly.'
      );
    }
    return 'Hint: ensure no other QQ instance is currently running.';
  }

  private static augmentDllSearchPath(install: QQInstallInfo): void {
    if (process.platform !== 'win32') return;
    const wrapperDir = install.wrapperPath.replace(/[\\/]+wrapper\.node$/i, '');
    const dirs = [wrapperDir, install.resourceDir, install.installRoot].filter(
      (d, i, a) => a.indexOf(d) === i
    );
    const existing = process.env['PATH'] ?? '';
    const sep = ';';
    const additions = dirs.filter((d) => !existing.split(sep).includes(d));
    if (additions.length > 0) {
      process.env['PATH'] = [...additions, existing].join(sep);
    }
  }
}
