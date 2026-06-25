export interface NTSystemApi {
  getOnlineStatus(): Promise<'online' | 'offline' | 'away'>;
  setOnlineStatus(status: 'online' | 'away' | 'busy' | 'invisible'): Promise<void>;
  /** ms since epoch as the kernel sees it; used to detect clock drift. */
  getKernelTime(): Promise<number>;
}
