import type { Logger } from 'winston';
import type { NodeIQQNTWrapperSession, QQBasicInfo, SelfInfo } from '../wrapper/types';
import type { NTEventBus } from '../event/nt-event-bus';
import type { NTApis } from '../apis';

/**
 * One per logged-in UIN. Holds the native session, listener bus, logger,
 * and the NT API facade. Lifecycle: created by {@link CoreBootstrap.start},
 * destroyed by {@link InstanceContext.dispose}.
 */
export interface InstanceContext {
  readonly uin: string;
  readonly selfInfo: SelfInfo;
  readonly basicInfo: QQBasicInfo;
  readonly session: NodeIQQNTWrapperSession;
  readonly logger: Logger;
  readonly events: NTEventBus;
  readonly apis: NTApis;
  dispose(): Promise<void>;
}
