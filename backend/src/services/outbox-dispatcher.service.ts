import { ROUTING_KEYS } from "../config/messaging.js";
import type { OutboxRepository } from "../repositories/outbox.repository.js";
import type { AnyDomainEvent } from "./event-publisher.service.js";
import type { EventTransport } from "./rabbitmq-publisher.service.js";

const INTERVAL_MS = 2000;
const BATCH_SIZE = 50;

type PendingEvents = Pick<OutboxRepository, "findPending" | "markPublished" | "markFailed">;

/**
 * Despachador de la outbox (RNF-10): cada pocos segundos envía los eventos pendientes, en orden.
 * Entrega "al menos una vez": un evento puede repetirse, y los consumidores deduplican por `eventId`.
 * Supone una sola instancia de M6 corriendo.
 */
export class OutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private failing = false;

  constructor(
    private readonly outbox: PendingEvents,
    private readonly transport: EventTransport,
    private readonly intervalMs: number = INTERVAL_MS,
    private readonly batchSize: number = BATCH_SIZE
  ) {}

  /**
   * Hace una pasada y devuelve cuántos eventos envió.
   * Ante el primer fallo se detiene, para no mandar un evento posterior antes que uno anterior.
   */
  async dispatchPending(): Promise<number> {
    const pending = await this.outbox.findPending(this.batchSize);
    let sent = 0;

    for (const row of pending) {
      const event = row.envelope as unknown as AnyDomainEvent;
      try {
        await this.transport.publish(ROUTING_KEYS[event.eventType], event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.outbox.markFailed(row.id, message);
        this.reportFailure(message);
        return sent;
      }

      await this.outbox.markPublished(row.id);
      this.reportRecovery();
      sent++;
      console.log(`[EVENT PUBLISHED -> ${event.eventType}] tripId=${event.tripId} eventId=${event.eventId}`);
    }

    return sent;
  }

  /** Avisa solo cuando empieza a fallar, para no llenar la consola en cada reintento. */
  private reportFailure(message: string): void {
    if (this.failing) return;
    this.failing = true;
    console.warn(`⚠️  No se pudieron enviar eventos (${message}). Quedan pendientes y se reintenta.`);
  }

  private reportRecovery(): void {
    if (!this.failing) return;
    this.failing = false;
    console.log("✅ Se reanudó el envío de eventos.");
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  /** La pasada siguiente se programa recién cuando termina la anterior, así nunca se superponen. */
  private async tick(): Promise<void> {
    try {
      await this.dispatchPending();
    } catch (err) {
      this.reportFailure(err instanceof Error ? err.message : String(err));
    }
    if (this.running) {
      this.timer = setTimeout(() => void this.tick(), this.intervalMs);
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}