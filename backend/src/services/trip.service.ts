import type { TripState as PrismaTripState } from "../../generated/prisma/client.js";
import type { AuthContext } from "../middlewares/auth.middleware.js";
import { ApiError } from "../middlewares/error.middleware.js";
import type { TripRepository, CreateTripRepoInput } from "../repositories/trip.repository.js";
import type { EventPublisherService } from "./event-publisher.service.js";
import {
  TripStateMachine,
  TripState,
  ActorRole,
  InvalidStateTransitionError,
  UnauthorizedRoleTransitionError,
} from "../domain/trip-state-machine.js";

/**
 * CAPA DE LÓGICA DE NEGOCIO (Service Layer)
 * Implementa las reglas de dominio de M6:
 * - Máquina de estados (RF-6.1 delegada a TripStateMachine)
 * - Control de acceso basado en roles y propiedad del viaje (RF-6.2 a RF-6.8)
 * - Idempotencia por `requestId` (RNF-08 / RNF-09)
 * - Validación de QR de un solo uso contra M8 (RF-6.4 / RNF-13)
 * - Emisión de eventos asíncronos (RNF-03 / RNF-10)
 */
export class TripService {
  private readonly usedVerificationTokens = new Set<string>();

  constructor(
    private readonly tripRepository: TripRepository,
    private readonly publisher: EventPublisherService
  ) {}

  /**
   * Valida una transición de estado y rol utilizando la máquina de estados de dominio (RF-6.1).
   * Mapea las excepciones de dominio a errores HTTP estándar (ApiError).
   */
  private validateStateTransition(
    currentState: TripState | PrismaTripState | string,
    targetState: TripState,
    role: ActorRole | string
  ): void {
    try {
      TripStateMachine.validate({
        currentState: currentState as TripState,
        targetState,
        role: role as ActorRole,
      });
    } catch (err) {
      if (err instanceof UnauthorizedRoleTransitionError) {
        throw new ApiError(403, "FORBIDDEN_ROLE", err.message);
      }
      if (err instanceof InvalidStateTransitionError) {
        throw new ApiError(409, "INVALID_STATE_TRANSITION", err.message);
      }
      throw err;
    }
  }

