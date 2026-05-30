import type { SdkMessage, SdkSegment } from '../types/index.js';

export function plainText(msg: SdkMessage): string {
  let out = '';
  for (const s of msg.segments) {
    if (s.type === 'text') out += (s.data as { text: string }).text;
  }
  return out.trim();
}

export function hasAt(msg: SdkMessage, uin: string): boolean {
  return msg.segments.some((s: SdkSegment) => s.type === 'at' && (s.data as { uid: string }).uid === uin);
}
