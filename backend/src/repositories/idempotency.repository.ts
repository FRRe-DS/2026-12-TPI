import type { PrismaClient } from "../../generated/prisma/client.js";

/** Fila de `idempotency_keys` tal como la necesita el servicio. */
export interface IdempotencyRecord {
  id: string;
  fingerprint: string;
  responseStatus: number | null;
  responseBody: unknown;
  responseEtag: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface StoredResponse {
  status: number;
  body: unknown;
  etag: string;
}

/** Lo que el servicio de idempotencia necesita de la base (se reemplaza por una versión en memoria en los tests). */
export interface IdempotencyStore {
  tryClaim(actorId: string, key: string, fingerprint: string, expiresAt: Date): Promise<boolean>;
  find(actorId: string, key: string): Promise<IdempotencyRecord | null>;
  complete(actorId: string, key: string, response: StoredResponse): Promise<void>;
  release(actorId: string, key: string): Promise<void>;
  deleteById(id: string): Promise<void>;
  deleteExpired(now: Date): Promise<void>;
}

/**
 * CAPA DE ACCESO A DATOS de `Idempotency-Key` (RNF-09). Persiste en PostgreSQL.
 */
export class IdempotencyRepository implements IdempotencyStore {
  constructor(private readonly db: PrismaClient) {}

  /** Reserva la clave. Devuelve true si la reservó este pedido, false si ya existía (INSERT ... ON CONFLICT DO NOTHING). */
  async tryClaim(actorId: string, key: string, fingerprint: string, expiresAt: Date): Promise<boolean> {
    const result = await this.db.idempotencyKey.createMany({
      data: [{ actorId, key, fingerprint, expiresAt }],
      skipDuplicates: true,
    });
    return result.count === 1;
  }

  async find(actorId: string, key: string): Promise<IdempotencyRecord | null> {
    return this.db.idempotencyKey.findUnique({ where: { actorId_key: { actorId, key } } });
  }

  async complete(actorId: string, key: string, response: StoredResponse): Promise<void> {
    await this.db.idempotencyKey.update({
      where: { actorId_key: { actorId, key } },
      data: {
        responseStatus: response.status,
        responseBody: response.body as any,
        responseEtag: response.etag,
      },
    });
  }

  async release(actorId: string, key: string): Promise<void> {
    await this.db.idempotencyKey.deleteMany({ where: { actorId, key } });
  }

  async deleteById(id: string): Promise<void> {
    await this.db.idempotencyKey.deleteMany({ where: { id } });
  }

  async deleteExpired(now: Date): Promise<void> {
    await this.db.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } });
  }
}