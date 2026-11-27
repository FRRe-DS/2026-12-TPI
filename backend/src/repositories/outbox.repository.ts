import type { PrismaClient } from "../../generated/prisma/client.js";

/** Largo máximo del mensaje de error que se guarda en la fila. */
const MAX_ERROR_LENGTH = 500;

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
}