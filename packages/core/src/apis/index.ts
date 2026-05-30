export * from './msg';
export * from './user';
export * from './group';
export * from './friend';
export * from './file';
export * from './system';

import type { NTMsgApi } from './msg';
import type { NTUserApi } from './user';
import type { NTGroupApi } from './group';
import type { NTFriendApi } from './friend';
import type { NTFileApi } from './file';
import type { NTSystemApi } from './system';

/**
 * Facade injected into {@link InstanceContext}. Each domain is its own typed
 * surface so consumers can destructure rather than reach for the raw session.
 */
export interface NTApis {
  msg: NTMsgApi;
  user: NTUserApi;
  group: NTGroupApi;
  friend: NTFriendApi;
  file: NTFileApi;
  system: NTSystemApi;
}
