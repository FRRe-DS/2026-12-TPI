import type { OutboxStats } from "../repositories/outbox.repository.js";

/** Estado de un componente (schema `ComponentStatus` del contrato). */
export interface ComponentStatus {
  status: "OK" | "ERROR" | "NOT_CONFIGURED";
  latencyMs?: number;
  detail?: string;
}

/** Schema `HealthReport` del contrato. */
export interface HealthReport {
  status: "OK" | "DEGRADED" | "ERROR";
  version: string;
  upSince: string;
  components: {
    postgres: ComponentStatus;
    rabbitmq: ComponentStatus;
    redis: ComponentStatus;
  };
  outbox: OutboxStats | null;
}

/** Lo necesario para informar sobre RabbitMQ y la outbox. */
export interface MessagingChecks {
  /** Falla si el broker no responde. No se define si no hay RABBITMQ_URL. */
  checkBroker?: () => Promise<unknown>;
  outboxStats?: () => Promise<OutboxStats>;
}

/** Plazo máximo de cada verificación (RNF-14): 1,5 s. */
const CHECK_TIMEOUT_MS = 1500;

/** Si un evento espera envío más que esto, el servicio queda DEGRADED. */
const MAX_PENDING_SECONDS = 60;

/** Momento en que arrancó el proceso. */
const UP_SINCE = new Date(Date.now() - process.uptime() * 1000).toISOString();

class CheckTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CheckTimeoutError("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Readiness y diagnóstico de dependencias (RNF-14): PostgreSQL, RabbitMQ y la bandeja
 * de salida (outbox). Redis todavía no se usa y figura como NOT_CONFIGURED.
 */
export class HealthService {
  constructor(
    private readonly checkDatabase: () => Promise<unknown>,
    private readonly timeoutMs: number = CHECK_TIMEOUT_MS,
    private readonly messaging: MessagingChecks = {}
  ) {}

  private async checkPostgres(): Promise<ComponentStatus> {
    const started = Date.now();
    try {
      await withTimeout(this.checkDatabase(), this.timeoutMs);
      return { status: "OK", latencyMs: Date.now() - started };
    } catch (err) {
      const timedOut = err instanceof CheckTimeoutError;
      // El detalle real queda en el log del servidor; la respuesta nunca expone credenciales ni conexiones.
      console.error("[HEALTH] PostgreSQL no responde:", timedOut ? "timeout" : err);
      return {
        status: "ERROR",
        latencyMs: Date.now() - started,
        detail: timedOut ? `Sin respuesta en ${this.timeoutMs} ms` : "No se pudo consultar PostgreSQL",
      };
    }
  }

  private async checkRabbitMq(): Promise<ComponentStatus> {
    const checkBroker = this.messaging.checkBroker;
    if (!checkBroker) return { status: "NOT_CONFIGURED" };

    const started = Date.now();
    try {
      await withTimeout(checkBroker(), this.timeoutMs);
      return { status: "OK", latencyMs: Date.now() - started };
    } catch (err) {
      console.error("[HEALTH] RabbitMQ no responde:", err instanceof Error ? err.message : err);
      return { status: "ERROR", latencyMs: Date.now() - started };
    }
  }

  /** Devuelve null si no se pudo consultar. */
  private async checkOutbox(): Promise<OutboxStats | null> {
    const outboxStats = this.messaging.outboxStats;
    if (!outboxStats) return null;

    try {
      return await withTimeout(outboxStats(), this.timeoutMs);
    } catch (err) {
      console.error("[HEALTH] No se pudo consultar la outbox:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  async getDetails(): Promise<{ statusCode: 200 | 503; report: HealthReport }> {
    const [postgres, rabbitmq] = await Promise.all([this.checkPostgres(), this.checkRabbitMq()]);
    const databaseUp = postgres.status === "OK";
    const outbox = databaseUp ? await this.checkOutbox() : null;

    const delayed = outbox !== null && outbox.oldestPendingSeconds > MAX_PENDING_SECONDS;
    const degraded = rabbitmq.status === "ERROR" || delayed;

    const report: HealthReport = {
      status: !databaseUp ? "ERROR" : degraded ? "DEGRADED" : "OK",
      version: process.env.APP_VERSION ?? process.env.npm_package_version ?? "1.0.0",
      upSince: UP_SINCE,
      components: {
        postgres,
        rabbitmq,
        redis: { status: "NOT_CONFIGURED" },
      },
      outbox,
    };

    return { statusCode: databaseUp ? 200 : 503, report };
  }
}