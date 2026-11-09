import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TripService } from '../src/services/trip.service';
import { ApiError } from '../src/middlewares/error.middleware'; // Ruta real del error en tu backend

describe('TripService - RF-6.7: Cancelación por Conductor', () => {
  let tripService: TripService;
  let mockTripRepository: any;
  let mockEventPublisher: any;

  beforeEach(() => {
    // Mocks para satisfacer las dependencias del constructor de TripService
    mockTripRepository = {
      findById: vi.fn(),
      transitionStateAtomic: vi.fn(),
    };
    mockEventPublisher = {
      publish: vi.fn(),
    };

    tripService = new TripService(mockTripRepository, mockEventPublisher);
  });

  it('debería permitir al conductor asignado cancelar el viaje con un motivo válido y evaluar requiresRedispatch como true', async () => {
    // Arrange
    const tripId = 'trip-123';
    const driverId = 'driver-abc';
    const auth = { sub: driverId, role: 'DRIVER' as const };
    const reason = 'VEHICLE_PROBLEM'; // Motivo válido del catálogo para conductor

    const mockTrip = {
      id: tripId,
      clientId: 'client-xyz',
      driverId: driverId,
      state: 'PENDING_ARRIVAL',
      version: 1,
      createdAt: new Date(),
      arrivedAt: null,
      requestId: 'req-1',
    };

    mockTripRepository.findById.mockResolvedValue(mockTrip);
    mockTripRepository.transitionStateAtomic.mockResolvedValue({
      ...mockTrip,
      state: 'CANCELLED',
      cancelledBy: 'DRIVER',
      cancellationReason: reason,
      requiresRedispatch: true,
    });

    // Act
    const result = await tripService.cancelTrip(tripId, { reason }, auth, 'corr-1');

    // Assert: Verificamos valores exactos (sin expect.any)
    expect(result).toBeDefined();
    expect(result.state).toBe('CANCELLED');
    expect(result.cancelledBy).toBe('DRIVER');
    expect(result.cancellationReason).toBe(reason);
    expect(result.requiresRedispatch).toBe(true);
  });

  it('debería rechazar con 403 FORBIDDEN si un conductor diferente intenta cancelar el viaje', async () => {
    const tripId = 'trip-123';
    const auth = { sub: 'driver-intruso-999', role: 'DRIVER' as const }; // No coincide con el driverId del viaje
    const reason = 'VEHICLE_PROBLEM';

    const mockTrip = {
      id: tripId,
      clientId: 'client-xyz',
      driverId: 'driver-abc', // Asignado a otro conductor
      state: 'PENDING_ARRIVAL',
      version: 1,
      createdAt: new Date(),
      arrivedAt: null,
    };

    mockTripRepository.findById.mockResolvedValue(mockTrip);

    // Act & Assert
    await expect(
      tripService.cancelTrip(tripId, { reason }, auth, 'corr-1')
    ).rejects.toSatisfy((error: any) => {
      expect(error).toBeInstanceOf(ApiError);
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('FORBIDDEN');
      return true;
    });
  });

it('debería rechazar con 409 si el estado no permite la transición por reglas de máquina de estados', async () => {
    const tripId = 'trip-456';
    const driverId = 'driver-abc';
    const auth = { sub: driverId, role: 'DRIVER' as const };
    const reason = 'VEHICLE_PROBLEM';

    const mockTrip = {
      id: tripId,
      clientId: 'client-xyz',
      driverId: driverId,
      state: 'COMPLETED', // Un viaje COMPLETED ya es terminal y no se puede cancelar, arrojando conflicto de estado
      version: 1,
      createdAt: new Date(),
      arrivedAt: new Date(),
    };

    mockTripRepository.findById.mockResolvedValue(mockTrip);

    await expect(
      tripService.cancelTrip(tripId, { reason }, auth, 'corr-1')
    ).rejects.toSatisfy((error: any) => {
      expect(error).toBeInstanceOf(ApiError);
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe('INVALID_STATE_TRANSITION');
      return true;
    });
  });
  
  it('debería rechazar con 422 si el conductor utiliza un motivo que no le corresponde', async () => {
    const tripId = 'trip-123';
    const driverId = 'driver-abc';
    const auth = { sub: driverId, role: 'DRIVER' as const };
    const invalidReasonForDriver = 'CHANGE_OF_PLANS'; // Motivo exclusivo de pasajero

    const mockTrip = {
      id: tripId,
      clientId: 'client-xyz',
      driverId: driverId,
      state: 'PENDING_ARRIVAL',
      version: 1,
      createdAt: new Date(),
      arrivedAt: null,
    };

    mockTripRepository.findById.mockResolvedValue(mockTrip);

    await expect(
      tripService.cancelTrip(tripId, { reason: invalidReasonForDriver as any }, auth, 'corr-1')
    ).rejects.toSatisfy((error: any) => {
      expect(error).toBeInstanceOf(ApiError);
      expect(error.statusCode).toBe(422);
      expect(error.code).toBe('REASON_NOT_ALLOWED');
      return true;
    });
  });
});