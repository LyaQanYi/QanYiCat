import type { UnifiedSegment } from '@qanyicat/protocol';

/** Encode unified segments into a CQ-code string. */
export function segmentsToCq(segments: UnifiedSegment[]): string {
  let out = '';
  for (const s of segments) {
    if (s.type === 'text') {
      out += escapeCqText(s.data.text);
    } else {
      const parts = Object.entries(s.data).map(([k, v]) => `${k}=${escapeCqParam(String(v))}`);
      out += `[CQ:${s.type}${parts.length ? ',' + parts.join(',') : ''}]`;
    }
  }
  return out;
}

/**
 * Parse a CQ-code string back to segments.
 *
 * Format reminder:
 *   - `[CQ:type,k1=v1,k2=v2]` for non-text segments
 *   - Plain text between codes is `text` segments
 *   - Escapes: `&amp;` → `&`, `&#91;` → `[`, `&#93;` → `]`, `&#44;` → `,` (params only)
 */
export function cqToSegments(text: string): UnifiedSegment[] {
  const out: UnifiedSegment[] = [];
  const re = /\[CQ:([a-zA-Z_]+)((?:,[^=,\]]+=[^,\]]*)*)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const raw = text.slice(lastIndex, match.index);
      out.push({ type: 'text', data: { text: unescapeCqText(raw) } });
    }
    const type = match[1] ?? '';
    const params = match[2] ?? '';
    const data: Record<string, string> = {};
    for (const kv of params.slice(1).split(',')) {
      if (!kv) continue;
      const eq = kv.indexOf('=');
      if (eq < 0) continue;
      const key = kv.slice(0, eq);
      const value = unescapeCqParam(kv.slice(eq + 1));
      data[key] = value;
    }
    out.push(buildSegment(type, data));
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    out.push({ type: 'text', data: { text: unescapeCqText(text.slice(lastIndex)) } });
  }
  return out;
}

function buildSegment(type: string, data: Record<string, string>): UnifiedSegment {
  switch (type) {
    case 'at':
      return { type: 'at', data: { uid: data['qq'] ?? data['uid'] ?? '' } };
    case 'face':
      return { type: 'face', data: { id: Number(data['id'] ?? 0) } };
    case 'image': {
      const seg: UnifiedSegment & { type: 'image' } = {
        type: 'image',
        data: { file: data['file'] ?? '' },
      };
      if (data['url']) seg.data.url = data['url'];
      if (data['sub']) seg.data.sub = Number(data['sub']);
      if (data['summary']) seg.data.summary = data['summary'];
      return seg;
    }
    case 'reply':
      return { type: 'reply', data: { id: data['id'] ?? '' } };
    case 'forward':
      return { type: 'forward', data: { id: data['id'] ?? '' } };
    case 'record':
    case 'voice':
      return { type: 'voice', data: { file: data['file'] ?? '' } };
    case 'video':
      return { type: 'video', data: { file: data['file'] ?? '' } };
    case 'file':
      return {
        type: 'file',
        data: {
          file: data['file'] ?? '',
          ...(data['name'] !== undefined ? { name: data['name'] } : {}),
        },
      };
    case 'json':
      return { type: 'json', data: { data: data['data'] ?? '' } };
    case 'xml':
      return { type: 'xml', data: { data: data['data'] ?? '' } };
    case 'markdown':
      return { type: 'markdown', data: { content: data['content'] ?? '' } };
    default:
      return { type: 'text', data: { text: `[CQ:${type}]` } };
  }
}

function escapeCqText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
}

function escapeCqParam(s: string): string {
  return escapeCqText(s).replace(/,/g, '&#44;');
}

function unescapeCqText(s: string): string {
  return s.replace(/&#93;/g, ']').replace(/&#91;/g, '[').replace(/&amp;/g, '&');
}

function unescapeCqParam(s: string): string {
  return unescapeCqText(s).replace(/&#44;/g, ',');
}
