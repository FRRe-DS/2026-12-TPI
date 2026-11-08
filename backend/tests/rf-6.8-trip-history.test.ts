import crypto from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { TripService } from "../src/services/trip.service.js";
import { EventPublisherService } from "../src/services/event-publisher.service.js";
import { toTripHistory } from "../src/mappers/trip.mapper.js";
import type {
  CreateTripRepoInput,
  TransitionTripRepoInput,
  TripRepository,
} from "../src/repositories/trip.repository.js";
import type { AuthContext } from "../src/middlewares/auth.middleware.js";

/**
 * Módulo M6: Viajes y Ciclo de Vida
 * Suite de pruebas unitarias para el Historial de Transiciones del Viaje.
 *
 * Cumple con:
 * - RF-6.8 (Historial de transiciones): Registro de auditoría de solo inserción (`TripEventHistory`)
 *   con secuencia, estado de origen y destino, acción, actor, fecha/hora y motivo.
 * - RNF-05 (Integridad e inmutabilidad de datos): El historial es append-only (no destructivo);
 *   las filas previas nunca se modifican ni se eliminan.
 * - RNF-08 (Consistencia transaccional y concurrencia): La secuencia (`sequence`) avanza junto con
 *   la `version` del viaje, y las transiciones fallidas no generan registros huérfanos.
 * - RNF-19 (Privacidad y mínimo privilegio): Clientes/conductores ajenos reciben 404 (sin revelar
 *   que el viaje existe) y el rol `SYSTEM` recibe 403.
 * - RNF-03 (Cumplimiento de contrato OpenAPI): Mapeo exacto al esquema `TripHistory` / `TripTransition`.
 */
