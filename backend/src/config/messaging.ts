import type { DomainEventType } from "../services/event-publisher.service.js";

/** Exchange de tipo topic donde M6 publica sus eventos (convención del contrato, RNF-10). */
export const DEFAULT_EXCHANGE = "m6.events";

/** Routing key de cada evento. Están en un solo lugar para poder cambiarlas fácil si se acuerdan otras. */
export const ROUTING_KEYS: Record<DomainEventType, string> = {
  TripCreated: "trip.created",
  DriverArrived: "trip.arrived",
  TripStarted: "trip.started",
  TripCompleted: "trip.completed",
  TripCancelled: "trip.cancelled",
};

export interface MessagingConfig {
  url: string;
  exchange: string;
}

/**
 * Lee la configuración de RabbitMQ del entorno (RNF-06).
 * Sin `RABBITMQ_URL` devuelve undefined: los eventos quedan pendientes en la outbox.
 */
export function loadMessagingConfig(env: NodeJS.ProcessEnv = process.env): MessagingConfig | undefined {
  const url = env.RABBITMQ_URL?.trim();
  if (!url) return undefined;

  return { url, exchange: env.RABBITMQ_EXCHANGE?.trim() || DEFAULT_EXCHANGE };
}