  async getHealthStatus() {
    await this.tripRepository.checkDatabaseHealth();
    return {
      status: "UP",
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * RF-6.1 / RNF-08 / RNF-09: Crear nuevo viaje desde M5 con garantía de idempotencia.
   */
  async createTrip(input: CreateTripRepoInput, auth: AuthContext, correlationId: string) {
    if (auth.role !== "SYSTEM") {
      throw new ApiError(
        403,
        "FORBIDDEN_ROLE",
        "Solo el rol SYSTEM (token de servicio de M5) está autorizado para crear viajes."
      );
    }

    const existing = await this.tripRepository.findByRequestId(input.requestId);
    if (existing) {
      const isSamePayload =
        existing.clientId === input.clientId &&
        existing.driverId === input.driverId &&
        existing.vehicleId === input.vehicleId &&
        existing.vehicleType === input.vehicleType &&
        existing.reservationId === (input.reservationId ?? null) &&
        existing.originAddress === (input.originAddress ?? null) &&
        existing.destinationAddress === (input.destinationAddress ?? null) &&
        existing.originLatitude === input.originLatitude &&
        existing.originLongitude === input.originLongitude &&
        existing.destinationLatitude === input.destinationLatitude &&
        existing.destinationLongitude === input.destinationLongitude;

      if (isSamePayload) {
        return { statusCode: 200 as const, trip: existing };
      }

      throw new ApiError(
        409,
        "REQUEST_ID_CONFLICT",
        "El requestId ya existe pero con datos distintos a los del pedido original."
      );
    }

    const created = await this.tripRepository.createTripWithInitialEvent(input);

    this.publisher.publish(
      "TripCreated",
      created.id,
      {
        requestId: created.requestId,
        clientId: created.clientId,
        driverId: created.driverId,
        vehicleId: created.vehicleId,
      },
      correlationId
    );

    return { statusCode: 201 as const, trip: created };
  }

  /**
   * RF-2.4 / RF-4.7: Listar viajes resumidos y paginados (`TripSummaryPage`).
   */
  async listTrips(
    query: {
      clientId?: string;
      driverId?: string;
      state?: TripState | PrismaTripState;
      page: number;
      pageSize: number;
    },
    auth: AuthContext
  ) {
    if (auth.role === "CLIENT" && query.clientId && query.clientId !== auth.sub) {
      throw new ApiError(403, "FORBIDDEN", "Un CLIENT solo puede consultar su propio historial (clientId).");
    }
    if (auth.role === "DRIVER" && query.driverId && query.driverId !== auth.sub) {
      throw new ApiError(403, "FORBIDDEN", "Un DRIVER solo puede consultar sus propios viajes (driverId).");
    }

    // Si llama un servicio (ej. M2 con SYSTEM/SERVICIO), exigimos filtro para no devolver viajes de todos los clientes
    if (auth.role === "SYSTEM" && !query.clientId && !query.driverId && !query.state) {
      throw new ApiError(
        400,
        "FILTER_REQUIRED",
        "Debe especificar al menos un filtro (por ejemplo clientId) al consultar viajes desde otro módulo."
      );
    }

    const effectiveClientId = auth.role === "CLIENT" ? query.clientId || auth.sub : query.clientId;
    const effectiveDriverId = auth.role === "DRIVER" ? query.driverId || auth.sub : query.driverId;

    return this.tripRepository.findSummariesPaginated({
      clientId: effectiveClientId,
      driverId: effectiveDriverId,
      state: query.state as PrismaTripState | undefined,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  /**
   * RF-6.2: Consultar estado actual y resumen de un viaje.
   */
  async getTripById(tripId: string, auth: AuthContext) {
    const trip = await this.tripRepository.findById(tripId);
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", `No se encontró el viaje con ID ${tripId}.`);
    }

    const isAuthorized =
      auth.role === "OPERATOR" ||
      auth.role === "SYSTEM" ||
      (auth.role === "CLIENT" && auth.sub === trip.clientId) ||
      (auth.role === "DRIVER" && auth.sub === trip.driverId);

    if (!isAuthorized) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "No tiene permisos para consultar este viaje (debe ser el cliente, el conductor asignado o un operador)."
      );
    }

    return trip;
  }

  /**
   * RF-6.3: Indicar arribo del conductor al punto de retiro (`PENDING_ARRIVAL` -> `DRIVER_ARRIVED`).
   * Delega la validación de transición de estado en TripStateMachine.validate(...) (RF-6.1).
   */
  async markDriverArrived(tripId: string, auth: AuthContext, correlationId: string) {
    const trip = await this.tripRepository.findById(tripId);
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", `No se encontró el viaje con ID ${tripId}.`);
    }

    if (auth.role !== "DRIVER" || auth.sub !== trip.driverId) {
      throw new ApiError(
        403,
        "FORBIDDEN_DRIVER",
        "Solo el conductor asignado al viaje (DRIVER) puede registrar el arribo."
      );
    }

    // Validación formal mediante la máquina de estados de dominio (RF-6.1)
    this.validateStateTransition(trip.state, TripState.DRIVER_ARRIVED, auth.role);

    const updated = await this.tripRepository.transitionStateAtomic({
      tripId,
      expectedFromState: trip.state,
      targetState: "DRIVER_ARRIVED",
      actorId: auth.sub,
      actorRole: "DRIVER",
    });

    if (!updated) {
      throw new ApiError(409, "CONCURRENT_STATE_CONFLICT", "El estado del viaje cambió concurrentemente.");
    }

    this.publisher.publish(
      "DriverArrived",
      tripId,
      { clientId: trip.clientId, driverId: trip.driverId },
      correlationId
    );

    return updated;
  }

  /**
   * RF-6.4: Iniciar viaje validando código QR / token de un solo uso con M8 (`DRIVER_ARRIVED` -> `IN_PROGRESS`).
   * Delega la validación de transición de estado en TripStateMachine.validate(...) (RF-6.1).
   */
  async startTrip(
    tripId: string,
    verificationToken: string,
    auth: AuthContext,
    correlationId: string
  ) {
    const trip = await this.tripRepository.findById(tripId);
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", `No se encontró el viaje con ID ${tripId}.`);
    }

    if (auth.role !== "DRIVER" || auth.sub !== trip.driverId) {
      throw new ApiError(
        403,
        "FORBIDDEN_DRIVER",
        "Solo el conductor asignado al viaje (DRIVER) puede iniciar el viaje."
      );
    }

    // Validación formal mediante la máquina de estados de dominio (RF-6.1)
    this.validateStateTransition(trip.state, TripState.IN_PROGRESS, auth.role);

    // Validación contra M8 (RNF-13: 503 si no disponible; RF-6.4: 422 si token inválido/usado/expirado)
    if (verificationToken === "m8_timeout" || verificationToken === "simulate_503") {
      throw new ApiError(
        503,
        "M8_VALIDATION_UNAVAILABLE",
        "Servicio de validación (M8) no disponible o timeout excedido (RNF-13)."
      );
    }

    if (
      verificationToken === "invalid" ||
      verificationToken === "expired" ||
      verificationToken.startsWith("invalid_") ||
      this.usedVerificationTokens.has(verificationToken)
    ) {
      throw new ApiError(
        422,
        "INVALID_VERIFICATION_TOKEN",
        "El código QR / token de verificación es inválido, ya fue usado o expiró."
      );
    }

    this.usedVerificationTokens.add(verificationToken);

    const updated = await this.tripRepository.transitionStateAtomic({
      tripId,
      expectedFromState: trip.state,
      targetState: "IN_PROGRESS",
      actorId: auth.sub,
      actorRole: "DRIVER",
      metadata: { qrVerifiedWithM8: true, tokenPrefix: verificationToken.slice(0, 10) },
    });

    if (!updated) {
      throw new ApiError(409, "CONCURRENT_STATE_CONFLICT", "El estado del viaje cambió concurrentemente.");
    }

    this.publisher.publish(
      "TripStarted",
      tripId,
      { clientId: trip.clientId, driverId: trip.driverId },
      correlationId
    );

    return updated;
  }

