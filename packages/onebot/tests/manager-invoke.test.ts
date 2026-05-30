import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMemoryContext,
  type InstanceContext,
  type QanYiCatConfig,
} from '@qanyicat/core';
import { OneBotManager } from '../src/manager';

// OneBotManager.invokeAction is the in-process entry the WebUI "接口调试" page
// uses. We exercise it against memory-context so the whole pipeline runs
// without HTTP/WS/QQ — wire-params translator + dispatcher + action handler +
// echo loopback. Anything that breaks the wire shape between adapter and
// handler shows up here as a unit test instead of a live-smoke surprise.

type DispatchResult = {
  status: 'ok' | 'failed';
  retcode: number;
  data: unknown;
  message?: string;
};

function makeCfg(overrides: Partial<QanYiCatConfig['onebot']> = {}): QanYiCatConfig['onebot'] {
  return { enable11: true, enable12: false, networks: [], ...overrides };
}

describe('OneBotManager.invokeAction', () => {
  let ctx: InstanceContext;
  let mgr: OneBotManager;

  beforeEach(async () => {
    ctx = createMemoryContext({ uin: '10000', nick: 'tester' });
    mgr = new OneBotManager(ctx, makeCfg());
    await mgr.start();
  });

  afterEach(async () => {
    await mgr.stop();
    await ctx.dispose();
  });

  it('routes get_login_info through the v11 wire pipeline', async () => {
    const r = (await mgr.invokeAction('get_login_info', {})) as DispatchResult;
    expect(r.status).toBe('ok');
    expect(r.retcode).toBe(0);
    expect(r.data).toEqual({ user_id: 10000, nickname: 'tester' });
  });

  it('routes get_status', async () => {
    const r = (await mgr.invokeAction('get_status', {})) as DispatchResult;
    expect(r.status).toBe('ok');
    expect(r.data).toEqual({ online: true, good: true });
  });

  it('returns retcode 1404 for unknown action (does not throw)', async () => {
    const r = (await mgr.invokeAction('foo_bar_does_not_exist', {})) as DispatchResult;
    expect(r.status).toBe('failed');
    expect(r.retcode).toBe(1404);
    expect(r.message ?? '').toMatch(/unknown action/);
  });

  it('translates OB11 send_msg shape + memory-context echoes via msg.recv', async () => {
    const received = new Promise<{ messages: Array<{ senderUid: string; senderUin: string; elements: unknown[] }> }>(
      (resolve) => ctx.events.on('msg.recv', resolve)
    );

    const r = (await mgr.invokeAction('send_msg', {
      user_id: 20000,
      message: 'hi from invokeAction',
    })) as DispatchResult;
    expect(r.status).toBe('ok');

    const echoed = await received;
    expect(echoed.messages).toHaveLength(1);
    const [first] = echoed.messages;
    expect(first.senderUid).toBe('u_10000');
    expect(first.senderUin).toBe('10000');
    // wire-params splits "hi from invokeAction" into a single text segment;
    // memory-context echoes the SendElement[] verbatim.
    expect(first.elements[0]).toMatchObject({ textElement: { content: 'hi from invokeAction' } });
  });

  it('throws clearly when targeting a disabled protocol version', async () => {
    await expect(mgr.invokeAction('get_status', {}, 'v12')).rejects.toThrow(/v12.*not enabled/);
  });

  it('routes v12 actions when enable12=true', async () => {
    await mgr.stop();
    mgr = new OneBotManager(ctx, makeCfg({ enable12: true }));
    await mgr.start();

    const r = (await mgr.invokeAction('get_status', {}, 'v12')) as DispatchResult;
    expect(r.status).toBe('ok');
    expect(r.retcode).toBe(0);
    expect(r.data).toEqual({ online: true, good: true });
  });

});
