import { describe, it, expect, beforeEach, vi } from "vitest";
import { TripService } from "../src/services/trip.service.js";
import { TripRepository } from "../src/repositories/trip.repository.js";
import { EventPublisherService } from "../src/services/event-publisher.service.js";
import { M8QrValidatorService } from "../src/services/m8-qr-validator.service.js";
import { ApiError } from "../src/middlewares/error.middleware.js";
import type { AuthContext } from "../src/middlewares/auth.middleware.js";

describe("RF-6.4 (Inicio validado con código QR / M8) - Pruebas Unitarias", () => {
  let tripRepoMock: any;
  let publisherMock: any;
  let qrValidator: M8QrValidatorService;
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

  const authOperator: AuthContext = {
    sub: "77777777-7777-7777-7777-777777777777",
    role: "OPERATOR",
  };

  const authSystem: AuthContext = {
    sub: "m5-dispatch-service",
    role: "SYSTEM",
  };

  beforeEach(() => {
    tripRepoMock = {
      findById: vi.fn(),
      transitionStateAtomic: vi.fn(),
    };

    publisherMock = {
      publish: vi.fn(),
    };

    // Pasar "" desactiva M8_API_URL explícitamente para aislar el test del entorno (.env)
    // y cada test usa una instancia fresca para no compartir tokens usados (RNF-09).
    qrValidator = new M8QrValidatorService("");

    tripService = new TripService(
      tripRepoMock as unknown as TripRepository,
      publisherMock as unknown as EventPublisherService,
      qrValidator
    );
  });

  it("debe iniciar el viaje exitosamente (DRIVER_ARRIVED -> IN_PROGRESS) con token válido, registrar metadata sin exponer el token completo (RNF-19) y emitir TripStarted", async () => {
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
      startedAt: new Date(),
      version: 3,
    };
    tripRepoMock.transitionStateAtomic.mockResolvedValue(updatedTrip);

    // Act
    const fullSecretToken = "qr_trip_3333_secreto_largo_987654321";
    const result = await tripService.startTrip(tripId, fullSecretToken, authDriver, correlationId);

    // Assert
    expect(result.state).toBe("IN_PROGRESS");
    expect(tripRepoMock.transitionStateAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        tripId,
        expectedFromState: "DRIVER_ARRIVED",
        targetState: "IN_PROGRESS",
        action: "START",
        actorId: validDriverId,
        actorRole: "DRIVER",
        metadata: {
          qrVerifiedWithM8: true,
          tokenPrefix: fullSecretToken.slice(0, 10),
        },
      })
    );
    expect(publisherMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "TripStarted",
        tripId,
        payload: { clientId: validClientId, driverId: validDriverId },
        correlationId,
      })
    );
  });

  it("debe rechazar con 404 TRIP_NOT_FOUND si el viaje no existe y no consumir el código QR", async () => {
    // Arrange
    tripRepoMock.findById.mockResolvedValue(null);
    const validateSpy = vi.spyOn(qrValidator, "validate");

    // Act & Assert
    await expect(
      tripService.startTrip("inexistente-id", "token_valido", authDriver, correlationId)
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "TRIP_NOT_FOUND",
    });

    expect(validateSpy).not.toHaveBeenCalled();
    expect(tripRepoMock.transitionStateAtomic).not.toHaveBeenCalled();
    expect(publisherMock.publish).not.toHaveBeenCalled();
  });

  it("debe rechazar con 403 FORBIDDEN si quien llama no es el DRIVER asignado (otro DRIVER, CLIENT, OPERATOR o SYSTEM) sin consumir el QR", async () => {
    // Arrange
    const existingTrip = {
      id: tripId,
      clientId: validClientId,
      driverId: validDriverId,
      state: "DRIVER_ARRIVED",
      version: 2,
    };
    tripRepoMock.findById.mockResolvedValue(existingTrip);
    const validateSpy = vi.spyOn(qrValidator, "validate");

    for (const actor of [authOtherDriver, authClient, authOperator, authSystem]) {
      await expect(
        tripService.startTrip(tripId, "token_valido", actor, correlationId)
      ).rejects.toMatchObject({
        statusCode: 403,
        code: "FORBIDDEN",
      });
    }

    expect(validateSpy).not.toHaveBeenCalled();
    expect(tripRepoMock.transitionStateAtomic).not.toHaveBeenCalled();
  });

  it("debe rechazar con 409 INVALID_STATE_TRANSITION si el viaje no está en DRIVER_ARRIVED (RF-6.1) sin consumir el QR", async () => {
    const validateSpy = vi.spyOn(qrValidator, "validate");

    for (const invalidState of ["PENDING_ARRIVAL", "IN_PROGRESS", "COMPLETED", "CANCELLED"]) {
      tripRepoMock.findById.mockResolvedValue({
        id: tripId,
        clientId: validClientId,
        driverId: validDriverId,
        state: invalidState,
        version: 1,
      });

      await expect(
        tripService.startTrip(tripId, "token_valido", authDriver, correlationId)
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "INVALID_STATE_TRANSITION",
      });
    }

    expect(validateSpy).not.toHaveBeenCalled();
    expect(tripRepoMock.transitionStateAtomic).not.toHaveBeenCalled();
  });

  it("debe rechazar con 412 PRECONDITION_FAILED si el If-Match no coincide con la versión del viaje (RNF-08) sin consumir el QR", async () => {
    // Arrange
    const existingTrip = {
      id: tripId,
      clientId: validClientId,
      driverId: validDriverId,
      state: "DRIVER_ARRIVED",
      version: 2,
    };
    tripRepoMock.findById.mockResolvedValue(existingTrip);
    const validateSpy = vi.spyOn(qrValidator, "validate");

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

    expect(validateSpy).not.toHaveBeenCalled();
    expect(tripRepoMock.transitionStateAtomic).not.toHaveBeenCalled();
  });

  it("debe rechazar con 422 INVALID_VERIFICATION_CODE si el código QR / token es inválido o expiró", async () => {
    // Arrange
    const existingTrip = {
      id: tripId,
      clientId: validClientId,
      driverId: validDriverId,
      state: "DRIVER_ARRIVED",
      version: 2,
    };
    tripRepoMock.findById.mockResolvedValue(existingTrip);

    // Act & Assert con token inválido
    await expect(
      tripService.startTrip(tripId, "invalid", authDriver, correlationId)
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "INVALID_VERIFICATION_CODE",
    });

    // Act & Assert con token expirado
    await expect(
      tripService.startTrip(tripId, "expired", authDriver, correlationId)
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "INVALID_VERIFICATION_CODE",
    });

    expect(tripRepoMock.transitionStateAtomic).not.toHaveBeenCalled();
    expect(publisherMock.publish).not.toHaveBeenCalled();
  });

  it("debe rechazar con 422 INVALID_VERIFICATION_CODE si se intenta reutilizar un token de un solo uso (RNF-09)", async () => {
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
      version: 3,
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

    // El viaje no debe haberse modificado en la base de datos ni publicado evento
    expect(tripRepoMock.transitionStateAtomic).not.toHaveBeenCalled();
    expect(publisherMock.publish).not.toHaveBeenCalled();
  });

  it("debe rechazar con 409 CONCURRENCY_CONFLICT si el estado del viaje cambió concurrentemente en la base de datos (RNF-08)", async () => {
    // Arrange
    const existingTrip = {
      id: tripId,
      clientId: validClientId,
      driverId: validDriverId,
      state: "DRIVER_ARRIVED",
      version: 2,
    };
    tripRepoMock.findById.mockResolvedValue(existingTrip);
    // Simula que otro proceso cambió el estado justo antes del UPDATE atómico
    tripRepoMock.transitionStateAtomic.mockResolvedValue(null);

    // Act & Assert
    await expect(
      tripService.startTrip(tripId, "token_valido_concurrencia", authDriver, correlationId)
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "CONCURRENCY_CONFLICT",
    });

    expect(publisherMock.publish).not.toHaveBeenCalled();
  });
});
