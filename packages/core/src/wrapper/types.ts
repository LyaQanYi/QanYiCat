/**
 * Minimal surface of wrapper.node we depend on. Real shape is provided by the
 * Tencent NT runtime — this declaration only captures what the loader must
 * return so the rest of `core` can stay typed without pulling in `any`.
 */
export interface WrapperNodeApi {
  NodeIQQNTWrapperSession: NodeIQQNTWrapperSessionCtor;
  NodeIDependsAdapter?: unknown;
  NodeIDispatcherAdapter?: unknown;
  NodeIGlobalAdapter?: unknown;
}

export interface NodeIQQNTWrapperSessionCtor {
  new (): NodeIQQNTWrapperSession;
}

export interface NodeIQQNTWrapperSession {
  init(config: unknown): number;
  startNT(start: number): void;
  destroy(): void;
  getMsgService(): unknown;
  getGroupService(): unknown;
  getBuddyService(): unknown;
  getProfileService(): unknown;
  getRichMediaService(): unknown;
  getStorageCleanService?(): unknown;
  // ...other getters are reachable through dynamic indexing in the listener
  // registration code; we keep this interface intentionally narrow so changes
  // to wrapper.node only break one file.
  [k: string]: unknown;
}

export interface SelfInfo {
  uin: string;
  uid: string;
  nick: string;
  online: boolean;
}

export interface QQBasicInfo {
  execPath: string;
  qqVersion: string;
  qqVersionConfigPath: string;
  qqResourceDir: string;
}
