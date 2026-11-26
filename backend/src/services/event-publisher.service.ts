import crypto from "node:crypto";
import type { TripState } from "../../generated/prisma/client.js";
import type { Trip, VehicleType } from "../../generated/prisma/client.js";
import type { ClosureResponse } from "../mappers/trip.mapper.js";

export type DomainEventType =
  | "TripCreated"
  | "DriverArrived"
  | "TripStarted"
  | "TripCompleted"
  | "TripCancelled";

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
  vehicleType: VehicleType;
  reservationId: string | null;
  originLatitude: number;
  originLongitude: number;
  destinationLatitude: number;
  destinationLongitude: number;
  originAddress?: string;
  destinationAddress?: string;
}

export interface TripStatusPayload {
  clientId: string;
  driverId: string;
}

export interface TripCompletedPayload {
  clientId: string;
  driverId: string;
  vehicleId: string;
  vehicleType: VehicleType;
  closure: ClosureResponse;
  startedAt: string;
  completedAt: string;
  durationMinutes: number;
}

export interface TripCancelledPayload {
  requestId: string;
  clientId: string;
  driverId: string;
  cancelledBy: "CLIENT" | "DRIVER" | "OPERATOR";
  reason: string;
  detail?: string;
  previousState: TripState;
  requiresRedispatch: boolean;
  secondsSinceCreation: number;
}

export type AnyDomainEvent =
  | EventEnvelope<"TripCreated", TripCreatedPayload>
  | EventEnvelope<"DriverArrived", TripStatusPayload>
  | EventEnvelope<"TripStarted", TripStatusPayload>
  | EventEnvelope<"TripCompleted", TripCompletedPayload>
  | EventEnvelope<"TripCancelled", TripCancelledPayload>;

/** Arma el payload de TripCreated a partir del viaje recién creado. Las direcciones se omiten si no hay. */
export function buildTripCreatedPayload(
  trip: Pick<
    Trip,
    | "requestId" | "clientId" | "driverId" | "vehicleId" | "vehicleType" | "reservationId"
    | "originLatitude" | "originLongitude" | "destinationLatitude" | "destinationLongitude"
    | "originAddress" | "destinationAddress"
  >
): TripCreatedPayload {
  return {
    requestId: trip.requestId,
    clientId: trip.clientId,
    driverId: trip.driverId,
    vehicleId: trip.vehicleId,
    vehicleType: trip.vehicleType,
    reservationId: trip.reservationId,
    originLatitude: trip.originLatitude,
    originLongitude: trip.originLongitude,
    destinationLatitude: trip.destinationLatitude,
    destinationLongitude: trip.destinationLongitude,
    ...(trip.originAddress !== null ? { originAddress: trip.originAddress } : {}),
    ...(trip.destinationAddress !== null ? { destinationAddress: trip.destinationAddress } : {}),
  };
}

/** Arma el payload de TripCompleted. M7 tarifa con closure.durationSeconds; durationMinutes es solo para mostrar. */
export function buildTripCompletedPayload(input: {
  trip: Pick<Trip, "clientId" | "driverId" | "vehicleId" | "vehicleType">;
  startedAt: Date;
  completedAt: Date;
  distanceKm: number;
  durationSeconds: number;
  durationMinutes: number;
  finalLatitude?: number;
  finalLongitude?: number;
}): TripCompletedPayload {
  return {
    clientId: input.trip.clientId,
    driverId: input.trip.driverId,
    vehicleId: input.trip.vehicleId,
    vehicleType: input.trip.vehicleType,
    closure: {
      distanceKm: input.distanceKm,
      durationSeconds: input.durationSeconds,
      ...(input.finalLatitude !== undefined ? { finalLatitude: input.finalLatitude } : {}),
      ...(input.finalLongitude !== undefined ? { finalLongitude: input.finalLongitude } : {}),
    },
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    durationMinutes: input.durationMinutes,
  };
}

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