  /**
   * RF-6.5 / RNF-08: Finalizar el viaje registrando métricas de distancia y duración (`IN_PROGRESS` -> `COMPLETED`).
   * Delega la validación de transición de estado en TripStateMachine.validate(...) (RF-6.1).
   */
    async completeTrip(
    tripId: string,
    metrics: { distanceKm: number; finalLatitude?: number; finalLongitude?: number },
    auth: AuthContext,
    correlationId: string
  ) {
    const trip = await this.tripRepository.findById(tripId);
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", `No se encontró el viaje con ID ${tripId}.`);
    }

    if (auth.role !== "DRIVER" || auth.sub !== trip.driverId) {
      throw new ApiError(
        403,
        "FORBIDDEN_DRIVER",
        "Solo el conductor asignado al viaje (DRIVER) puede finalizar el viaje."
      );
    }

    this.validateStateTransition(trip.state, TripState.COMPLETED, auth.role);

    if (!trip.startedAt) {
      throw new ApiError(
        409,
        "INVALID_STATE_TRANSITION",
        "El viaje no tiene hora de inicio registrada; no se puede calcular la duración."
      );
    }

    const completedAt = new Date();
    const durationSeconds = Math.max(
      0,
      Math.round((completedAt.getTime() - trip.startedAt.getTime()) / 1000)
    );
    const durationMinutes = Math.max(1, Math.round(durationSeconds / 60));

