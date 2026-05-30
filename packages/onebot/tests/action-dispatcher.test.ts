import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '@qanyicat/core';
import { _resetActionRegistry, registerAction } from '@qanyicat/protocol';
import { ActionDispatcher } from '../src/dispatch/action-dispatcher';

describe('ActionDispatcher', () => {
  const ctx = createMemoryContext({ uin: '10000' });

  afterEach(() => _resetActionRegistry());

  it('returns ok + data when handler succeeds', async () => {
    registerAction('echo', async (_c, p) => ({ pong: (p as { ping: string }).ping }));
    const d = new ActionDispatcher(ctx);
    const r = await d.invoke('echo', { ping: 'hi' }, 'e1');
    expect(r).toEqual({ status: 'ok', retcode: 0, data: { pong: 'hi' }, echo: 'e1' });
  });

  it('returns failed retcode=1404 for unknown actions', async () => {
    const r = await new ActionDispatcher(ctx).invoke('nope', {}, undefined);
    expect(r).toMatchObject({ status: 'failed', retcode: 1404 });
  });

  it('wraps thrown errors as retcode=1500', async () => {
    registerAction('boom', async () => {
      throw new Error('kaboom');
    });
    const r = await new ActionDispatcher(ctx).invoke('boom', {}, 'e2');
    expect(r).toEqual({
      status: 'failed',
      retcode: 1500,
      data: null,
      message: 'kaboom',
      echo: 'e2',
    });
  });

  it('omits echo when not provided', async () => {
    registerAction('plain', async () => 'x');
    const r = await new ActionDispatcher(ctx).invoke('plain', {});
    expect(r).toEqual({ status: 'ok', retcode: 0, data: 'x' });
    expect((r as Record<string, unknown>).echo).toBeUndefined();
  });
});
