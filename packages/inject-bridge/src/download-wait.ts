/**
 * NT's media downloads complete asynchronously via the kernel listener
 * `onRichMediaDownloadComplete`. This module bridges that into a Promise per
 * (msgId, elementId): the caller awaits `waitForDownload`, the listener
 * resolves it when the matching completion event fires.
 *
 * A minimal listener→Promise bridge for this one event shape — no general
 * event-wrapper infrastructure, just what the download path needs.
 */
export interface DownloadCompleteInfo {
  filePath?: string;
  msgElementId?: string;
  msgId?: string;
  /** Stringly-typed on NT 9.9 — cast to number before comparing. */
  fileErrCode?: number | string;
  fileErrMsg?: string;
  /** 1 = real file download, 2 = thumbnail. NT fires the thumb event first
   * even when we asked for a non-thumbnail download. Filter to avoid false-positives. */
  fileDownType?: number | string;
  fileId?: string;
  commonFileInfo?: { fileModelId?: string };
}

/**
 * v0.4n-γ: progress events fire for in-progress downloads. NT 9.9.30 doesn't
 * always fire `onRichMediaDownloadComplete` for inline-file downloads — but
 * the final progress event has `fileProgress === totalSize`. We use that as
 * an alternative completion signal.
 */
export interface DownloadProgressInfo {
  msgId?: string;
  msgElementId?: string;
  fileProgress?: number | string;
  totalSize?: number | string;
  saveAsPath?: string;
  filePath?: string;
  fileDownType?: number | string;
  fileErrCode?: number | string;
  fileErrMsg?: string;
}

export class DownloadWaiters {
  private byKey = new Map<string, {
    resolve: (path: string) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** v0.4n-γ: secondary index for downloadFileForModelId — keyed on the
   * modelId returned in `commonFileInfo.fileModelId`. */
  private byModelId = new Map<string, {
    resolve: (path: string) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private static makeKey(msgId: string, elementId: string): string {
    return `${msgId}:${elementId}`;
  }

  /** Register a waiter. Caller must call the NT download method AFTER this. */
  wait(msgId: string, elementId: string, timeoutMs = 120_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const key = DownloadWaiters.makeKey(msgId, elementId);
      const timer = setTimeout(() => {
        this.byKey.delete(key);
        reject(new Error(`download timeout after ${timeoutMs}ms (msgId=${msgId} elem=${elementId})`));
      }, timeoutMs);
      this.byKey.set(key, { resolve, reject, timer });
    });
  }

  /**
   * v0.4n-γ: register a waiter for `downloadFileForModelId` whose completion
   * event carries `commonFileInfo.fileModelId` instead of msgId+elementId.
   */
  waitByModelId(modelId: string, timeoutMs = 120_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.byModelId.delete(modelId);
        reject(new Error(`download timeout after ${timeoutMs}ms (modelId=${modelId})`));
      }, timeoutMs);
      this.byModelId.set(modelId, { resolve, reject, timer });
    });
  }

  /**
   * v0.4n-γ: progress events from `onRichMediaProgerssUpdate`. When the final
   * progress event has `fileProgress === totalSize` AND a path is known (via
   * saveAsPath or filePath), treat that as completion. Some NT 9.9.30 builds
   * never fire the proper Complete event for inline-file downloads.
   */
  signalProgress(info: DownloadProgressInfo): void {
    const msgId = String(info.msgId ?? '');
    const elementId = String(info.msgElementId ?? '');
    if (!msgId || !elementId) return;
    const key = DownloadWaiters.makeKey(msgId, elementId);
    const w = this.byKey.get(key);
    if (!w) return;
    const progress = Number(info.fileProgress ?? 0);
    const total = Number(info.totalSize ?? 0);
    if (!progress || !total || progress < total) return;
    const path = String(info.saveAsPath ?? info.filePath ?? '');
    if (!path) return;
    this.byKey.delete(key);
    clearTimeout(w.timer);
    w.resolve(path);
  }

  /** Called from the kernel listener when NT signals completion. */
  signal(info: DownloadCompleteInfo): void {
    // NT fires this listener for thumbnail downloads (fileDownType=2) *and*
    // the actual file (fileDownType=1). When we asked for the real file we
    // must not resolve on the thumbnail event, or we'll return the wrong path.
    const downType = Number(info.fileDownType ?? 1);
    if (downType === 2) return;
    const path = String(info.filePath ?? '');
    const errCode = Number(info.fileErrCode ?? 0);

    // v0.4n-γ: try modelId-keyed waiter first (downloadFileForModelId path).
    const modelId = String(info.commonFileInfo?.fileModelId ?? '');
    if (modelId && this.byModelId.has(modelId)) {
      const wm = this.byModelId.get(modelId)!;
      this.byModelId.delete(modelId);
      clearTimeout(wm.timer);
      if (errCode !== 0) wm.reject(new Error(`download failed: errCode=${errCode} errMsg=${info.fileErrMsg ?? ''}`));
      else if (!path) wm.reject(new Error('download completed but filePath was empty'));
      else wm.resolve(path);
      return;
    }

    const msgId = String(info.msgId ?? '');
    const elementId = String(info.msgElementId ?? '');
    if (!msgId || !elementId) return;
    const key = DownloadWaiters.makeKey(msgId, elementId);
    const w = this.byKey.get(key);
    if (!w) return;
    this.byKey.delete(key);
    clearTimeout(w.timer);
    if (errCode !== 0) {
      w.reject(new Error(`download failed: errCode=${errCode} errMsg=${info.fileErrMsg ?? ''}`));
    } else if (!path) {
      w.reject(new Error('download completed but filePath was empty'));
    } else {
      w.resolve(path);
    }
  }
}