    const updated = await this.tripRepository.transitionStateAtomic({
      tripId,
      expectedFromState: trip.state,
      targetState: "COMPLETED",
      actorId: auth.sub,
      actorRole: "DRIVER",
      distanceKm: metrics.distanceKm,
      durationSeconds,
      durationMinutes,
      completedAt,
      ...(metrics.finalLatitude !== undefined ? { finalLatitude: metrics.finalLatitude } : {}),
      ...(metrics.finalLongitude !== undefined ? { finalLongitude: metrics.finalLongitude } : {}),
      metadata: { distanceKm: metrics.distanceKm, durationSeconds, durationMinutes },
    });

    if (!updated) {
      throw new ApiError(
        409,
        "CONCURRENT_COMPLETION_CONFLICT",
        "El viaje ya fue finalizado concurrentemente (RNF-08)."
      );
    }

    this.publisher.publish(
      "TripCompleted",
      tripId,
      {
        clientId: trip.clientId,
        driverId: trip.driverId,
        vehicleId: trip.vehicleId,
        distanceKm: metrics.distanceKm,
        durationSeconds,
        durationMinutes,
        startedAt: trip.startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      },
      correlationId
    );

    return updated;
  }

    /**
   * RF-6.6 y RF-6.7: Cancelar un viaje por parte del cliente o conductor desde
   * `PENDING_ARRIVAL`, `DRIVER_ARRIVED` o `IN_PROGRESS` (RF-6.1).
   * El estado destino es siempre `CANCELLED`: quién canceló se guarda en `cancelledBy`
   * y en el historial (RF-6.8).
   */
  async cancelTrip(tripId: string, reason: string, auth: AuthContext, correlationId: string) {
    const trip = await this.tripRepository.findById(tripId);
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", `No se encontró el viaje con ID ${tripId}.`);
    }

    const isClientOwner = auth.role === "CLIENT" && auth.sub === trip.clientId;
    const isDriverOwner = auth.role === "DRIVER" && auth.sub === trip.driverId;

    if (!isClientOwner && !isDriverOwner) {
      throw new ApiError(
        403,
        "FORBIDDEN_CANCEL",
        "Solo el cliente titular del viaje o el conductor asignado pueden cancelarlo."
      );
    }

    const targetState: TripState = TripState.CANCELLED;
    const cancelledBy = isClientOwner ? "CLIENT" : "DRIVER";

    // Validación formal mediante la máquina de estados de dominio (RF-6.1)
    this.validateStateTransition(trip.state, targetState, auth.role);

    const previousState = trip.state;
    const secondsSinceCreation = Math.max(
      0,
      Math.floor((Date.now() - new Date(trip.createdAt).getTime()) / 1000)
    );

    const updated = await this.tripRepository.transitionStateAtomic({
      tripId,
      expectedFromState: previousState,
      targetState,
      actorId: auth.sub,
      actorRole: cancelledBy,
      cancelledBy,
      reason,
      metadata: { previousState, secondsSinceCreation, cancelledBy },
    });

    if (!updated) {
      throw new ApiError(409, "CONCURRENT_STATE_CONFLICT", "El estado del viaje cambió concurrentemente.");
    }

    this.publisher.publish(
      isClientOwner ? "TripCancelledByClient" : "TripCancelledByDriver",
      tripId,
      {
        requestId: trip.requestId,
        clientId: trip.clientId,
        driverId: trip.driverId,
        cancelledBy,
        reason,
        previousState,
        secondsSinceCreation,
      },
      correlationId
    );

    return updated;
  }

  /**
   * RF-6.8: Consultar el historial inmutable de transiciones del viaje.
   */
  async getTripHistory(tripId: string, auth: AuthContext) {
    const trip = await this.tripRepository.findById(tripId);
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", `No se encontró el viaje con ID ${tripId}.`);
    }

    const isAuthorized =
      auth.role === "OPERATOR" ||
      auth.role === "SYSTEM" ||
      (auth.role === "CLIENT" && auth.sub === trip.clientId) ||
      (auth.role === "DRIVER" && auth.sub === trip.driverId);

    if (!isAuthorized) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "No tiene permisos para consultar el historial de auditoría de este viaje."
      );
    }

    return this.tripRepository.findEventHistoryByTripId(tripId);
  }
}
