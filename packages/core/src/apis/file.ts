import type { NTPeer } from '../event/nt-event-bus';

export interface NTFileApi {
  upload(peer: NTPeer, filePath: string): Promise<{ fileId: string; fileName: string; size: number }>;
  download(peer: NTPeer, msgId: string, fileId: string): Promise<{ localPath: string }>;
}
