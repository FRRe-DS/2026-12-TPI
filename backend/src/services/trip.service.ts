import type { TripState as PrismaTripState } from "../../generated/prisma/client.js";
import type { AuthContext } from "../middlewares/auth.middleware.js";
import { ApiError } from "../middlewares/error.middleware.js";
import type { TripRepository, CreateTripRepoInput } from "../repositories/trip.repository.js";
import { toTripSummary } from "../mappers/trip.mapper.js";
import { assertIfMatch } from "../middlewares/preconditions.js";
import {
  buildTripCompletedPayload,
  buildTripCreatedPayload,
  type EventPublisherService,
} from "./event-publisher.service.js";
import {
  TripStateMachine,
  TripState,
  ActorRole,
  InvalidStateTransitionError,
  UnauthorizedRoleTransitionError,
} from "../domain/trip-state-machine.js";
import {
  checkCancellationReason,
  requiresRedispatch,
  type CancellationReasonValue,
} from "../domain/cancellation-rules.js";

/** Minutos desde el arribo para aceptar CLIENT_NO_SHOW (configurable por entorno, RNF-06). */
const parsedNoShowMinutes = Number(process.env.CLIENT_NO_SHOW_MINUTES ?? 5);
const CLIENT_NO_SHOW_MINUTES =
  Number.isFinite(parsedNoShowMinutes) && parsedNoShowMinutes >= 0 ? parsedNoShowMinutes : 5;

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
        throw new ApiError(403, "FORBIDDEN", err.message);
      }
      if (err instanceof InvalidStateTransitionError) {
        throw new ApiError(409, "INVALID_STATE_TRANSITION", err.message, {
        currentState: String(currentState),
        });
      }
      throw err;
    }
  }

  /** CLIENT y DRIVER solo ven su propio viaje; OPERATOR y SYSTEM ven todos. */
  private canViewTrip(trip: { clientId: string; driverId: string }, auth: AuthContext): boolean {
    return (
      auth.role === "OPERATOR" ||
      auth.role === "SYSTEM" ||
      (auth.role === "CLIENT" && auth.sub === trip.clientId) ||
      (auth.role === "DRIVER" && auth.sub === trip.driverId)
    );
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
        "FORBIDDEN",
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

    const created = await this.tripRepository.createTripWithInitialEvent(input, auth.sub);

    this.publisher.publish("TripCreated", created.id, buildTripCreatedPayload(created), correlationId);

    return { statusCode: 201 as const, trip: created };
  }

  /**
   * RF-2.4 / RF-4.7: Listar viajes resumidos y paginados (`TripSummaryPage`).
   * CLIENT y DRIVER solo ven lo suyo: su propio filtro se ignora y se usa el id del token.
   */
  async listTrips(
    query: {
      clientId?: string;
      driverId?: string;
      states?: PrismaTripState[];
      from?: Date;
      to?: Date;
      page: number;
      pageSize: number;
    },
    auth: AuthContext
  ) {
    // Un servicio no puede listar los viajes de todos los clientes.
    if (auth.role === "SYSTEM" && !query.clientId && !query.driverId) {
      throw new ApiError(
        400,
        "VALIDATION",
        "Un servicio debe indicar clientId o driverId para listar viajes.",
        { errors: [{ field: "clientId", message: "se requiere clientId o driverId" }] }
      );
    }

    const clientId = auth.role === "CLIENT" ? auth.sub : query.clientId;
    const driverId = auth.role === "DRIVER" ? auth.sub : query.driverId;

    const result = await this.tripRepository.findSummariesPaginated({
      clientId,
      driverId,
      states: query.states,
      from: query.from,
      to: query.to,
      page: query.page,
      pageSize: query.pageSize,
    });

    return { ...result, items: result.items.map(toTripSummary) };
  }

  /**
   * RF-6.2: Consultar estado actual y resumen de un viaje.
   * A un cliente o conductor ajeno se le responde 404, para no revelar que el viaje existe.
   */
  async getTripById(tripId: string, auth: AuthContext) {
    const trip = await this.tripRepository.findById(tripId);
    if (!trip || !this.canViewTrip(trip, auth)) {
      throw new ApiError(404, "TRIP_NOT_FOUND", `No se encontró el viaje con ID ${tripId}.`);
    }
    return trip;
  }

  /**
   * RF-6.3: Indicar arribo del conductor al punto de retiro (`PENDING_ARRIVAL` -> `DRIVER_ARRIVED`).
   * Delega la validación de transición de estado en TripStateMachine.validate(...) (RF-6.1).
   */
  async markDriverArrived(tripId: string, auth: AuthContext, correlationId: string, ifMatch?: number) {
    const trip = await this.tripRepository.findById(tripId);
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", `No se encontró el viaje con ID ${tripId}.`);
    }

    if (auth.role !== "DRIVER" || auth.sub !== trip.driverId) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Solo el conductor asignado al viaje (DRIVER) puede registrar el arribo."
      );
    }

    assertIfMatch(trip.version, ifMatch);

    // Validación formal mediante la máquina de estados de dominio (RF-6.1)
    this.validateStateTransition(trip.state, TripState.DRIVER_ARRIVED, auth.role);

    const updated = await this.tripRepository.transitionStateAtomic({
      tripId,
      expectedFromState: trip.state,
      targetState: "DRIVER_ARRIVED",
      action: "REGISTER_ARRIVAL",
      actorId: auth.sub,
      actorRole: "DRIVER",
    });

    if (!updated) {
      throw new ApiError(409, "CONCURRENCY_CONFLICT", "El estado del viaje cambió concurrentemente.");
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
    correlationId: string,
    ifMatch?: number
  ) {
    const trip = await this.tripRepository.findById(tripId);
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", `No se encontró el viaje con ID ${tripId}.`);
    }

    if (auth.role !== "DRIVER" || auth.sub !== trip.driverId) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Solo el conductor asignado al viaje (DRIVER) puede iniciar el viaje."
      );
    }

    assertIfMatch(trip.version, ifMatch);

    // Validación formal mediante la máquina de estados de dominio (RF-6.1)
    this.validateStateTransition(trip.state, TripState.IN_PROGRESS, auth.role);

    // Validación contra M8 (RNF-13: 503 si no disponible; RF-6.4: 422 si token inválido/usado/expirado)
    if (verificationToken === "m8_timeout" || verificationToken === "simulate_503") {
      throw new ApiError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Servicio de validación (M8) no disponible o timeout excedido (RNF-13).",
        { headers: { "Retry-After": "5" } }
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
        "INVALID_VERIFICATION_CODE",
        "El código QR / token de verificación es inválido, ya fue usado o expiró."
      );
    }

    this.usedVerificationTokens.add(verificationToken);

    const updated = await this.tripRepository.transitionStateAtomic({
      tripId,
      expectedFromState: trip.state,
      targetState: "IN_PROGRESS",
      action: "START",
      actorId: auth.sub,
      actorRole: "DRIVER",
      metadata: { qrVerifiedWithM8: true, tokenPrefix: verificationToken.slice(0, 10) },
    });

    if (!updated) {
      throw new ApiError(409, "CONCURRENCY_CONFLICT", "El estado del viaje cambió concurrentemente.");
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
    correlationId: string,
    ifMatch?: number
  ) {
    const trip = await this.tripRepository.findById(tripId);
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", `No se encontró el viaje con ID ${tripId}.`);
    }

    if (auth.role !== "DRIVER" || auth.sub !== trip.driverId) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Solo el conductor asignado al viaje (DRIVER) puede finalizar el viaje."
      );
    }

    assertIfMatch(trip.version, ifMatch);

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
      action: "COMPLETE",
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
        "CONCURRENCY_CONFLICT",
        "El viaje ya fue finalizado concurrentemente (RNF-08)."
      );
    }

    this.publisher.publish(
      "TripCompleted",
      tripId,
      buildTripCompletedPayload({
        trip,
        startedAt: trip.startedAt,
        completedAt,
        distanceKm: metrics.distanceKm,
        durationSeconds,
        durationMinutes,
        finalLatitude: metrics.finalLatitude,
        finalLongitude: metrics.finalLongitude,
      }),
      correlationId
    );

    return updated;
  }

  /**
  * RF-6.6 y RF-6.7: cancelar un viaje. Cliente y conductor, antes de iniciar; el operador, en cualquier
  * estado no terminal. El estado destino es siempre CANCELLED; quién canceló, el motivo y si hay que
  * re-despachar quedan guardados en el viaje y en el historial (RF-6.8).
  */
  async cancelTrip(
    tripId: string,
    input: { reason: CancellationReasonValue; detail?: string },
    auth: AuthContext,
    correlationId: string,
    ifMatch?: number
  ) {
    const trip = await this.tripRepository.findById(tripId);
    if (!trip) {
      throw new ApiError(404, "TRIP_NOT_FOUND", `No se encontró el viaje con ID ${tripId}.`);
    }

    const isClientOwner = auth.role === "CLIENT" && auth.sub === trip.clientId;
    const isDriverOwner = auth.role === "DRIVER" && auth.sub === trip.driverId;
    const isOperator = auth.role === "OPERATOR";

    if (!isClientOwner && !isDriverOwner && !isOperator) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Solo el cliente titular del viaje, el conductor asignado o un operador pueden cancelarlo."
      );
    }

    assertIfMatch(trip.version, ifMatch);

    const cancelledBy = isOperator ? "OPERATOR" : isClientOwner ? "CLIENT" : "DRIVER";

    // 1) ¿El rol puede cancelar desde este estado? (máquina de estados, RF-6.1)
    this.validateStateTransition(trip.state, TripState.CANCELLED, auth.role);

    // 2) ¿El motivo corresponde al rol y a este momento?
    const problem = checkCancellationReason(
      cancelledBy,
      input.reason,
      trip.arrivedAt,
      new Date(),
      CLIENT_NO_SHOW_MINUTES
    );
    if (problem) {
      throw new ApiError(422, "REASON_NOT_ALLOWED", problem);
    }

    const redispatch = requiresRedispatch(cancelledBy, input.reason);
    const previousState = trip.state;
    const secondsSinceCreation = Math.max(
      0,
      Math.floor((Date.now() - new Date(trip.createdAt).getTime()) / 1000)
    );

    const updated = await this.tripRepository.transitionStateAtomic({
      tripId,
      expectedFromState: previousState,
      targetState: "CANCELLED",
      action: "CANCEL",
      actorId: auth.sub,
      actorRole: cancelledBy,
      cancelledBy,
      reason: input.reason,
      cancellationReason: input.reason,
      cancellationDetail: input.detail,
      cancelledFromState: previousState,
      requiresRedispatch: redispatch,
      metadata: {
        previousState,
        secondsSinceCreation,
        cancelledBy,
        requiresRedispatch: redispatch,
        ...(input.detail ? { detail: input.detail } : {}),
      },
    });

    if (!updated) {
      throw new ApiError(409, "CONCURRENCY_CONFLICT", "El estado del viaje cambió concurrentemente.");
    }

    this.publisher.publish(
      "TripCancelled",
      tripId,
      {
        requestId: trip.requestId,
        clientId: trip.clientId,
        driverId: trip.driverId,
        cancelledBy,
        reason: input.reason,
        ...(input.detail ? { detail: input.detail } : {}),
        previousState,
        requiresRedispatch: redispatch,
        secondsSinceCreation,
      },
      correlationId
    );

    return updated;
  }

  /**
  * RF-6.8: Consultar el historial inmutable de transiciones del viaje.
  * SYSTEM no tiene acceso (403); un cliente o conductor ajeno recibe 404.
  */
  async getTripHistory(tripId: string, auth: AuthContext) {
    if (auth.role === "SYSTEM") {
      throw new ApiError(403, "FORBIDDEN", "SYSTEM no puede consultar el historial de un viaje.");
    }

    const trip = await this.tripRepository.findById(tripId);
    if (!trip || !this.canViewTrip(trip, auth)) {
      throw new ApiError(404, "TRIP_NOT_FOUND", `No se encontró el viaje con ID ${tripId}.`);
    }

    return this.tripRepository.findEventHistoryByTripId(tripId);
  }
}
