import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import type { TripAction } from "../../generated/prisma/client.js";

const meter = metrics.getMeter("m6-viajes");
const tracer = trace.getTracer("m6-viajes");

const transitions = meter.createCounter("m6_trip_transitions", {
  description: "Transiciones de viaje confirmadas en PostgreSQL",
});
const cancellations = meter.createCounter("m6_trip_cancellations", {
  description: "Cancelaciones de viaje confirmadas en PostgreSQL",
});
const duration = meter.createHistogram("m6_transition_duration", {
  description: "Duracion de las operaciones del ciclo de vida",
  unit: "s",
  advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] },
});

export function recordTransition(from: string, to: string, actor: string, action: TripAction, reason?: string | null): void {
  transitions.add(1, { from, to, actor });
  if (action === "CANCEL") {
    cancellations.add(1, { actor, reason: reason ?? "UNKNOWN" });
  }
}

export function measureOperation<T>(action: TripAction, operation: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(`trip.${action}`, { attributes: { "trip.action": action } }, async (span) => {
    const start = process.hrtime.bigint();
    let resultado = "ok";
    try {
      return await operation();
    } catch (error) {
      resultado = "error";
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      duration.record(Number(process.hrtime.bigint() - start) / 1e9, { action, resultado });
      span.end();
    }
  });
}

export function withSpan<T>(name: string, operation: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      return await operation();
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
