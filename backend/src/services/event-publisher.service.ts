import crypto from "node:crypto";
import type { TripState } from "../../generated/prisma/client.js";

export type DomainEventType =
  | "TripCreated"
  | "DriverArrived"
  | "TripStarted"
  | "TripCompleted"
  | "TripCancelledByClient"
  | "TripCancelledByDriver";

export interface EventEnvelope<T extends DomainEventType, P> {
  eventId: string;
  eventType: T;
  eventVersion: number;
  occurredAt: string;
  tripId: string;
  correlationId?: string;
  payload: P;
}

export interface TripCreatedPayload {
  requestId: string;
  clientId: string;
  driverId: string;
  vehicleId: string;
}

export interface TripStatusPayload {
  clientId: string;
  driverId: string;
}

export interface TripCompletedPayload {
  clientId: string;
  driverId: string;
  vehicleId: string;
  distanceKm: number;
  durationMinutes: number;
}

export interface TripCancelledPayload {
  requestId: string;
  clientId: string;
  driverId: string;
  cancelledBy: "CLIENT" | "DRIVER";
  reason: string;
  previousState: TripState;
  secondsSinceCreation: number;
}

export type AnyDomainEvent =
  | EventEnvelope<"TripCreated", TripCreatedPayload>
  | EventEnvelope<"DriverArrived", TripStatusPayload>
  | EventEnvelope<"TripStarted", TripStatusPayload>
  | EventEnvelope<"TripCompleted", TripCompletedPayload>
  | EventEnvelope<"TripCancelledByClient", TripCancelledPayload>
  | EventEnvelope<"TripCancelledByDriver", TripCancelledPayload>;

/**
 * CAPA DE SERVICIO DE MENSAJERÍA / EVENTOS DE DOMINIO (RNF-03 / RNF-10)
 * Construye y publica los eventos asíncronos siguiendo el esquema `EventEnvelope` de `openapi.yaml`.
 */
export class EventPublisherService {
  private readonly history: AnyDomainEvent[] = [];

  publish<T extends DomainEventType, P>(
    eventType: T,
    tripId: string,
    payload: P,
    correlationId?: string
  ): EventEnvelope<T, P> {
    const event: EventEnvelope<T, P> = {
      eventId: crypto.randomUUID(),
      eventType,
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      tripId,
      ...(correlationId ? { correlationId } : {}),
      payload,
    };

    this.history.unshift(event as AnyDomainEvent);
    if (this.history.length > 100) {
      this.history.pop();
    }

    console.log(`[EVENT EMITTED -> ${eventType}] tripId=${tripId} eventId=${event.eventId}`);
    return event;
  }

  getPublishedEvents(): AnyDomainEvent[] {
    return this.history;
  }
}

export const eventPublisher = new EventPublisherService();
