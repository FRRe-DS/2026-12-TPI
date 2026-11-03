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
  outbox: { pending: number; oldestPendingSeconds: number } | null;
}

/** Plazo máximo de cada verificación (RNF-14): 1,5 s. */
const CHECK_TIMEOUT_MS = 1500;

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
 * Readiness y diagnóstico de dependencias (RNF-14). Hoy solo PostgreSQL es real;
 * RabbitMQ y Redis figuran como NOT_CONFIGURED y la bandeja de salida (outbox) como null.
 */
export class HealthService {
  constructor(
    private readonly checkDatabase: () => Promise<unknown>,
    private readonly timeoutMs: number = CHECK_TIMEOUT_MS
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

  async getDetails(): Promise<{ statusCode: 200 | 503; report: HealthReport }> {
    const postgres = await this.checkPostgres();
    const databaseUp = postgres.status === "OK";

    const report: HealthReport = {
      status: databaseUp ? "OK" : "ERROR",
      version: process.env.APP_VERSION ?? process.env.npm_package_version ?? "1.0.0",
      upSince: UP_SINCE,
      components: {
        postgres,
        rabbitmq: { status: "NOT_CONFIGURED" },
        redis: { status: "NOT_CONFIGURED" },
      },
      outbox: null,
    };

    return { statusCode: databaseUp ? 200 : 503, report };
  }
}