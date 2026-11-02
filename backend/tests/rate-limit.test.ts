import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, resetRateLimits } from '../src/middlewares/rate-limit.middleware.js';

describe('Límite de pedidos por minuto', () => {
  beforeEach(() => resetRateLimits());
  const t0 = 1_000_000;

  it('permite hasta el límite y rechaza el siguiente', () => {
    expect(checkRateLimit('u1', 2, t0)).toMatchObject({ allowed: true, remaining: 1 });
    expect(checkRateLimit('u1', 2, t0)).toMatchObject({ allowed: true, remaining: 0 });
    expect(checkRateLimit('u1', 2, t0)).toMatchObject({ allowed: false, remaining: 0 });
  });

  it('cuenta a cada usuario por separado', () => {
    checkRateLimit('u1', 1, t0);
    expect(checkRateLimit('u1', 1, t0).allowed).toBe(false);
    expect(checkRateLimit('u2', 1, t0).allowed).toBe(true);
  });

  it('informa los segundos hasta el reinicio y vuelve a permitir pasado el minuto', () => {
    checkRateLimit('u1', 1, t0);
    const blocked = checkRateLimit('u1', 1, t0 + 20_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.resetSeconds).toBe(40);
    expect(checkRateLimit('u1', 1, t0 + 60_001).allowed).toBe(true);
  });
});