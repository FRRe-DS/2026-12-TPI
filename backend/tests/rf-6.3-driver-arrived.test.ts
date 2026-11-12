import { describe, it, expect, beforeEach, vi } from "vitest";
import { TripService } from "../src/services/trip.service.js";
import { ApiError } from "../src/middlewares/error.middleware.js";
import type { TripRepository } from "../src/repositories/trip.repository.js";
import type { EventPublisherService } from "../src/services/event-publisher.service.js";
import type { AuthContext } from "../src/middlewares/auth.middleware.js";

describe("RF-6.3: Arribo del conductor (Unitario - TripService.markDriverArrived)", () => {
  const tripId = "11111111-1111-4111-8111-111111111111";
  const driverId = "22222222-2222-4222-8222-222222222222";
  const otherDriverId = "33333333-3333-4333-8333-333333333333";
  const clientId = "44444444-4444-4444-8444-444444444444";
  const correlationId = "corr-rf-6-3";

  const authDriver: AuthContext = { sub: driverId, role: "DRIVER" };
  const authOtherDriver: AuthContext = { sub: otherDriverId, role: "DRIVER" };
  const authClient: AuthContext = { sub: clientId, role: "CLIENT" };
  const authOperator: AuthContext = { sub: "op-1", role: "OPERATOR" };
  const authSystem: AuthContext = { sub: "sys-1", role: "SYSTEM" };

  let service: TripService;
  let mockTripRepo: any;
  let mockPublisher: any;
  let baseTrip: any;

  beforeEach(() => {
    baseTrip = {
      id: tripId,
      clientId,
      driverId,
      state: "PENDING_ARRIVAL",
      version: 1,
      arrivedAt: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockTripRepo = {
      findById: vi.fn(async (id: string) => (id === tripId ? baseTrip : null)),
      transitionStateAtomic: vi.fn(async () => ({
        ...baseTrip,
        state: "DRIVER_ARRIVED",
        version: 2,
        arrivedAt: new Date(),
      })),
    };

    mockPublisher = {
      publish: vi.fn(),
    };

    service = new TripService(
      mockTripRepo as unknown as TripRepository,
      mockPublisher as unknown as EventPublisherService
    );
  });

  // 1. Camino feliz
  it("permite al conductor asignado marcar arribo, pasa a DRIVER_ARRIVED y emite evento DriverArrived", async () => {
    const resultado = await service.markDriverArrived(
      tripId,
      authDriver,
      correlationId,
      1
    );

    expect(resultado.state).toBe("DRIVER_ARRIVED");
    expect(resultado.version).toBe(2);
    expect(resultado.arrivedAt).toBeInstanceOf(Date);
    expect(mockPublisher.publish).toHaveBeenCalledWith(
      "DriverArrived",
      tripId,
      { clientId, driverId },
      correlationId
    );
  });

  // 2. Seguridad de roles (403)
  it("rechaza si el rol es CLIENT con 403 FORBIDDEN", async () => {
    await expect(
      service.markDriverArrived(tripId, authClient, correlationId)
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });

  it("rechaza si el rol es OPERATOR con 403 FORBIDDEN", async () => {
    await expect(
      service.markDriverArrived(tripId, authOperator, correlationId)
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });

  it("rechaza si el rol es SYSTEM con 403 FORBIDDEN", async () => {
    await expect(
      service.markDriverArrived(tripId, authSystem, correlationId)
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });

  it("rechaza si otro conductor intenta registrar el arribo con 403 FORBIDDEN", async () => {
    await expect(
      service.markDriverArrived(tripId, authOtherDriver, correlationId)
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });

  // 3. Viaje no encontrado (404)
  it("rechaza con 404 TRIP_NOT_FOUND si el viaje no existe", async () => {
    mockTripRepo.findById.mockResolvedValue(null);

    await expect(
      service.markDriverArrived(tripId, authDriver, correlationId)
    ).rejects.toMatchObject({ statusCode: 404, code: "TRIP_NOT_FOUND" });
  });

  // 4. Estados invalidos (409)
  it("rechaza con 409 INVALID_STATE_TRANSITION si ya estaba en DRIVER_ARRIVED", async () => {
    baseTrip.state = "DRIVER_ARRIVED";

    await expect(
      service.markDriverArrived(tripId, authDriver, correlationId)
    ).rejects.toMatchObject({ statusCode: 409, code: "INVALID_STATE_TRANSITION" });
  });

  it("rechaza con 409 INVALID_STATE_TRANSITION si ya inicio el viaje (IN_PROGRESS)", async () => {
    baseTrip.state = "IN_PROGRESS";

    await expect(
      service.markDriverArrived(tripId, authDriver, correlationId)
    ).rejects.toMatchObject({ statusCode: 409, code: "INVALID_STATE_TRANSITION" });
  });

  it("rechaza con 409 INVALID_STATE_TRANSITION si el viaje esta cancelado (CANCELLED)", async () => {
    baseTrip.state = "CANCELLED";

    await expect(
      service.markDriverArrived(tripId, authDriver, correlationId)
    ).rejects.toMatchObject({ statusCode: 409, code: "INVALID_STATE_TRANSITION" });
  });

  // 5. Concurrencia optimista (412 y 409)
  it("rechaza con 412 PRECONDITION_FAILED si la version del If-Match no coincide", async () => {
    await expect(
      service.markDriverArrived(tripId, authDriver, correlationId, 99)
    ).rejects.toMatchObject({ statusCode: 412, code: "PRECONDITION_FAILED" });
  });

  it("rechaza con 409 CONCURRENCY_CONFLICT si hubo modificacion concurrente en BD", async () => {
    mockTripRepo.transitionStateAtomic.mockResolvedValue(null);

    await expect(
      service.markDriverArrived(tripId, authDriver, correlationId, 1)
    ).rejects.toMatchObject({ statusCode: 409, code: "CONCURRENCY_CONFLICT" });
  });
});
