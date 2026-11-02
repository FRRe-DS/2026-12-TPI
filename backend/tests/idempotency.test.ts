import { describe, it, expect } from 'vitest';
import {
  IdempotencyService,
  fingerprintOf,
  parseIdempotencyKey,
} from '../src/services/idempotency.service.js';
import type { IdempotencyRecord, IdempotencyStore } from '../src/repositories/idempotency.repository.js';

/** Versión en memoria del repositorio, para probar la lógica sin base de datos. */
class MemoryStore implements IdempotencyStore {
  rows = new Map<string, IdempotencyRecord & { actorId: string; key: string }>();
  private seq = 0;
  constructor(private readonly now: () => number) {}

  private k(actorId: string, key: string) {
    return `${actorId}|${key}`;
  }
  async tryClaim(actorId: string, key: string, fingerprint: string, expiresAt: Date) {
    if (this.rows.has(this.k(actorId, key))) return false;
    this.rows.set(this.k(actorId, key), {
      id: `row-${++this.seq}`, actorId, key, fingerprint, expiresAt,
      responseStatus: null, responseBody: null, responseEtag: null, createdAt: new Date(this.now()),
    });
    return true;
  }
  async find(actorId: string, key: string) {
    return this.rows.get(this.k(actorId, key)) ?? null;
  }
  async complete(actorId: string, key: string, r: { status: number; body: unknown; etag: string }) {
    const row = this.rows.get(this.k(actorId, key))!;
    row.responseStatus = r.status;
    row.responseBody = r.body;
    row.responseEtag = r.etag;
  }
  async release(actorId: string, key: string) {
    this.rows.delete(this.k(actorId, key));
  }
  async deleteById(id: string) {
    for (const [k, v] of this.rows) if (v.id === id) this.rows.delete(k);
  }
  async deleteExpired() {}
}

function catchError(fn: () => void): any {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

const ok = (n: number) => ({ status: 200, body: { n }, etag: `"${n}"` });

function setup() {
  let t = 1_000_000;
  const clock = { advance: (ms: number) => (t += ms), now: () => t };
  const store = new MemoryStore(clock.now);
  const service = new IdempotencyService(store, clock.now);
  return { clock, store, service };
}

describe('Idempotency-Key: servicio', () => {
  it('sin clave ejecuta siempre y no guarda nada', async () => {
    const { service, store } = setup();
    let calls = 0;
    const run = () =>
      service.run({ key: undefined, actorId: 'a', fingerprint: 'f', execute: async () => ok(++calls) });
    await run();
    await run();
    expect(calls).toBe(2);
    expect(store.rows.size).toBe(0);
  });

  it('repetir la clave devuelve la respuesta original sin ejecutar de nuevo', async () => {
    const { service } = setup();
    let calls = 0;
    const run = () =>
      service.run({ key: 'k1', actorId: 'a', fingerprint: 'f', execute: async () => ok(++calls) });
    const first = await run();
    const second = await run();
    expect(calls).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({ replayed: true, status: 200, body: { n: 1 }, etag: '"1"' });
  });

  it('la misma clave con otra huella es 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const { service } = setup();
    await service.run({ key: 'k1', actorId: 'a', fingerprint: 'f1', execute: async () => ok(1) });
    await expect(
      service.run({ key: 'k1', actorId: 'a', fingerprint: 'f2', execute: async () => ok(2) })
    ).rejects.toMatchObject({ statusCode: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('si el primer pedido sigue en proceso, el segundo es 409 REQUEST_IN_PROGRESS', async () => {
    const { service } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = service.run({
      key: 'k1', actorId: 'a', fingerprint: 'f',
      execute: async () => { await gate; return ok(1); },
    });
    await new Promise((r) => setTimeout(r, 0));
    await expect(
      service.run({ key: 'k1', actorId: 'a', fingerprint: 'f', execute: async () => ok(2) })
    ).rejects.toMatchObject({ statusCode: 409, code: 'REQUEST_IN_PROGRESS' });
    release();
    await first;
  });

  it('los errores no se guardan: se puede reintentar con la misma clave', async () => {
    const { service, store } = setup();
    await expect(
      service.run({ key: 'k1', actorId: 'a', fingerprint: 'f', execute: async () => { throw new Error('boom'); } })
    ).rejects.toThrow('boom');
    expect(store.rows.size).toBe(0);
    const retry = await service.run({ key: 'k1', actorId: 'a', fingerprint: 'f', execute: async () => ok(1) });
    expect(retry.replayed).toBe(false);
  });

  it('cada usuario tiene sus propias claves', async () => {
    const { service } = setup();
    let calls = 0;
    const run = (actorId: string) =>
      service.run({ key: 'k1', actorId, fingerprint: 'f', execute: async () => ok(++calls) });
    await run('a');
    const other = await run('b');
    expect(calls).toBe(2);
    expect(other.replayed).toBe(false);
  });

  it('una clave pasadas las 24 horas se puede usar de nuevo', async () => {
    const { service, clock } = setup();
    let calls = 0;
    const run = () =>
      service.run({ key: 'k1', actorId: 'a', fingerprint: 'f', execute: async () => ok(++calls) });
    await run();
    clock.advance(25 * 60 * 60 * 1000);
    const again = await run();
    expect(calls).toBe(2);
    expect(again.replayed).toBe(false);
  });

  it('un pedido colgado más de 60 segundos se puede reservar de nuevo', async () => {
    const { service, store, clock } = setup();
    await store.tryClaim('a', 'k1', 'f', new Date(clock.now() + 1000 * 60 * 60));
    clock.advance(61_000);
    const result = await service.run({ key: 'k1', actorId: 'a', fingerprint: 'f', execute: async () => ok(1) });
    expect(result.replayed).toBe(false);
  });
});

describe('Idempotency-Key: header y huella', () => {
  it('sin header no hay clave', () => {
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
  });

  it('acepta una clave de 1 a 200 caracteres', () => {
    expect(parseIdempotencyKey(' abc ')).toBe('abc');
    expect(parseIdempotencyKey('a'.repeat(200))).toHaveLength(200);
  });

  it('una clave vacía o de más de 200 caracteres es 400 VALIDATION', () => {
    expect(catchError(() => parseIdempotencyKey('   '))).toMatchObject({ statusCode: 400, code: 'VALIDATION' });
    expect(catchError(() => parseIdempotencyKey('a'.repeat(201)))).toMatchObject({ statusCode: 400 });
  });

  it('el orden de los campos del cuerpo no cambia la huella', () => {
    const a = fingerprintOf('POST', '/trips/1/complete', { distanceKm: 6.4, finalLatitude: -27.4 });
    const b = fingerprintOf('POST', '/trips/1/complete', { finalLatitude: -27.4, distanceKm: 6.4 });
    expect(a).toBe(b);
  });

  it('otra ruta o otro cuerpo cambian la huella', () => {
    const base = fingerprintOf('POST', '/trips/1/complete', { distanceKm: 6.4 });
    expect(fingerprintOf('POST', '/trips/2/complete', { distanceKm: 6.4 })).not.toBe(base);
    expect(fingerprintOf('POST', '/trips/1/complete', { distanceKm: 7 })).not.toBe(base);
  });
});