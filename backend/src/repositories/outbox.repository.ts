import type { PrismaClient } from "../../generated/prisma/client.js";

/** Largo máximo del mensaje de error que se guarda en la fila. */
const MAX_ERROR_LENGTH = 500;

/** Resumen de los eventos sin enviar (campo `outbox` de /health/details). */
export interface OutboxStats {
  pending: number;
  oldestPendingSeconds: number;
}

/** Lectura y actualización de la bandeja de salida (tabla `outbox_events`). */
export class OutboxRepository {
  constructor(private readonly db: PrismaClient) {}

  /** Eventos sin enviar, del más viejo al más nuevo. */
  async findPending(limit: number) {
    return this.db.outboxEvent.findMany({
      where: { publishedAt: null },
      orderBy: { id: "asc" },
      take: limit,
    });
  }

  async markPublished(id: number) {
    await this.db.outboxEvent.update({
      where: { id },
      data: { publishedAt: new Date(), attempts: { increment: 1 }, lastError: null },
    });
  }

  async markFailed(id: number, error: string) {
    await this.db.outboxEvent.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastError: error.slice(0, MAX_ERROR_LENGTH) },
    });
  }

  /** Cuántos eventos esperan envío y hace cuántos segundos espera el más viejo (RNF-14). */
  async pendingStats(): Promise<OutboxStats> {
    const result = await this.db.outboxEvent.aggregate({
      where: { publishedAt: null },
      _count: { _all: true },
      _min: { createdAt: true },
    });
    const oldest = result._min.createdAt;

    return {
      pending: result._count._all,
      oldestPendingSeconds: oldest
        ? Math.max(0, Math.floor((Date.now() - oldest.getTime()) / 1000))
        : 0,
    };
  }
}