describe("RF-6.8 - Historial inmutable de transiciones (TripEventHistory)", () => {
  const tripId = "11111111-2222-4333-8444-555555555555";
  const requestId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const clientId = "c1111111-1111-4111-8111-111111111111";
  const driverId = "d1111111-1111-4111-8111-111111111111";
  const vehicleId = "v1111111-1111-4111-8111-111111111111";
  const correlationId = "corr-rf-6-8";

  const authSystem: AuthContext = { sub: "m5-dispatch-service", role: "SYSTEM" };
  const authClient: AuthContext = { sub: clientId, role: "CLIENT" };
  const authOtherClient: AuthContext = { sub: "c9999999-9999-4999-8999-999999999999", role: "CLIENT" };
  const authDriver: AuthContext = { sub: driverId, role: "DRIVER" };
  const authOtherDriver: AuthContext = { sub: "d9999999-9999-4999-8999-999999999999", role: "DRIVER" };
  const authOperator: AuthContext = { sub: "op-00001", role: "OPERATOR" };

  let currentTrip: any;
  let historyStore: any[];
  let tripRepoMock: {
    findById: ReturnType<typeof vi.fn>;
    findByRequestId: ReturnType<typeof vi.fn>;
    createTripWithInitialEvent: ReturnType<typeof vi.fn>;
    transitionStateAtomic: ReturnType<typeof vi.fn>;
    findEventHistoryByTripId: ReturnType<typeof vi.fn>;
  };
  let eventPublisher: EventPublisherService;
  let tripService: TripService;

  beforeEach(() => {
    currentTrip = null;
    historyStore = [];

    tripRepoMock = {
      findById: vi.fn(async (id: string) => (currentTrip && currentTrip.id === id ? currentTrip : null)),
      findByRequestId: vi.fn(async (reqId: string) =>
        currentTrip && currentTrip.requestId === reqId ? currentTrip : null
      ),
      createTripWithInitialEvent: vi.fn(async (input: CreateTripRepoInput, actorId: string) => {
        const now = new Date();
        currentTrip = {
          id: tripId,
          requestId: input.requestId,
          clientId: input.clientId,
          driverId: input.driverId,
          vehicleId: input.vehicleId,
          vehicleType: input.vehicleType,
          reservationId: input.reservationId ?? null,
          originAddress: input.originAddress ?? null,
          destinationAddress: input.destinationAddress ?? null,
          originLatitude: input.originLatitude,
          originLongitude: input.originLongitude,
          destinationLatitude: input.destinationLatitude,
          destinationLongitude: input.destinationLongitude,
          state: "PENDING_ARRIVAL",
          version: 1,
          arrivedAt: null,
          startedAt: null,
          completedAt: null,
          cancelledAt: null,
          cancelledBy: null,
          cancellationReason: null,
          cancellationDetail: null,
          cancelledFromState: null,
          requiresRedispatch: null,
          distanceKm: null,
          durationMinutes: null,
          durationSeconds: null,
          finalLatitude: null,
          finalLongitude: null,
          createdAt: now,
          updatedAt: now,
        };

        // Inserción append-only del evento inicial (sequence = 1)
        historyStore.push({
          id: crypto.randomUUID(),
          tripId: currentTrip.id,
          sequence: 1,
          fromState: null,
          state: "PENDING_ARRIVAL",
          action: "CREATE",
          actorId,
          actorRole: "SYSTEM",
          reason: null,
          detail: null,
          metadata: { source: "M5_DISPATCH", requestId: input.requestId },
          createdAt: now,
        });

        return currentTrip;
      }),
      transitionStateAtomic: vi.fn(async (input: TransitionTripRepoInput) => {
        if (!currentTrip || currentTrip.id !== input.tripId) return null;
        if (input.expectedFromState && currentTrip.state !== input.expectedFromState) return null;

        const now = new Date();
        currentTrip = {
          ...currentTrip,
          state: input.targetState,
          version: currentTrip.version + 1,
          updatedAt: now,
          ...(input.targetState === "DRIVER_ARRIVED" ? { arrivedAt: now } : {}),
          ...(input.targetState === "IN_PROGRESS" ? { startedAt: now } : {}),
          ...(input.targetState === "COMPLETED" ? { completedAt: input.completedAt ?? now } : {}),
          ...(input.targetState === "CANCELLED" ? { cancelledAt: now } : {}),
          ...(input.distanceKm !== undefined ? { distanceKm: input.distanceKm } : {}),
          ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
          ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
          ...(input.cancelledBy !== undefined ? { cancelledBy: input.cancelledBy } : {}),
          ...(input.cancellationReason !== undefined
            ? { cancellationReason: input.cancellationReason }
            : {}),
          ...(input.cancellationDetail !== undefined
            ? { cancellationDetail: input.cancellationDetail }
            : {}),
          ...(input.cancelledFromState !== undefined
            ? { cancelledFromState: input.cancelledFromState }
            : {}),
          ...(input.requiresRedispatch !== undefined
            ? { requiresRedispatch: input.requiresRedispatch }
            : {}),
        };

        // Inserción append-only de la transición (nunca modifica ni elimina filas previas)
        historyStore.push({
          id: crypto.randomUUID(),
          tripId: currentTrip.id,
          sequence: currentTrip.version,
          fromState: input.expectedFromState ?? null,
          state: input.targetState,
          action: input.action,
          actorId: input.actorId,
          actorRole: input.actorRole,
          reason: input.reason ?? null,
          detail: input.cancellationDetail ?? null,
          metadata: input.metadata ?? null,
          createdAt: now,
        });

        return currentTrip;
      }),
      findEventHistoryByTripId: vi.fn(async (id: string) =>
        historyStore
          .filter((h) => h.tripId === id)
          .sort((a, b) => a.sequence - b.sequence)
      ),
    };

    eventPublisher = new EventPublisherService();
    tripService = new TripService(tripRepoMock as unknown as TripRepository, eventPublisher);
  });

  function createSampleInput(): CreateTripRepoInput {
    return {
      requestId,
      clientId,
      driverId,
      vehicleId,
      vehicleType: "AUTO",
      originAddress: "Av. 9 de Julio 100",
      destinationAddress: "Plaza 25 de Mayo",
      originLatitude: -27.4514,
      originLongitude: -58.9792,
      destinationLatitude: -27.4512,
      destinationLongitude: -58.9866,
    };
  }

  describe("1. Registro de auditoría de solo inserción (Append-Only)", () => {
    it("debe registrar el evento inicial CREATE (sequence=1, fromState=null, state=PENDING_ARRIVAL) al crear el viaje", async () => {
      await tripService.createTrip(createSampleInput(), authSystem, correlationId);

      const history = await tripService.getTripHistory(tripId, authClient);

      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        tripId,
        sequence: 1,
        fromState: null,
        state: "PENDING_ARRIVAL",
        action: "CREATE",
        actorId: "m5-dispatch-service",
        actorRole: "SYSTEM",
        reason: null,
      });
      expect(history[0]!.createdAt).toBeInstanceOf(Date);
    });

    it("debe registrar en secuencia correlativa (1..4) todas las transiciones del ciclo de vida sin modificar las anteriores", async () => {
      await tripService.createTrip(createSampleInput(), authSystem, correlationId);
      const snapshotCreacion = { ...historyStore[0] };

      await tripService.markDriverArrived(tripId, authDriver, correlationId);
      await tripService.startTrip(tripId, "qr-token-valido-1", authDriver, correlationId);
      await tripService.completeTrip(tripId, { distanceKm: 5.2 }, authDriver, correlationId);

      const history = await tripService.getTripHistory(tripId, authClient);

      expect(history).toHaveLength(4);
      expect(history.map((h) => h.sequence)).toEqual([1, 2, 3, 4]);
      expect(history.map((h) => h.action)).toEqual([
        "CREATE",
        "REGISTER_ARRIVAL",
        "START",
        "COMPLETE",
      ]);
      expect(history.map((h) => h.fromState)).toEqual([
        null,
        "PENDING_ARRIVAL",
        "DRIVER_ARRIVED",
        "IN_PROGRESS",
      ]);
      expect(history.map((h) => h.state)).toEqual([
        "PENDING_ARRIVAL",
        "DRIVER_ARRIVED",
        "IN_PROGRESS",
        "COMPLETED",
      ]);
      expect(history.map((h) => h.actorRole)).toEqual([
        "SYSTEM",
        "DRIVER",
        "DRIVER",
        "DRIVER",
      ]);

      // Verifica inmutabilidad: la primera fila no fue alterada por las transiciones posteriores
      expect(history[0]).toEqual(snapshotCreacion);
    });

    it("debe registrar el motivo (reason), detalle (detail), actor y estado de origen cuando se cancela un viaje", async () => {
      await tripService.createTrip(createSampleInput(), authSystem, correlationId);
      await tripService.markDriverArrived(tripId, authDriver, correlationId);

      await tripService.cancelTrip(
        tripId,
        { reason: "CHANGE_OF_PLANS", detail: "Surgió un imprevisto laboral" },
        authClient,
        correlationId
      );

      const history = await tripService.getTripHistory(tripId, authClient);

      expect(history).toHaveLength(3);
      expect(history[2]).toMatchObject({
        sequence: 3,
        fromState: "DRIVER_ARRIVED",
        state: "CANCELLED",
        action: "CANCEL",
        actorId: clientId,
        actorRole: "CLIENT",
        reason: "CHANGE_OF_PLANS",
        detail: "Surgió un imprevisto laboral",
      });
    });

    it("debe registrar la cancelación de emergencia por OPERATOR cuando el viaje está IN_PROGRESS", async () => {
      await tripService.createTrip(createSampleInput(), authSystem, correlationId);
      await tripService.markDriverArrived(tripId, authDriver, correlationId);
      await tripService.startTrip(tripId, "qr-token-op-1", authDriver, correlationId);

      await tripService.cancelTrip(
        tripId,
        { reason: "SECURITY_INCIDENT", detail: "Incidente reportado en ruta" },
        authOperator,
        correlationId
      );

      const history = await tripService.getTripHistory(tripId, authOperator);

      expect(history).toHaveLength(4);
      expect(history[3]).toMatchObject({
        sequence: 4,
        fromState: "IN_PROGRESS",
        state: "CANCELLED",
        action: "CANCEL",
        actorId: "op-00001",
        actorRole: "OPERATOR",
        reason: "SECURITY_INCIDENT",
        detail: "Incidente reportado en ruta",
      });
    });

    it("no debe insertar filas en el historial si una transición es rechazada (ej. QR inválido o transición ilegal)", async () => {
      await tripService.createTrip(createSampleInput(), authSystem, correlationId);

      // Intento ilegal: pasar de PENDING_ARRIVAL directo a COMPLETED
      await expect(
        tripService.completeTrip(tripId, { distanceKm: 4.0 }, authDriver, correlationId)
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "INVALID_STATE_TRANSITION",
      });

      const history = await tripService.getTripHistory(tripId, authClient);
      expect(history).toHaveLength(1);
      expect(history[0]!.action).toBe("CREATE");
    });
  });

  describe("2. Permisos de acceso al historial (GET /trips/{id}/history)", () => {
    beforeEach(async () => {
      await tripService.createTrip(createSampleInput(), authSystem, correlationId);
      await tripService.markDriverArrived(tripId, authDriver, correlationId);
    });

    it("debe permitir consultar el historial al CLIENT titular, al DRIVER asignado y a un OPERATOR", async () => {
      const byClient = await tripService.getTripHistory(tripId, authClient);
      const byDriver = await tripService.getTripHistory(tripId, authDriver);
      const byOperator = await tripService.getTripHistory(tripId, authOperator);

      expect(byClient).toHaveLength(2);
      expect(byDriver).toHaveLength(2);
      expect(byOperator).toHaveLength(2);
    });

    it("debe rechazar con 403 FORBIDDEN si el rol SYSTEM intenta consultar el historial", async () => {
      await expect(tripService.getTripHistory(tripId, authSystem)).rejects.toMatchObject({
        statusCode: 403,
        code: "FORBIDDEN",
      });
    });

    it("debe responder 404 TRIP_NOT_FOUND si un CLIENT o DRIVER ajeno intenta consultar el historial (privacidad RNF-19)", async () => {
      await expect(tripService.getTripHistory(tripId, authOtherClient)).rejects.toMatchObject({
        statusCode: 404,
        code: "TRIP_NOT_FOUND",
      });

      await expect(tripService.getTripHistory(tripId, authOtherDriver)).rejects.toMatchObject({
        statusCode: 404,
        code: "TRIP_NOT_FOUND",
      });
    });

    it("debe responder 404 TRIP_NOT_FOUND si el viaje no existe", async () => {
      await expect(
        tripService.getTripHistory("00000000-0000-4000-8000-000000000000", authOperator)
      ).rejects.toMatchObject({
        statusCode: 404,
        code: "TRIP_NOT_FOUND",
      });
    });
  });

  describe("3. Mapeo al esquema TripHistory del contrato OpenAPI (toTripHistory)", () => {
    it("debe formatear cada transición con sequence, from, to, action, actor, occurredAt (ISO 8601), reason y detail", async () => {
      await tripService.createTrip(createSampleInput(), authSystem, correlationId);
      await tripService.cancelTrip(
        tripId,
        { reason: "VEHICLE_PROBLEM", detail: "Falla en batería" },
        authDriver,
        correlationId
      );

      const rows = await tripService.getTripHistory(tripId, authDriver);
      const mapped = toTripHistory(tripId, rows);

      expect(mapped.tripId).toBe(tripId);
      expect(mapped.transitions).toHaveLength(2);

      // 1ra transición (CREATE): sin reason ni detail
      expect(mapped.transitions[0]).toEqual({
        sequence: 1,
        from: null,
        to: "PENDING_ARRIVAL",
        action: "CREATE",
        actor: { role: "SYSTEM", id: "m5-dispatch-service" },
        occurredAt: rows[0]!.createdAt.toISOString(),
      });

      // 2da transición (CANCEL): incluye reason y detail
      expect(mapped.transitions[1]).toEqual({
        sequence: 2,
        from: "PENDING_ARRIVAL",
        to: "CANCELLED",
        action: "CANCEL",
        actor: { role: "DRIVER", id: driverId },
        occurredAt: rows[1]!.createdAt.toISOString(),
        reason: "VEHICLE_PROBLEM",
        detail: "Falla en batería",
      });
    });
  });
});
