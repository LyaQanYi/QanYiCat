import type { Logger } from 'winston';
import type { QanYiCatConfig } from '../config/schema';
import type { InstanceContext } from './instance-context';
import { WrapperLoader } from '../wrapper/loader';
import type { QQInstallInfo } from '../wrapper/qq-probe';
import type { WrapperNodeApi } from '../wrapper/types';
import { createLogger } from '../logger';

export interface CoreBootstrapOptions {
  config: QanYiCatConfig;
  logger?: Logger;
}

export interface PartialBootstrapState {
  install: QQInstallInfo;
  api: WrapperNodeApi;
  logger: Logger;
}

/**
 * Materializes an {@link InstanceContext} from a real NTQQ install.
 *
 * Implementation status (v0.0.x):
 *   - [x] Probe QQ install (`installRoot`, `qqVersion`, `wrapperPath`)
 *   - [x] `process.dlopen` wrapper.node, obtain `WrapperNodeApi`
 *   - [ ] Build `WrapperSessionInitConfig` (selfUid, clientVer, qua, guid, …)
 *   - [ ] Register `NodeIKernelSessionListener`, call `session.init` + `startNT`
 *   - [ ] Register `NodeIKernelLoginListener` + drive QR/quick-login flow
 *   - [ ] Wire NT API facade onto `InstanceContext.apis`
 *
 * Until those land, {@link start} throws after the load step — callers should
 * use `createMemoryContext` for dev or wait for the next release.
 */
export class CoreBootstrap {
  constructor(private readonly opts: CoreBootstrapOptions) {}

  /** Probe + load only. Safe to call without entering a session. */
  loadWrapper(): PartialBootstrapState {
    const logger = this.opts.logger ?? createLogger({ label: 'core' });
    const wrapperOpts: { execPath?: string; qqVersion?: string } = {};
    if (this.opts.config.qq.execPath !== undefined) wrapperOpts.execPath = this.opts.config.qq.execPath;
    if (this.opts.config.qq.version !== undefined) wrapperOpts.qqVersion = this.opts.config.qq.version;
    const { api, install } = WrapperLoader.load(wrapperOpts);
    logger.info(`wrapper.node loaded from ${install.wrapperPath} (qq=${install.qqVersion})`);
    return { install, api, logger };
  }

  async start(): Promise<InstanceContext> {
    const state = this.loadWrapper();
    state.logger.warn('[CoreBootstrap.start] session.init not implemented yet (v0.2)');
    throw new Error(
      'CoreBootstrap.start is incomplete: NT session init / login flow is the next milestone.\n' +
        '  Workarounds:\n' +
        '    - Set QANYICAT_MEMORY_MODE=1 to use the in-memory loopback for testing\n' +
        '    - Run `qanyicat doctor` to verify your QQ install is detectable'
    );
  }
}
