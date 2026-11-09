import { describe, it, expect, vi, beforeEach } from "vitest";
import { TripService } from "../src/services/trip.service.js";
import { TripState } from "../src/domain/trip-state-machine.js";
import { ApiError } from "../src/middlewares/error.middleware.js";

describe("TripService - RF-6.7: Cancelación por Conductor", () => {
  let tripService: TripService;
  let mockTripRepository: any;
  let mockEventPublisher: any;

  beforeEach(() => {
    mockTripRepository = {
      findById: vi.fn(),
      transitionStateAtomic: vi.fn(),
    };
    mockEventPublisher = {
      publish: vi.fn(),
    };
    tripService = new TripService(mockTripRepository, mockEventPublisher);
  });

  it("debería permitir al conductor asignado cancelar el viaje con un motivo justificado y evaluar requiresRedispatch", async () => {
    const mockTrip = {
      id: "trip-test-123",
      clientId: "client-abc",
      driverId: "driver-xyz",
      state: TripState.PENDING_ARRIVAL,
      version: 1,
      createdAt: new Date(),
      arrivedAt: null,
    };

    mockTripRepository.findById.mockResolvedValue(mockTrip);
    mockTripRepository.transitionStateAtomic.mockResolvedValue({
      ...mockTrip,
      state: TripState.CANCELLED,
      cancelledBy: "DRIVER",
      requiresRedispatch: true,
    });

    const authContext = { role: "DRIVER" as const, sub: "driver-xyz" };
    // Utiliza un motivo válido para conductor según tus reglas de dominio (ej: vehículo roto, emergencia, etc.)
    const cancellationInput = { reason: "VEHICLE_PROBLEM" as any, detail: "Falla mecánica imprevista" };

    const result = await tripService.cancelTrip(
      "trip-test-123",
      cancellationInput,
      authContext,
      "corr-id-001"
    );

    // Verificar que la actualización atómica guardó la cancelación por el conductor y el flag de redispatch
    expect(mockTripRepository.transitionStateAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        tripId: "trip-test-123",
        cancelledBy: "DRIVER",
        actorRole: "DRIVER",
        requiresRedispatch: expect.any(Boolean),
      })
    );

    // Verificar que se emitió el evento TripCancelled hacia el broker
    expect(mockEventPublisher.publish).toHaveBeenCalledWith(
      "TripCancelled",
      "trip-test-123",
      expect.objectContaining({
        cancelledBy: "DRIVER",
        requiresRedispatch: expect.any(Boolean),
      }),
      "corr-id-001"
    );

    expect(result.state).toBe(TripState.CANCELLED);
  });

  it("debería rechazar con 403 si un conductor diferente intenta cancelar un viaje que no le pertenece", async () => {
    const mockTrip = {
      id: "trip-test-123",
      clientId: "client-abc",
      driverId: "driver-xyz", // El conductor asignado legítimo
      state: TripState.PENDING_ARRIVAL,
      version: 1,
    };

    mockTripRepository.findById.mockResolvedValue(mockTrip);

    // Un conductor ajeno intenta hacer la cancelación
    const unauthorizedAuth = { role: "DRIVER" as const, sub: "other-driver-999" };

    await expect(
      tripService.cancelTrip(
        "trip-test-123",
        { reason: "DRIVER_VEHICLE_ISSUE" as any },
        unauthorizedAuth,
        "corr-id-002"
      )
    ).rejects.toThrow(ApiError);

    // Asegurarnos de que el repositorio nunca intentó mutar el estado
    expect(mockTripRepository.transitionStateAtomic).not.toHaveBeenCalled();
  });
});