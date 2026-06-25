import { afterEach, describe, expect, it } from 'vitest';
import { _resetActionRegistry, getAction, listActions, registerAction } from '../src/actions/registry';

describe('actionRegistry', () => {
  afterEach(() => _resetActionRegistry());

  it('stores and retrieves handlers by name', async () => {
    registerAction<{ x: number }, number>('square', async (_ctx, p) => p.x * p.x);
    const handler = getAction('square');
    expect(handler).toBeDefined();
    expect(await handler!({} as never, { x: 5 })).toBe(25);
  });

  it('throws on duplicate registration', () => {
    registerAction('noop', async () => null);
    expect(() => registerAction('noop', async () => null)).toThrow(/duplicate/);
  });

  it('lists registered names', () => {
    registerAction('a', async () => null);
    registerAction('b', async () => null);
    expect(listActions().sort()).toEqual(['a', 'b']);
  });

  it('returns undefined for unknown actions', () => {
    expect(getAction('nope')).toBeUndefined();
  });
});
