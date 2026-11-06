import { describe, it, expect, afterEach } from 'vitest';
import { authenticateMiddleware, createDemoJwt } from '../src/middlewares/auth.middleware.js';

const req = (headers: Record<string, string>) => ({ headers }) as any;
const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (payload: Record<string, unknown>) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.firma`;
const nowSec = () => Math.floor(Date.now() / 1000);
const DRIVER_ID = 'd1111111-1111-4111-8111-111111111111';

function catchError(fn: () => void): any {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

afterEach(() => {
  delete process.env.ENABLE_DEMO_AUTH;
});

describe('Autenticación: atajos de demo', () => {
  it('sin ENABLE_DEMO_AUTH el token "SYSTEM" es 401', () => {
    const err = catchError(() => authenticateMiddleware(req({ authorization: 'Bearer SYSTEM' })));
    expect(err).toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
  });

  it('sin ENABLE_DEMO_AUTH el token "DRIVER:<id>" es 401', () => {
    const err = catchError(() => authenticateMiddleware(req({ authorization: `Bearer DRIVER:${DRIVER_ID}` })));
    expect(err).toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
  });

  it('sin ENABLE_DEMO_AUTH el header x-actor-role es 401', () => {
    const err = catchError(() => authenticateMiddleware(req({ 'x-actor-role': 'SYSTEM' })));
    expect(err).toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
  });

  it('ENABLE_DEMO_AUTH=false tampoco los habilita', () => {
    process.env.ENABLE_DEMO_AUTH = 'false';
    const err = catchError(() => authenticateMiddleware(req({ authorization: 'Bearer SYSTEM' })));
    expect(err).toMatchObject({ statusCode: 401 });
  });

  it('con ENABLE_DEMO_AUTH=true funcionan los tres atajos', () => {
    process.env.ENABLE_DEMO_AUTH = 'true';
    expect(authenticateMiddleware(req({ authorization: 'Bearer SYSTEM' }))).toMatchObject({ role: 'SYSTEM' });
    expect(authenticateMiddleware(req({ authorization: `Bearer DRIVER:${DRIVER_ID}` }))).toEqual({
      sub: DRIVER_ID,
      role: 'DRIVER',
    });
    expect(
      authenticateMiddleware(req({ 'x-actor-role': 'CLIENT', 'x-actor-id': 'c-1' }))
    ).toEqual({ sub: 'c-1', role: 'CLIENT' });
  });
});

describe('Autenticación: vencimiento del JWT (exp)', () => {
  it('acepta un JWT con exp en el futuro', () => {
    const token = jwt({ sub: DRIVER_ID, role: 'DRIVER', exp: nowSec() + 3600 });
    expect(authenticateMiddleware(req({ authorization: `Bearer ${token}` }))).toEqual({
      sub: DRIVER_ID,
      role: 'DRIVER',
    });
  });

  it('rechaza un JWT sin exp con 401', () => {
    const token = jwt({ sub: DRIVER_ID, role: 'DRIVER' });
    const err = catchError(() => authenticateMiddleware(req({ authorization: `Bearer ${token}` })));
    expect(err).toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
    expect(err.message).toContain('exp');
  });

  it('rechaza un JWT vencido con 401', () => {
    const token = jwt({ sub: DRIVER_ID, role: 'DRIVER', exp: nowSec() - 10 });
    const err = catchError(() => authenticateMiddleware(req({ authorization: `Bearer ${token}` })));
    expect(err).toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
  });

  it('rechaza un exp que no es número', () => {
    const token = jwt({ sub: DRIVER_ID, role: 'DRIVER', exp: String(nowSec() + 3600) });
    const err = catchError(() => authenticateMiddleware(req({ authorization: `Bearer ${token}` })));
    expect(err).toMatchObject({ statusCode: 401 });
  });

  it('el token que genera createDemoJwt trae exp y se acepta', () => {
    const token = createDemoJwt(DRIVER_ID, 'DRIVER');
    expect(authenticateMiddleware(req({ authorization: `Bearer ${token}` }))).toEqual({
      sub: DRIVER_ID,
      role: 'DRIVER',
    });
  });
});