import type { UnifiedSegment } from '@qanyicat/protocol';

export interface OB12Segment {
  type: string;
  data: Record<string, unknown>;
}

/**
 * OB12 wire segments. The OneBot 12 spec uses snake_case keys on `data`, with
 * a couple of renames from the protocol-neutral shape:
 *   - `text.text`     → unchanged
 *   - `at.uid`        → `mention.user_id`
 *   - `image.file`    → `image.file_id`
 *   - `reply.id`      → `reply.message_id`
 *   - `voice/video`   → `voice/video.file_id`
 *   - `forward.id`    → `forward.message_id`
 *   - `face`          → kept as `qq.face` (extension namespace)
 */
export function segmentsToOb12(segments: UnifiedSegment[]): OB12Segment[] {
  const out: OB12Segment[] = [];
  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        out.push({ type: 'text', data: { text: seg.data.text } });
        break;
      case 'at':
        out.push({ type: 'mention', data: { user_id: seg.data.uid } });
        break;
      case 'image':
        out.push({
          type: 'image',
          data: { file_id: seg.data.file, ...(seg.data.url ? { url: seg.data.url } : {}) },
        });
        break;
      case 'voice':
        out.push({
          type: 'voice',
          data: { file_id: seg.data.file, ...(seg.data.duration ? { duration: seg.data.duration } : {}) },
        });
        break;
      case 'video':
        out.push({ type: 'video', data: { file_id: seg.data.file } });
        break;
      case 'file':
        out.push({
          type: 'file',
          data: { file_id: seg.data.file, ...(seg.data.name ? { name: seg.data.name } : {}) },
        });
        break;
      case 'reply':
        out.push({ type: 'reply', data: { message_id: seg.data.id } });
        break;
      case 'forward':
        out.push({ type: 'forward', data: { message_id: seg.data.id } });
        break;
      case 'face':
        out.push({ type: 'qq.face', data: { id: seg.data.id } });
        break;
      case 'markdown':
        out.push({ type: 'markdown', data: { content: seg.data.content } });
        break;
      case 'json':
        out.push({ type: 'qq.json', data: { data: seg.data.data } });
        break;
      case 'xml':
        out.push({ type: 'qq.xml', data: { data: seg.data.data } });
        break;
    }
  }
  return out;
}

/** Inverse mapping for inbound action params on `send_message`. */
export function ob12ToSegments(arr: OB12Segment[]): UnifiedSegment[] {
  const out: UnifiedSegment[] = [];
  for (const seg of arr) {
    const d = seg.data;
    switch (seg.type) {
      case 'text':
        out.push({ type: 'text', data: { text: String(d['text'] ?? '') } });
        break;
      case 'mention':
        out.push({ type: 'at', data: { uid: String(d['user_id'] ?? '') } });
        break;
      case 'mention_all':
        out.push({ type: 'at', data: { uid: 'all' } });
        break;
      case 'image':
        out.push({
          type: 'image',
          data: { file: String(d['file_id'] ?? d['file'] ?? '') },
        });
        break;
      case 'voice':
        out.push({ type: 'voice', data: { file: String(d['file_id'] ?? '') } });
        break;
      case 'video':
        out.push({ type: 'video', data: { file: String(d['file_id'] ?? '') } });
        break;
      case 'file':
        out.push({
          type: 'file',
          data: {
            file: String(d['file_id'] ?? ''),
            ...(d['name'] !== undefined ? { name: String(d['name']) } : {}),
          },
        });
        break;
      case 'reply':
        out.push({ type: 'reply', data: { id: String(d['message_id'] ?? '') } });
        break;
      case 'forward':
        out.push({ type: 'forward', data: { id: String(d['message_id'] ?? '') } });
        break;
      case 'qq.face':
        out.push({ type: 'face', data: { id: Number(d['id'] ?? 0) } });
        break;
      case 'markdown':
        out.push({ type: 'markdown', data: { content: String(d['content'] ?? '') } });
        break;
      default:
        // Drop unknown segment types silently.
        break;
    }
  }
  return out;
}
