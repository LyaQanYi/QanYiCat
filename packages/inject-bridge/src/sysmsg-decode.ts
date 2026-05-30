/**
 * v0.4j-δ: decode `NodeIKernelMsgListener.onRecvSysMsg(byteArray)` payloads.
 *
 * The kernel delivers system events (group member changes, admin promote/
 * demote, self-kick, group disband, etc.) as raw protobuf bytes. The bot-
 * facing OneBot listeners (`onGroupNotifiesUpdated`, `onMemberListChange`)
 * only cover SOME of these — self-kick in particular only arrives via this
 * channel. Rather than pull in a protobuf codegen runtime, we use the minimal
 * wire reader in `protobuf-tiny.ts`.
 *
 * Wire schemas (reverse-engineered from NT 9.9 sysmsg bytes):
 *   - PushMsgBody: {responseHead, contentHead, body}
 *   - ContentHead.type discriminator: 33 = increase, 34 = decrease, 44 = admin
 *   - GroupChange: {groupUin, flag, memberUid, decreaseType, operatorInfo, …}
 *   - GroupChangeInfo: nested protobuf inside operatorInfo when 0a-prefixed
 *     or decreaseType==3 (kick_me). Contains operator's uid.
 *   - GroupAdmin: {groupUin, flag, isPromote, body:{extraDisable, extraEnable}}
 */

import { readMessage, getBytes, getNumber, getString, getSubmessage, toUint8Array } from './protobuf-tiny';

export type SysMsgEvent =
  | { kind: 'group.member-change'; groupCode: string; memberUid: string; operatorUid?: string; sub: 'join' | 'leave' | 'kick' | 'kick_me' | 'disband'; sourceType: number }
  | { kind: 'group.admin-change'; groupCode: string; adminUid: string; isAdmin: boolean }
  | { kind: 'unknown'; contentType: number; subType?: number };

/** Map NT's decreaseType enum → our unified sub-kind. */
function decreaseTypeToSub(t: number): 'leave' | 'kick' | 'kick_me' | 'disband' {
  switch (t) {
    case 130: return 'leave';
    case 131: return 'kick';
    case 3:   return 'kick_me';
    case 129: return 'disband';
    default:  return 'kick';
  }
}

/**
 * Try to extract the operator's uid from `operatorInfo` bytes. NT puts it in
 * one of two shapes depending on the change kind:
 *   • nested protobuf `GroupChangeInfo { operator { operatorUid } }` —
 *     identifiable by the leading 0x0a byte (field 1, wire type 2)
 *   • bare ASCII uid (`u_…`) string — used when the kernel can name the
 *     operator directly.
 */
function parseOperatorInfo(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes || bytes.length === 0) return undefined;
  // Protobuf-shaped (starts with field-1-length-delimited tag).
  if (bytes[0] === 0x0a) {
    try {
      const info = readMessage(bytes);
      const operator = getSubmessage(info, 1);
      if (operator) {
        const uid = getString(operator, 1);
        if (uid) return uid;
      }
    } catch { /* fall through to ASCII parse */ }
  }
  // ASCII uid (must be safe printable ASCII; reject if any byte > 0x7E).
  for (const b of bytes) if (b < 0x20 || b > 0x7e) return undefined;
  return new TextDecoder('ascii').decode(bytes);
}

/** Decode one onRecvSysMsg payload. Returns `null` on unrecognized shape. */
export function decodeSysMsg(rawBytes: number[] | Uint8Array): SysMsgEvent | null {
  const buf = toUint8Array(rawBytes);
  let pushBody: ReturnType<typeof readMessage>;
  try { pushBody = readMessage(buf); }
  catch { return null; }

  // PushMsgBody.contentHead (field 2) carries `type` (field 1) — the kind discriminator.
  const contentHead = getSubmessage(pushBody, 2);
  if (!contentHead) return null;
  const contentType = getNumber(contentHead, 1);
  if (contentType === undefined) return null;

  // PushMsgBody.body (field 3) → MessageBody.msgContent (field 2) is the inner payload.
  const messageBody = getSubmessage(pushBody, 3);
  const innerBytes = messageBody ? getBytes(messageBody, 2) : undefined;
  if (!innerBytes) {
    const subType = getNumber(contentHead, 2);
    return { kind: 'unknown', contentType, ...(subType !== undefined ? { subType } : {}) };
  }

  if (contentType === 33 || contentType === 34) {
    // GroupChange
    const gc = readMessage(innerBytes);
    const groupUin = getNumber(gc, 1);
    if (groupUin === undefined) return null;
    const memberUid = getString(gc, 3) ?? '';
    const decreaseType = getNumber(gc, 4) ?? 0;
    const increaseType = getNumber(gc, 6) ?? 0;
    const operatorInfo = getBytes(gc, 5);
    const operatorUid = parseOperatorInfo(operatorInfo);

    if (contentType === 33) {
      // Increase: 131 = invite, anything else = approve
      return {
        kind: 'group.member-change',
        groupCode: String(groupUin),
        memberUid,
        ...(operatorUid ? { operatorUid } : {}),
        sub: 'join',
        sourceType: increaseType,
      };
    }
    // Decrease
    return {
      kind: 'group.member-change',
      groupCode: String(groupUin),
      memberUid,
      ...(operatorUid ? { operatorUid } : {}),
      sub: decreaseTypeToSub(decreaseType),
      sourceType: decreaseType,
    };
  }

  if (contentType === 44) {
    // GroupAdmin: {groupUin, flag, isPromote, body: {extraDisable, extraEnable}}
    const ga = readMessage(innerBytes);
    const groupUin = getNumber(ga, 1);
    if (groupUin === undefined) return null;
    const body = getSubmessage(ga, 4);
    if (!body) return null;
    const extraEnable = getSubmessage(body, 2);   // promote
    const extraDisable = getSubmessage(body, 1);  // demote
    let adminUid = '';
    let isAdmin = false;
    if (extraEnable) { adminUid = getString(extraEnable, 1) ?? ''; isAdmin = true; }
    else if (extraDisable) { adminUid = getString(extraDisable, 1) ?? ''; isAdmin = false; }
    else return null;
    return { kind: 'group.admin-change', groupCode: String(groupUin), adminUid, isAdmin };
  }

  const subType = getNumber(contentHead, 2);
  return { kind: 'unknown', contentType, ...(subType !== undefined ? { subType } : {}) };
}
