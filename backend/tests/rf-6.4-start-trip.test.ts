import { describe, it, expect, beforeEach, vi } from "vitest";
import { TripService } from "../src/services/trip.service.js";
import { TripRepository } from "../src/repositories/trip.repository.js";
import { EventPublisherService } from "../src/services/event-publisher.service.js";
import { ApiError } from "../src/middlewares/error.middleware.js";
import type { AuthContext } from "../src/middlewares/auth.middleware.js";

describe("RF-6.4 (Inicio validado con código QR / M8) - Pruebas Unitarias", () => {
  let tripRepoMock: any;
  let publisherMock: any;
  let tripService: TripService;

  const validDriverId = "11111111-1111-1111-1111-111111111111";
  const validClientId = "22222222-2222-2222-2222-222222222222";
  const tripId = "33333333-3333-3333-3333-333333333333";
  const correlationId = "corr-test-rf-6-4";

  const authDriver: AuthContext = {
    sub: validDriverId,
    role: "DRIVER",
  };

  const authOtherDriver: AuthContext = {
    sub: "99999999-9999-9999-9999-999999999999",
    role: "DRIVER",
  };

  const authClient: AuthContext = {
    sub: validClientId,
    role: "CLIENT",
  };

  beforeEach(() => {
    tripRepoMock = {
      findById: vi.fn(),
      transitionStateAtomic: vi.fn(),
    };

    publisherMock = {
      publish: vi.fn(),
    };

    tripService = new TripService(
      tripRepoMock as unknown as TripRepository,
      publisherMock as unknown as EventPublisherService
    );
  });

  it("debe iniciar el viaje exitosamente (DRIVER_ARRIVED -> IN_PROGRESS) con token válido y conductor asignado", async () => {
    // Arrange
    const existingTrip = {
      id: tripId,
      clientId: validClientId,
      driverId: validDriverId,
      state: "DRIVER_ARRIVED",
      version: 2,
    };
    tripRepoMock.findById.mockResolvedValue(existingTrip);

    const updatedTrip = {
      ...existingTrip,
      state: "IN_PROGRESS",
      version: 3,
      startedAt: new Date(),
    };
    tripRepoMock.transitionStateAtomic.mockResolvedValue(updatedTrip);

    // Act
    const result = await tripService.startTrip(
      tripId,
      "valid_qr_token_abc_123",
      authDriver,
      correlationId
    );

    // Assert
    expect(result.state).toBe("IN_PROGRESS");
    expect(tripRepoMock.transitionStateAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        tripId,
        expectedFromState: "DRIVER_ARRIVED",
        targetState: "IN_PROGRESS",
        action: "START",
        actorRole: "DRIVER",
      })
    );
    expect(publisherMock.publish).toHaveBeenCalledWith(
      "TripStarted",
      tripId,
      { clientId: validClientId, driverId: validDriverId },
      correlationId
    );
  });

  it("debe rechazar con 404 TRIP_NOT_FOUND si el viaje no existe", async () => {
    // Arrange
    tripRepoMock.findById.mockResolvedValue(null);

    // Act & Assert
    await expect(
      tripService.startTrip(tripId, "token123", authDriver, correlationId)
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "TRIP_NOT_FOUND",
    });
  });

  it("debe rechazar con 403 FORBIDDEN si quien intenta iniciar no es el conductor asignado", async () => {
    // Arrange
    const existingTrip = {
      id: tripId,
      clientId: validClientId,
      driverId: validDriverId,
      state: "DRIVER_ARRIVED",
      version: 2,
    };
    tripRepoMock.findById.mockResolvedValue(existingTrip);

    // Act & Assert: Chofer distinto al asignado
    await expect(
      tripService.startTrip(tripId, "token123", authOtherDriver, correlationId)
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
    });

    // Act & Assert: El cliente intentando iniciar el viaje
    await expect(
      tripService.startTrip(tripId, "token123", authClient, correlationId)
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
    });
  });

  it("debe rechazar con 409 INVALID_STATE_TRANSITION si el viaje no está en DRIVER_ARRIVED", async () => {
    // Arrange: Viaje aún en PENDING_ARRIVAL
    const pendingTrip = {
      id: tripId,
      clientId: validClientId,
      driverId: validDriverId,
      state: "PENDING_ARRIVAL",
      version: 1,
    };
    tripRepoMock.findById.mockResolvedValue(pendingTrip);

    // Act & Assert
    await expect(
      tripService.startTrip(tripId, "token123", authDriver, correlationId)
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "INVALID_STATE_TRANSITION",
    });
  });

  it("debe rechazar con 422 INVALID_VERIFICATION_CODE si el token es inválido o expiró", async () => {
    // Arrange
    const existingTrip = {
      id: tripId,
      clientId: validClientId,
      driverId: validDriverId,
      state: "DRIVER_ARRIVED",
      version: 2,
    };
    tripRepoMock.findById.mockResolvedValue(existingTrip);

    // Act & Assert: token explícitamente inválido
    await expect(
      tripService.startTrip(tripId, "invalid", authDriver, correlationId)
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "INVALID_VERIFICATION_CODE",
    });

    // Act & Assert: token expirado
    await expect(
      tripService.startTrip(tripId, "expired", authDriver, correlationId)
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "INVALID_VERIFICATION_CODE",
    });

    // El viaje NO debe haber llamado a la persistencia atómica
    expect(tripRepoMock.transitionStateAtomic).not.toHaveBeenCalled();
  });

  it("debe rechazar con 422 INVALID_VERIFICATION_CODE si el token ya fue utilizado (ataque de repetición / deduplicación)", async () => {
    // Arrange
    const existingTrip = {
      id: tripId,
      clientId: validClientId,
      driverId: validDriverId,
      state: "DRIVER_ARRIVED",
      version: 2,
    };
    tripRepoMock.findById.mockResolvedValue(existingTrip);
    tripRepoMock.transitionStateAtomic.mockResolvedValue({
      ...existingTrip,
      state: "IN_PROGRESS",
    });

    const singleUseToken = "unique_token_to_reuse_123";

    // 1° uso: Exitoso
    await tripService.startTrip(tripId, singleUseToken, authDriver, correlationId);

    // 2° uso con el mismo token: Debe rechazar con 422
    await expect(
      tripService.startTrip(tripId, singleUseToken, authDriver, correlationId)
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "INVALID_VERIFICATION_CODE",
    });
  });

  it("debe responder con 503 DEPENDENCY_UNAVAILABLE y Retry-After si el servicio M8 no responde o da timeout (RNF-13)", async () => {
    // Arrange
    const existingTrip = {
      id: tripId,
      clientId: validClientId,
      driverId: validDriverId,
      state: "DRIVER_ARRIVED",
      version: 2,
    };
    tripRepoMock.findById.mockResolvedValue(existingTrip);

    // Act & Assert
    try {
      await tripService.startTrip(tripId, "m8_timeout", authDriver, correlationId);
      expect.fail("Debería haber lanzado un ApiError 503");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.statusCode).toBe(503);
      expect(apiErr.code).toBe("DEPENDENCY_UNAVAILABLE");
      expect(apiErr.options.headers?.["Retry-After"]).toBe("5");
    }

    // El viaje no debe haberse modificado en la base de datos
    expect(tripRepoMock.transitionStateAtomic).not.toHaveBeenCalled();
  });

  it("debe rechazar con 412 PRECONDITION_FAILED si el If-Match no coincide con la versión del viaje (RNF-08)", async () => {
    // Arrange
    const existingTrip = {
      id: tripId,
      clientId: validClientId,
      driverId: validDriverId,
      state: "DRIVER_ARRIVED",
      version: 2,
    };
    tripRepoMock.findById.mockResolvedValue(existingTrip);

    // Act & Assert: Pasamos versión 1 cuando en la base ya está en 2
    await expect(
      tripService.startTrip(
        tripId,
        "token_valido",
        authDriver,
        correlationId,
        1 // ifMatch desactualizado
      )
    ).rejects.toMatchObject({
      statusCode: 412,
      code: "PRECONDITION_FAILED",
    });

    expect(tripRepoMock.transitionStateAtomic).not.toHaveBeenCalled();
  });
});
