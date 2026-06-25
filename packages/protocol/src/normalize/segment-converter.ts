import { NTElementType, type NTElement } from '@qanyicat/core';
import type { UnifiedSegment } from '../message/segments';

/**
 * NT-native elements → protocol-neutral segments. Unknown element types are
 * dropped silently — the original list is retained on UnifiedMessage.raw so
 * adapters that care can recover them.
 */
export function ntElementsToSegments(elements: NTElement[]): UnifiedSegment[] {
  const out: UnifiedSegment[] = [];
  for (const el of elements) {
    switch (el.elementType) {
      case NTElementType.TEXT: {
        const t = el.textElement;
        if (t.atType === 1 || t.atType === 2) {
          out.push({
            type: 'at',
            data: {
              uid: t.atType === 2 ? 'all' : (t.atUid ?? ''),
              ...(t.atNtUid !== undefined ? { uin: t.atNtUid } : {}),
            },
          });
        } else if (t.content && t.content.length > 0) {
          out.push({ type: 'text', data: { text: t.content } });
        }
        break;
      }
      case NTElementType.PIC: {
        const p = el.picElement;
        const data: UnifiedSegment & { type: 'image' } = {
          type: 'image',
          data: {
            file: p.md5HexStr ?? p.fileName ?? p.filePath ?? '',
          },
        };
        if (p.originImageUrl) data.data.url = p.originImageUrl;
        if (p.picSubType !== undefined) data.data.sub = p.picSubType;
        if (p.summary) data.data.summary = p.summary;
        out.push(data);
        break;
      }
      case NTElementType.FACE: {
        out.push({ type: 'face', data: { id: el.faceElement.faceIndex } });
        break;
      }
      case NTElementType.REPLY: {
        const r = el.replyElement;
        out.push({ type: 'reply', data: { id: r.replayMsgId || r.replayMsgSeq } });
        break;
      }
      case NTElementType.FILE: {
        const f = el.fileElement;
        // NT leaves `fileMd5` empty on inbound files until the recipient
        // downloads them; `fileUuid` is the stable handle for that case.
        // For self-sent files we already have the md5.
        const fileKey = (f.fileMd5 && f.fileMd5.length > 0)
          ? f.fileMd5
          : (f.fileUuid && f.fileUuid.length > 0)
            ? f.fileUuid
            : f.fileName;
        const data: UnifiedSegment & { type: 'file' } = {
          type: 'file',
          data: { file: fileKey, name: f.fileName },
        };
        if (f.fileSize !== undefined) data.data.size = Number(f.fileSize);
        out.push(data);
        break;
      }
      case NTElementType.PTT: {
        const v = el.pttElement;
        const data: UnifiedSegment & { type: 'voice' } = {
          type: 'voice',
          data: { file: v.md5HexStr ?? v.fileName },
        };
        if (v.duration !== undefined) data.data.duration = v.duration;
        out.push(data);
        break;
      }
      case NTElementType.VIDEO: {
        const v = el.videoElement;
        out.push({ type: 'video', data: { file: v.videoMd5 ?? v.fileName } });
        break;
      }
      case NTElementType.MARKDOWN: {
        out.push({ type: 'markdown', data: { content: el.markdownElement.content } });
        break;
      }
      case NTElementType.MULTI_FORWARD: {
        out.push({ type: 'forward', data: { id: el.multiForwardMsgElement.resId } });
        break;
      }
      case NTElementType.ARK: {
        // Ark elements carry a JSON blob in `bytesData`. The multi-msg forward
        // card uses `app: 'com.tencent.multimsg'` with the resId on
        // `meta.detail.resid` — surface that as a `forward` segment so wire
        // clients can correlate self-sent forwards with the resulting resource.
        // Other ark apps (share cards, mini-program links) round-trip as
        // `json` so bots can read them; emitting raw is preferable to dropping.
        const raw = el.arkElement.bytesData;
        let resId: string | null = null;
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as { app?: string; meta?: { detail?: { resid?: string } } };
            if (parsed.app === 'com.tencent.multimsg' && parsed.meta?.detail?.resid) {
              resId = parsed.meta.detail.resid;
            }
          } catch {
            // Not JSON; fall through to the json-segment fallback below.
          }
        }
        if (resId) out.push({ type: 'forward', data: { id: resId } });
        else if (raw) out.push({ type: 'json', data: { data: raw } });
        break;
      }
      default:
        // Drop unknown element types; the original list survives on raw.
        break;
    }
  }
  return out;
}

/**
 * Inverse mapping. Outbound segments use the minimum field set that NT's send
 * APIs accept — the rest is filled in by Highway / RichMedia upload before
 * the elements reach NodeIKernelMsgService.sendMsg.
 */
export function segmentsToNtElements(segments: UnifiedSegment[]): NTElement[] {
  const out: NTElement[] = [];
  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        out.push({
          elementType: NTElementType.TEXT,
          textElement: { content: seg.data.text, atType: 0 },
        });
        break;
      case 'at': {
        // NT renders the @ marker from the `content` field — it must hold
        // `@<nickname>`. When a resolved nick isn't available we fall back to
        // `@<name|uin|uid>` so something visible reaches the recipient.
        const atAll = seg.data.uid === 'all';
        const display = atAll
          ? '全体成员'
          : (seg.data.name ?? seg.data.uin ?? seg.data.uid);
        out.push({
          elementType: NTElementType.TEXT,
          textElement: {
            content: `@${display}`,
            atType: atAll ? 2 : 1,
            atUid: seg.data.uid,
            ...(seg.data.uin !== undefined ? { atNtUid: seg.data.uin } : {}),
          },
        });
        break;
      }
      case 'face':
        out.push({
          elementType: NTElementType.FACE,
          faceElement: { faceIndex: seg.data.id, faceType: 1 },
        });
        break;
      case 'reply':
        out.push({
          elementType: NTElementType.REPLY,
          replyElement: { replayMsgSeq: seg.data.id, replayMsgId: seg.data.id },
        });
        break;
      case 'image':
        out.push({
          elementType: NTElementType.PIC,
          picElement: {
            md5HexStr: seg.data.file,
            ...(seg.data.url !== undefined ? { originImageUrl: seg.data.url } : {}),
            ...(seg.data.sub !== undefined ? { picSubType: seg.data.sub } : {}),
            ...(seg.data.summary !== undefined ? { summary: seg.data.summary } : {}),
          },
        });
        break;
      case 'voice':
        out.push({
          elementType: NTElementType.PTT,
          pttElement: {
            fileName: seg.data.file,
            md5HexStr: seg.data.file,
            ...(seg.data.duration !== undefined ? { duration: seg.data.duration } : {}),
          },
        });
        break;
      case 'video':
        out.push({
          elementType: NTElementType.VIDEO,
          videoElement: { fileName: seg.data.file, videoMd5: seg.data.file },
        });
        break;
      case 'file':
        out.push({
          elementType: NTElementType.FILE,
          fileElement: {
            fileName: seg.data.name ?? seg.data.file,
            ...(seg.data.size !== undefined ? { fileSize: seg.data.size } : {}),
            ...(seg.data.file ? { fileMd5: seg.data.file } : {}),
          },
        });
        break;
      case 'forward':
        out.push({
          elementType: NTElementType.MULTI_FORWARD,
          multiForwardMsgElement: { resId: seg.data.id },
        });
        break;
      case 'markdown':
        out.push({
          elementType: NTElementType.MARKDOWN,
          markdownElement: { content: seg.data.content },
        });
        break;
      case 'json':
      case 'xml':
        // No first-class NT support yet — caller must route through ARK.
        break;
    }
  }
  return out;
}
