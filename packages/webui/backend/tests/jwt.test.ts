import { describe, expect, it } from 'vitest';
import { signJwt, verifyJwt } from '../src/auth/jwt';

describe('JWT sign + verify', () => {
  it('round-trips a valid payload', () => {
    const token = signJwt({ sub: 'u', exp: nowSec() + 60 }, 'secret');
    const payload = verifyJwt(token, 'secret');
    expect(payload).toMatchObject({ sub: 'u' });
  });

  it('rejects a wrong secret', () => {
    const token = signJwt({ sub: 'u', exp: nowSec() + 60 }, 'right');
    expect(verifyJwt(token, 'wrong')).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signJwt({ sub: 'u', exp: nowSec() - 10 }, 'secret');
    expect(verifyJwt(token, 'secret')).toBeNull();
  });

  it('returns null for malformed tokens', () => {
    expect(verifyJwt('not.a.jwt', 'secret')).toBeNull();
    expect(verifyJwt('one.two', 'secret')).toBeNull();
    expect(verifyJwt('', 'secret')).toBeNull();
  });
});

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
