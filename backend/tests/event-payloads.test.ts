import { describe, it, expect } from 'vitest';
import {
  buildTripCreatedPayload,
  buildTripCompletedPayload,
} from '../src/services/event-publisher.service.js';

const baseTrip = {
  requestId: 'r1111111-1111-4111-8111-111111111111',
  clientId: 'c1111111-1111-4111-8111-111111111111',
  driverId: 'd1111111-1111-4111-8111-111111111111',
  vehicleId: 'a1111111-1111-4111-8111-111111111111',
  vehicleType: 'AUTO' as const,
  reservationId: null,
  originLatitude: -27.45,
  originLongitude: -58.98,
  destinationLatitude: -27.47,
  destinationLongitude: -58.83,
  originAddress: null,
  destinationAddress: null,
};

describe('Payload de TripCreated', () => {
  it('incluye vehicleType, coordenadas y reservationId null', () => {
    const p = buildTripCreatedPayload(baseTrip);
    expect(p.vehicleType).toBe('AUTO');
    expect(p.reservationId).toBeNull();
    expect(p.originLatitude).toBe(-27.45);
  });

  it('omite las direcciones cuando no hay y las incluye cuando hay', () => {
    expect(buildTripCreatedPayload(baseTrip)).not.toHaveProperty('originAddress');
    const p = buildTripCreatedPayload({ ...baseTrip, originAddress: 'Av. Sarmiento 100' });
    expect(p.originAddress).toBe('Av. Sarmiento 100');
    expect(p).not.toHaveProperty('destinationAddress');
  });
});

describe('Payload de TripCompleted', () => {
  const startedAt = new Date('2026-11-02T12:00:00Z');
  const completedAt = new Date('2026-11-02T12:10:30Z');

  it('lleva closure con distancia y duración exacta, y vehicleType', () => {
    const p = buildTripCompletedPayload({
      trip: baseTrip,
      startedAt,
      completedAt,
      distanceKm: 6.4,
      durationSeconds: 630,
      durationMinutes: 11,
    });
    expect(p.vehicleType).toBe('AUTO');
    expect(p.closure).toEqual({ distanceKm: 6.4, durationSeconds: 630 });
    expect(p.durationMinutes).toBe(11);
    expect(p.startedAt).toBe('2026-11-02T12:00:00.000Z');
    expect(p.completedAt).toBe('2026-11-02T12:10:30.000Z');
  });

  it('incluye la posición final dentro de closure si se informó', () => {
    const p = buildTripCompletedPayload({
      trip: baseTrip,
      startedAt,
      completedAt,
      distanceKm: 1,
      durationSeconds: 60,
      durationMinutes: 1,
      finalLatitude: -27.5,
      finalLongitude: -58.9,
    });
    expect(p.closure.finalLatitude).toBe(-27.5);
    expect(p.closure.finalLongitude).toBe(-58.9);
  });
});