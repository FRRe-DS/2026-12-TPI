import type { Trip, TripState, VehicleType, ActorRole, CancellationReason } from "../../generated/prisma/client.js";
/** Cierre del viaje: schema `Closure` del contrato. */
export interface ClosureResponse {
  distanceKm: number;
  durationSeconds: number;
  finalLatitude?: number;
  finalLongitude?: number;
}
/** Cancelación del viaje: schema `Cancellation` del contrato. */
export interface CancellationResponse {
  cancelledBy: Exclude<ActorRole, "SYSTEM">;
  reason: CancellationReason;
  detail?: string;
  previousState: TripState;
  requiresRedispatch: boolean;
}

/**
 * Forma pública del viaje: lo que declara el schema `Trip` de openapi.yaml.
 * Si un campo no está acá, no sale en la respuesta, aunque exista en la tabla.
 * Las direcciones son opcionales en el contrato (no admiten null): se omiten si no hay valor.
 */
export interface TripResponse {
  id: string;
  requestId: string;
  reservationId: string | null;
  clientId: string;
  driverId: string;
  vehicleId: string;
  vehicleType: VehicleType;
  originLatitude: number;
  originLongitude: number;
  destinationLatitude: number;
  destinationLongitude: number;
  originAddress?: string;
  destinationAddress?: string;
  state: TripState;
  version: number;
  createdAt: string;
  updatedAt: string;
  arrivedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  distanceKm: number | null;
  durationMinutes: number | null;
  closure: ClosureResponse | null;
  cancellation: CancellationResponse | null;
}

/** Las fechas de Prisma son `Date`; el contrato pide texto ISO 8601. */
function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** `closure` solo existe cuando el viaje está COMPLETED (schema `Closure`). */
function toClosure(trip: Trip): ClosureResponse | null {
  if (trip.state !== "COMPLETED" || trip.distanceKm === null || trip.durationSeconds === null) {
    return null;
  }
  return {
    distanceKm: trip.distanceKm,
    durationSeconds: trip.durationSeconds,
    ...(trip.finalLatitude !== null ? { finalLatitude: trip.finalLatitude } : {}),
    ...(trip.finalLongitude !== null ? { finalLongitude: trip.finalLongitude } : {}),
  };
}

/** `cancellation` solo existe cuando el viaje está CANCELLED (schema `Cancellation`). */
function toCancellation(trip: Trip): CancellationResponse | null {
  if (
    trip.state !== "CANCELLED" ||
    !trip.cancelledBy ||
    trip.cancelledBy === "SYSTEM" ||
    !trip.cancellationReason ||
    !trip.cancelledFromState ||
    trip.requiresRedispatch === null
  ) {
    return null;
  }
  return {
    cancelledBy: trip.cancelledBy,
    reason: trip.cancellationReason,
    ...(trip.cancellationDetail !== null ? { detail: trip.cancellationDetail } : {}),
    previousState: trip.cancelledFromState,
    requiresRedispatch: trip.requiresRedispatch,
  };
}

export function toTripResponse(trip: Trip): TripResponse {
  return {
    id: trip.id,
    requestId: trip.requestId,
    reservationId: trip.reservationId,
    clientId: trip.clientId,
    driverId: trip.driverId,
    vehicleId: trip.vehicleId,
    vehicleType: trip.vehicleType,
    originLatitude: trip.originLatitude,
    originLongitude: trip.originLongitude,
    destinationLatitude: trip.destinationLatitude,
    destinationLongitude: trip.destinationLongitude,
    ...(trip.originAddress !== null ? { originAddress: trip.originAddress } : {}),
    ...(trip.destinationAddress !== null ? { destinationAddress: trip.destinationAddress } : {}),
    state: trip.state,
    version: trip.version,
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
    arrivedAt: toIso(trip.arrivedAt),
    startedAt: toIso(trip.startedAt),
    completedAt: toIso(trip.completedAt),
    cancelledAt: toIso(trip.cancelledAt),
    distanceKm: trip.distanceKm,
    durationMinutes: trip.durationMinutes,
    closure: toClosure(trip),
    cancellation: toCancellation(trip),
  };
}

/** Fila que devuelve el listado: solo las columnas de `TripSummary` (sin coordenadas, RF-4.7). */
export interface TripSummaryRow {
  id: string;
  state: TripState;
  vehicleType: VehicleType;
  clientId: string;
  driverId: string;
  originAddress: string | null;
  destinationAddress: string | null;
  createdAt: Date;
  completedAt: Date | null;
  distanceKm: number | null;
  durationMinutes: number | null;
}

/** Schema `TripSummary` del contrato. */
export interface TripSummaryResponse {
  id: string;
  state: TripState;
  vehicleType: VehicleType;
  clientId: string;
  driverId: string;
  originAddress?: string;
  destinationAddress?: string;
  createdAt: string;
  completedAt: string | null;
  distanceKm: number | null;
  durationMinutes: number | null;
}

export function toTripSummary(row: TripSummaryRow): TripSummaryResponse {
  return {
    id: row.id,
    state: row.state,
    vehicleType: row.vehicleType,
    clientId: row.clientId,
    driverId: row.driverId,
    ...(row.originAddress !== null ? { originAddress: row.originAddress } : {}),
    ...(row.destinationAddress !== null ? { destinationAddress: row.destinationAddress } : {}),
    createdAt: row.createdAt.toISOString(),
    completedAt: toIso(row.completedAt),
    distanceKm: row.distanceKm,
    durationMinutes: row.durationMinutes,
  };
}