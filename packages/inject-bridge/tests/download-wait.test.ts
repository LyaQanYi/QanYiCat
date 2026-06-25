import { describe, expect, it } from 'vitest';
import { DownloadWaiters } from '../src/download-wait';

describe('DownloadWaiters', () => {
  it('resolves on real-file (fileDownType=1) completion event', async () => {
    const w = new DownloadWaiters();
    const p = w.wait('m1', 'e1', 1000);
    w.signal({ msgId: 'm1', msgElementId: 'e1', fileDownType: 1, filePath: 'D:\\x.bin', fileErrCode: 0 });
    await expect(p).resolves.toBe('D:\\x.bin');
  });

  it('ignores thumbnail (fileDownType=2) and waits for the real one', async () => {
    const w = new DownloadWaiters();
    const p = w.wait('m1', 'e1', 1000);
    w.signal({ msgId: 'm1', msgElementId: 'e1', fileDownType: 2, filePath: 'D:\\thumb.png', fileErrCode: 0 });
    // No resolution yet
    w.signal({ msgId: 'm1', msgElementId: 'e1', fileDownType: 1, filePath: 'D:\\real.bin', fileErrCode: 0 });
    await expect(p).resolves.toBe('D:\\real.bin');
  });

  it('rejects on non-zero errCode (even when arriving as a string)', async () => {
    const w = new DownloadWaiters();
    const p = w.wait('m1', 'e1', 1000);
    w.signal({ msgId: 'm1', msgElementId: 'e1', fileDownType: 1, filePath: '', fileErrCode: '42', fileErrMsg: 'boom' });
    await expect(p).rejects.toThrow(/errCode=42/);
  });

  it('treats string "0" errCode as success', async () => {
    const w = new DownloadWaiters();
    const p = w.wait('m1', 'e1', 1000);
    w.signal({ msgId: 'm1', msgElementId: 'e1', fileDownType: '1', filePath: 'ok.bin', fileErrCode: '0' });
    await expect(p).resolves.toBe('ok.bin');
  });

  it('rejects on timeout when no event arrives', async () => {
    const w = new DownloadWaiters();
    const p = w.wait('m1', 'e1', 50);
    await expect(p).rejects.toThrow(/timeout/);
  });

  it('ignores signals for unknown keys', async () => {
    const w = new DownloadWaiters();
    // Should not throw — just no-op.
    w.signal({ msgId: 'm1', msgElementId: 'e1', fileDownType: 1, filePath: 'x', fileErrCode: 0 });
  });

  it('resolves modelId waiter via commonFileInfo.fileModelId', async () => {
    const w = new DownloadWaiters();
    const p = w.waitByModelId('elem-42', 1000);
    w.signal({
      commonFileInfo: { fileModelId: 'elem-42' },
      fileDownType: 1, filePath: 'D:\\file.bin', fileErrCode: 0,
    });
    await expect(p).resolves.toBe('D:\\file.bin');
  });

  it('signalProgress resolves when fileProgress reaches totalSize via saveAsPath', async () => {
    const w = new DownloadWaiters();
    const p = w.wait('mX', 'eX', 1000);
    w.signalProgress({ msgId: 'mX', msgElementId: 'eX', fileProgress: 500, totalSize: 1000, saveAsPath: 'D:\\a' });
    // mid-download — should NOT resolve yet
    w.signalProgress({ msgId: 'mX', msgElementId: 'eX', fileProgress: 1000, totalSize: 1000, saveAsPath: 'D:\\a' });
    await expect(p).resolves.toBe('D:\\a');
  });

  it('signalProgress is no-op for unknown keys', () => {
    const w = new DownloadWaiters();
    w.signalProgress({ msgId: 'm0', msgElementId: 'e0', fileProgress: 100, totalSize: 100, saveAsPath: 'D:\\nope' });
  });

  it('modelId waiter still rejects on error code', async () => {
    const w = new DownloadWaiters();
    const p = w.waitByModelId('elem-99', 1000);
    w.signal({
      commonFileInfo: { fileModelId: 'elem-99' },
      fileDownType: 1, filePath: '', fileErrCode: 11,
    });
    await expect(p).rejects.toThrow(/errCode=11/);
  });
});
