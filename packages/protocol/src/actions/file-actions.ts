import type { InstanceContext } from '@qanyicat/core';
import type { UnifiedPeer } from '../message/unified-message';
import { registerAction } from './registry';

registerAction<{ peer: UnifiedPeer; filePath: string }, { fileId: string }>(
  'upload_file',
  async (_ctx: InstanceContext): Promise<{ fileId: string }> => {
    throw new Error('[action:upload_file] not implemented yet (v0.1)');
  }
);

registerAction<{ peer: UnifiedPeer; messageId: string; fileId: string }, { localPath: string }>(
  'download_file',
  async (_ctx: InstanceContext): Promise<{ localPath: string }> => {
    throw new Error('[action:download_file] not implemented yet (v0.1)');
  }
);
