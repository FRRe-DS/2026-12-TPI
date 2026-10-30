import type { Trip, TripState, VehicleType, ActorRole } from "../../generated/prisma/client.js";

/**
 * Forma pública del viaje: lo que declara el contrato`openapi.yaml` en el schema `Trip`.
 * Si un campo no está acá, no sale en la respuesta, aunque exista en la tabla.
 */
export interface TripResponse {
  id: string;
  requestId: string;
  clientId: string;
  driverId: string;
  vehicleId: string;
  vehicleType: VehicleType;
  reservationId: string | null;
  originAddress: string | null;
  destinationAddress: string | null;
  originLatitude: number;
  originLongitude: number;
  destinationLatitude: number;
  destinationLongitude: number;
  state: TripState;
  version: number;
  arrivedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: ActorRole | null;
  distanceKm: number | null;
  durationMinutes: number | null;
  durationSeconds: number | null;
  finalLatitude: number | null;
  finalLongitude: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Las fechas de Prisma son `Date`; el contrato pide texto ISO 8601. */
function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function toTripResponse(trip: Trip): TripResponse {
  return {
    id: trip.id,
    requestId: trip.requestId,
    clientId: trip.clientId,
    driverId: trip.driverId,
    vehicleId: trip.vehicleId,
    vehicleType: trip.vehicleType,
    reservationId: trip.reservationId,
    originAddress: trip.originAddress,
    destinationAddress: trip.destinationAddress,
    originLatitude: trip.originLatitude,
    originLongitude: trip.originLongitude,
    destinationLatitude: trip.destinationLatitude,
    destinationLongitude: trip.destinationLongitude,
    state: trip.state,
    version: trip.version,
    arrivedAt: toIso(trip.arrivedAt),
    startedAt: toIso(trip.startedAt),
    completedAt: toIso(trip.completedAt),
    cancelledAt: toIso(trip.cancelledAt),
    cancelledBy: trip.cancelledBy,
    distanceKm: trip.distanceKm,
    durationMinutes: trip.durationMinutes,
    durationSeconds: trip.durationSeconds,
    finalLatitude: trip.finalLatitude,
    finalLongitude: trip.finalLongitude,
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
  };
}