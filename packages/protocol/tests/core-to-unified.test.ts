import { describe, expect, it } from 'vitest';
import { NTElementType, createMemoryContext, type NTRawMessage } from '@qanyicat/core';
import { CoreToUnified } from '../src/normalize/core-to-unified';

describe('CoreToUnified.message', () => {
  const ctx = createMemoryContext({ uin: '10000' });

  it('normalizes a private NT message', () => {
    const raw: NTRawMessage = {
      msgId: 'm1',
      msgSeq: '5',
      msgRandom: '999',
      msgTime: '1700000000',
      peer: { chatType: 'private', peerUid: 'u_20000', peerUin: '20000' },
      senderUid: 'u_20000',
      senderUin: '20000',
      sendNickName: 'peer',
      elements: [
        { elementType: NTElementType.TEXT, textElement: { content: 'hi' } },
      ],
    };
    const msg = CoreToUnified.message(raw, ctx);

    expect(msg.scene).toBe('private');
    expect(msg.selfId).toBe('10000');
    expect(msg.peer).toEqual({ type: 'user', id: '20000' });
    expect(msg.sender).toMatchObject({ uid: 'u_20000', uin: '20000', nickname: 'peer' });
    expect(msg.segments).toEqual([{ type: 'text', data: { text: 'hi' } }]);
    expect(msg.timestamp).toBe(1_700_000_000_000);
    expect(msg.id).toBe('10000:private:5:999');
  });

  it('normalizes a group NT message', () => {
    const raw: NTRawMessage = {
      msgId: 'm2',
      msgSeq: '7',
      msgRandom: '321',
      msgTime: '1700000001',
      peer: { chatType: 'group', peerUid: 'g_1234', groupCode: '1234' },
      senderUid: 'u_99',
      senderUin: '99',
      senderRole: 'admin',
      sendMemberName: 'Lara',
      elements: [],
    };
    const msg = CoreToUnified.message(raw, ctx);
    expect(msg.scene).toBe('group');
    expect(msg.peer).toEqual({ type: 'group', id: '1234' });
    expect(msg.sender.card).toBe('Lara');
    expect(msg.sender.role).toBe('admin');
  });

  it('produces a stable id across two normalizations of the same raw', () => {
    const raw: NTRawMessage = {
      msgId: 'x', msgSeq: '1', msgRandom: '2', msgTime: '0',
      peer: { chatType: 'private', peerUid: 'u_1', peerUin: '1' },
      senderUid: 'u_1', elements: [],
    };
    expect(CoreToUnified.message(raw, ctx).id).toBe(CoreToUnified.message(raw, ctx).id);
  });
});

describe('CoreToUnified.event', () => {
  const ctx = createMemoryContext({ uin: '10000' });

  it('fans msg.recv out into one UnifiedEvent per message', () => {
    const events = CoreToUnified.event(
      'msg.recv',
      {
        peer: { chatType: 'private', peerUid: 'u_2', peerUin: '2' },
        messages: [
          { msgId: 'a', msgSeq: '1', msgRandom: '1', msgTime: '0',
            peer: { chatType: 'private', peerUid: 'u_2', peerUin: '2' },
            senderUid: 'u_2', elements: [] },
          { msgId: 'b', msgSeq: '2', msgRandom: '2', msgTime: '0',
            peer: { chatType: 'private', peerUid: 'u_2', peerUin: '2' },
            senderUid: 'u_2', elements: [] },
        ],
      },
      ctx
    );
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.kind === 'message')).toBe(true);
  });

  it('maps login.success to lifecycle.connect', () => {
    const events = CoreToUnified.event('login.success', { uin: '10000', uid: 'u_10000' }, ctx);
    expect(events).toEqual([{ kind: 'meta', sub: 'lifecycle.connect' }]);
  });

  it('encodes friend.request flag as `${uid}|${reqTime}|${doubt}`', () => {
    const regular = CoreToUnified.event('friend.request', {
      uid: 'u_X', uin: '12345', comment: 'hi', reqTime: '1700000000', doubt: false,
    }, ctx);
    expect(regular[0]).toMatchObject({
      kind: 'request', sub: 'friend.add', userId: '12345', comment: 'hi',
      flag: 'u_X|1700000000|0',
    });
    const doubtTrack = CoreToUnified.event('friend.request', {
      uid: 'u_Y', comment: '', reqTime: '1700000001', doubt: true,
    }, ctx);
    expect(doubtTrack[0]).toMatchObject({
      flag: 'u_Y|1700000001|1',
      userId: 'u_Y',  // no uin → fallback to uid
    });
  });

  it('encodes group.request flag as `${seq}|${type}|${groupCode}|${doubt}`', () => {
    const joinReq = CoreToUnified.event('group.request', {
      groupCode: '1234', uid: 'u_A', uin: '99', comment: 'let me in',
      flag: '17000000000', isInvite: false, type: 7, doubt: false,
    }, ctx);
    expect(joinReq[0]).toMatchObject({
      kind: 'request', sub: 'group.join', groupId: '1234', userId: '99',
      comment: 'let me in', flag: '17000000000|7|1234|0',
    });
    const inviteReq = CoreToUnified.event('group.request', {
      groupCode: '1234', uid: 'u_B', uin: '88', comment: '',
      flag: '17000000001', isInvite: true, type: 1, doubt: false,
    }, ctx);
    expect(inviteReq[0]).toMatchObject({
      kind: 'request', sub: 'group.invite', groupId: '1234', userId: '88',
      flag: '17000000001|1|1234|0',
    });
  });
});
