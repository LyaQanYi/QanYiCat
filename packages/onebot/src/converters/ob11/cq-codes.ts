/**
 * OneBot 11 CQ-code string ↔ UnifiedSegment[] converter (parse direction only
 * for v0.4e-β — encode is already handled by `message-cq.ts`).
 *
 * Grammar (per OB11 spec):
 *   message = (text | cq_code)*
 *   cq_code = "[CQ:" type ("," key "=" value)* "]"
 *   value   = HTML-entity-escaped ("&amp;" → "&", "&#91;" → "[", "&#93;" → "]", "&#44;" → ",")
 *   text    = literal characters, also HTML-entity-escaped
 *
 * Recognized CQ types (v0.4e-β scope): at, face, reply, image. Unknown types
 * survive as a fake text segment `[CQ:type,...]` so downstream sends them as
 * literal text — visible signal that we hit an unsupported feature, not silent
 * loss.
 */

import type { UnifiedSegment } from '@qanyicat/protocol';

/**
 * Caller-supplied async uin resolver. Returns the resolved uid plus an
 * optional nickname (so `@<nick>` rather than `@<uin>` can be emitted), or
 * null on cache miss.
 */
export type UinResolver = (uin: string) => Promise<{ uid: string; nick?: string } | null>;

/** Unescape CQ-code value (&amp; &#91; &#93; &#44; → & [ ] ,). Also handles text segments outside [CQ:]. */
function unescape(s: string): string {
  return s
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

interface CqToken {
  type: string;
  params: Record<string, string>;
}

function parseCqToken(body: string): CqToken | null {
  // body is the content between `[CQ:` and `]`, e.g. "at,qq=123,name=foo"
  const parts = body.split(',');
  if (parts.length === 0) return null;
  const type = parts[0]?.trim();
  if (!type) return null;
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = unescape(part.slice(eq + 1));
    if (key) params[key] = value;
  }
  return { type, params };
}

/** Split message string into raw text chunks + CQ tokens, preserving order. */
function tokenize(message: string): Array<{ kind: 'text'; raw: string } | { kind: 'cq'; token: CqToken; raw: string }> {
  const out: Array<{ kind: 'text'; raw: string } | { kind: 'cq'; token: CqToken; raw: string }> = [];
  let i = 0;
  while (i < message.length) {
    const open = message.indexOf('[CQ:', i);
    if (open < 0) {
      out.push({ kind: 'text', raw: message.slice(i) });
      break;
    }
    if (open > i) out.push({ kind: 'text', raw: message.slice(i, open) });
    const close = message.indexOf(']', open + 4);
    if (close < 0) {
      // Unterminated — treat rest as literal text.
      out.push({ kind: 'text', raw: message.slice(open) });
      break;
    }
    const body = message.slice(open + 4, close);
    const token = parseCqToken(body);
    if (!token) {
      out.push({ kind: 'text', raw: message.slice(open, close + 1) });
    } else {
      out.push({ kind: 'cq', token, raw: message.slice(open, close + 1) });
    }
    i = close + 1;
  }
  return out;
}

async function tokenToSegment(token: CqToken, resolver: UinResolver | undefined, fallbackRaw: string): Promise<UnifiedSegment | null> {
  switch (token.type) {
    case 'text':
      return token.params.text ? { type: 'text', data: { text: token.params.text } } : null;

    case 'at': {
      const qq = token.params.qq ?? '';
      const explicitName = token.params.name;
      if (qq === 'all' || qq === '0') {
        return { type: 'at', data: { uid: 'all' } };
      }
      if (!qq) return null;
      const resolved = resolver ? await resolver(qq) : null;
      const uid = resolved?.uid ?? '';
      if (!uid) {
        return { type: 'text', data: { text: `@${explicitName ?? qq} ` } };
      }
      const name = explicitName ?? resolved?.nick;
      return {
        type: 'at',
        data: { uid, uin: qq, ...(name ? { name } : {}) },
      };
    }

    case 'face': {
      const id = Number(token.params.id);
      if (!Number.isFinite(id)) return null;
      return { type: 'face', data: { id } };
    }

    case 'reply': {
      const id = token.params.id ?? '';
      if (!id) return null;
      return { type: 'reply', data: { id } };
    }

    case 'image': {
      const file = token.params.file ?? token.params.url ?? '';
      if (!file) return null;
      const seg: UnifiedSegment & { type: 'image' } = { type: 'image', data: { file } };
      if (token.params.url && token.params.url !== file) seg.data.url = token.params.url;
      if (token.params.summary) seg.data.summary = token.params.summary;
      return seg;
    }

    default:
      // Unknown CQ type — preserve verbatim so the user sees what slipped through.
      return { type: 'text', data: { text: fallbackRaw } };
  }
}

/**
 * Parse an OB11 CQ-code-bearing string into protocol-neutral segments.
 * Pure for `text/face/reply/image`; needs an async resolver for `at` (to map
 * the CQ `qq=<num>` to the unified `uid` field). Without a resolver, `at`
 * codes degrade to a literal `@<num>` text segment.
 */
export async function parseCqString(message: string, resolver?: UinResolver): Promise<UnifiedSegment[]> {
  const tokens = tokenize(message);
  const out: UnifiedSegment[] = [];
  for (const t of tokens) {
    if (t.kind === 'text') {
      const text = unescape(t.raw);
      if (text.length > 0) out.push({ type: 'text', data: { text } });
    } else {
      const seg = await tokenToSegment(t.token, resolver, t.raw);
      if (seg) out.push(seg);
    }
  }
  return out;
}
