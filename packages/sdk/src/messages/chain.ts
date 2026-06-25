import type { SdkSegment } from '../types/index.js';

export class MessageChain {
  private readonly segments: SdkSegment[] = [];

  text(s: string): this {
    this.segments.push({ type: 'text', data: { text: s } });
    return this;
  }

  at(uin: string | 'all'): this {
    this.segments.push({ type: 'at', data: { uid: uin } });
    return this;
  }

  face(id: number): this {
    this.segments.push({ type: 'face', data: { id } });
    return this;
  }

  image(file: string, url?: string): this {
    this.segments.push({ type: 'image', data: url !== undefined ? { file, url } : { file } });
    return this;
  }

  reply(messageId: string): this {
    this.segments.push({ type: 'reply', data: { id: messageId } });
    return this;
  }

  raw(segment: SdkSegment): this {
    this.segments.push(segment);
    return this;
  }

  build(): SdkSegment[] {
    return [...this.segments];
  }
}
