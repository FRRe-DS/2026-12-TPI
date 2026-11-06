import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/config/database.js";
import { eventPublisher } from "../../src/services/event-publisher.service.js";
import {
  startServer,
  stopServer,
  resetDatabase,
  api,
  tokens,
  createTrip,
  advanceTrip,
} from "./helpers.js";

type Role = "CLIENT" | "DRIVER" | "OPERATOR";
type Setup = "DRIVER_ARRIVED" | "IN_PROGRESS" | null;

/** Version del viaje en cada estado, antes de cancelar (create=1, arrived=2, start=3). */
const VERSION_BEFORE = { PENDING_ARRIVAL: 1, DRIVER_ARRIVED: 2, IN_PROGRESS: 3 } as const;

function tokenFor(role: Role, trip: { clientId: string; driverId: string }): string {
  if (role === "CLIENT") return tokens.client(trip.clientId);
  if (role === "DRIVER") return tokens.driver(trip.driverId);
  return tokens.operator();
}

/** Crea un viaje y lo lleva al estado pedido (null = se queda en PENDING_ARRIVAL). */
async function tripIn(setup: Setup) {
  const { trip } = await createTrip();
  if (setup) await advanceTrip(trip, setup);
  return trip;
}

function cancel(
  tripId: string,
  token: string,
  body: unknown,
  headers?: Record<string, string>
) {
  return api("POST", `/trips/${tripId}/cancel`, { token, body, headers });
}

async function stateOf(tripId: string): Promise<string> {
  const res = await api("GET", `/trips/${tripId}`, { token: tokens.system });
  return res.body.state;
}

describe("Cancelacion del viaje (integracion)", () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(resetDatabase);

  describe("cancelaciones validas: 200", () => {
    const validas: Array<{
      role: Role;
      from: keyof typeof VERSION_BEFORE;
      reason: string;
      redispatch: boolean;
    }> = [
      { role: "CLIENT", from: "PENDING_ARRIVAL", reason: "CHANGE_OF_PLANS", redispatch: false },
      { role: "CLIENT", from: "DRIVER_ARRIVED", reason: "DRIVER_NO_SHOW", redispatch: false },
      { role: "DRIVER", from: "PENDING_ARRIVAL", reason: "VEHICLE_PROBLEM", redispatch: true },
      { role: "DRIVER", from: "DRIVER_ARRIVED", reason: "ORIGIN_UNREACHABLE", redispatch: true },
      { role: "DRIVER", from: "DRIVER_ARRIVED", reason: "OTHER", redispatch: true },
      { role: "OPERATOR", from: "PENDING_ARRIVAL", reason: "SECURITY_INCIDENT", redispatch: false },
      { role: "OPERATOR", from: "DRIVER_ARRIVED", reason: "OTHER", redispatch: false },
      { role: "OPERATOR", from: "IN_PROGRESS", reason: "ADMINISTRATIVE_BLOCK", redispatch: false },
    ];

    it.each(validas)(
      "$role cancela desde $from con $reason: CANCELLED y requiresRedispatch=$redispatch",
      async ({ role, from, reason, redispatch }) => {
        const trip = await tripIn(from === "PENDING_ARRIVAL" ? null : from);

        const res = await cancel(trip.id, tokenFor(role, trip), {
          reason,
          detail: "Detalle de prueba",
        });

        const versionNueva = VERSION_BEFORE[from] + 1;
        expect(res.status).toBe(200);
        expect(res.body.state).toBe("CANCELLED");
        expect(res.body.version).toBe(versionNueva);
        expect(res.headers.get("etag")).toBe(`"${versionNueva}"`);
        expect(res.body.cancelledAt).not.toBeNull();
        expect(res.body.cancellation).toEqual({
          cancelledBy: role,
          reason,
          detail: "Detalle de prueba",
          previousState: from,
          requiresRedispatch: redispatch,
        });
      }
    );

    it("el DRIVER puede cancelar con CLIENT_NO_SHOW pasado el plazo y no hay re-despacho", async () => {
      const trip = await tripIn("DRIVER_ARRIVED");
      // Simula que el conductor llego hace una hora (el plazo es de 5 minutos).
      await prisma.trip.update({
        where: { id: trip.id },
        data: { arrivedAt: new Date(Date.now() - 60 * 60_000) },
      });

      const res = await cancel(trip.id, tokens.driver(trip.driverId), { reason: "CLIENT_NO_SHOW" });

      expect(res.status).toBe(200);
      expect(res.body.cancellation).toMatchObject({
        cancelledBy: "DRIVER",
        reason: "CLIENT_NO_SHOW",
        previousState: "DRIVER_ARRIVED",
        requiresRedispatch: false,
      });
    });
  });

  describe("motivo que no corresponde: 422 REASON_NOT_ALLOWED", () => {
    const rechazos: Array<{ name: string; role: Role; setup: Setup; reason: string }> = [
      { name: "CLIENT con VEHICLE_PROBLEM", role: "CLIENT", setup: null, reason: "VEHICLE_PROBLEM" },
      { name: "CLIENT con CLIENT_NO_SHOW", role: "CLIENT", setup: null, reason: "CLIENT_NO_SHOW" },
      { name: "CLIENT con SECURITY_INCIDENT", role: "CLIENT", setup: null, reason: "SECURITY_INCIDENT" },
      { name: "DRIVER con CHANGE_OF_PLANS", role: "DRIVER", setup: null, reason: "CHANGE_OF_PLANS" },
      { name: "DRIVER con SECURITY_INCIDENT", role: "DRIVER", setup: null, reason: "SECURITY_INCIDENT" },
      { name: "OPERATOR con CHANGE_OF_PLANS", role: "OPERATOR", setup: null, reason: "CHANGE_OF_PLANS" },
      { name: "OPERATOR con CLIENT_NO_SHOW", role: "OPERATOR", setup: null, reason: "CLIENT_NO_SHOW" },
      { name: "DRIVER con CLIENT_NO_SHOW antes del plazo de 5 minutos", role: "DRIVER", setup: "DRIVER_ARRIVED", reason: "CLIENT_NO_SHOW" },
      { name: "DRIVER con CLIENT_NO_SHOW sin haber llegado", role: "DRIVER", setup: null, reason: "CLIENT_NO_SHOW" },
    ];

    it.each(rechazos)("$name responde 422 y el viaje no cambia", async ({ role, setup, reason }) => {
      const trip = await tripIn(setup);

      const res = await cancel(trip.id, tokenFor(role, trip), { reason });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("REASON_NOT_ALLOWED");
      expect(await stateOf(trip.id)).toBe(setup ?? "PENDING_ARRIVAL");
    });
  });

  describe("estado y rol", () => {
    it("un viaje COMPLETED no se puede cancelar: 409 INVALID_STATE_TRANSITION", async () => {
      const { trip } = await createTrip();
      await advanceTrip(trip, "COMPLETED");

      const res = await cancel(trip.id, tokens.operator(), { reason: "OTHER" });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("INVALID_STATE_TRANSITION");
      expect(res.body.currentState).toBe("COMPLETED");
    });

    it("un viaje ya CANCELLED no se puede cancelar otra vez: 409 INVALID_STATE_TRANSITION", async () => {
      const trip = await tripIn(null);
      const token = tokens.client(trip.clientId);
      await cancel(trip.id, token, { reason: "CHANGE_OF_PLANS" });

      const res = await cancel(trip.id, token, { reason: "CHANGE_OF_PLANS" });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("INVALID_STATE_TRANSITION");
      expect(res.body.currentState).toBe("CANCELLED");
    });

    it.each(["CLIENT", "DRIVER"] as Role[])(
      "el %s no puede cancelar un viaje IN_PROGRESS: 403 FORBIDDEN y sigue en curso",
      async (role) => {
        const trip = await tripIn("IN_PROGRESS");
        const reason = role === "CLIENT" ? "CHANGE_OF_PLANS" : "VEHICLE_PROBLEM";

        const res = await cancel(trip.id, tokenFor(role, trip), { reason });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe("FORBIDDEN");
        expect(await stateOf(trip.id)).toBe("IN_PROGRESS");
      }
    );

    it("un viaje cancelado no admite mas acciones: arrived da 409 con currentState CANCELLED", async () => {
      const trip = await tripIn(null);
      await cancel(trip.id, tokens.client(trip.clientId), { reason: "CHANGE_OF_PLANS" });

      const res = await api("POST", `/trips/${trip.id}/arrived`, {
        token: tokens.driver(trip.driverId),
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("INVALID_STATE_TRANSITION");
      expect(res.body.currentState).toBe("CANCELLED");
    });
  });

  describe("quien puede cancelar", () => {
    it.each([
      { name: "un CLIENT ajeno", token: () => tokens.client(crypto.randomUUID()) },
      { name: "un DRIVER ajeno", token: () => tokens.driver(crypto.randomUUID()) },
      { name: "el servicio SYSTEM", token: () => tokens.system },
    ])("$name no puede cancelar: 403 FORBIDDEN y el viaje no cambia", async ({ token }) => {
      const trip = await tripIn(null);

      const res = await cancel(trip.id, token(), { reason: "OTHER" });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
      expect(await stateOf(trip.id)).toBe("PENDING_ARRIVAL");
    });

    it("cancelar un viaje que no existe responde 404 TRIP_NOT_FOUND", async () => {
      const res = await cancel(crypto.randomUUID(), tokens.operator(), { reason: "OTHER" });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("TRIP_NOT_FOUND");
    });
  });

  describe("validacion del cuerpo: 400 VALIDATION", () => {
    it.each([
      { name: "un reason que no existe", body: { reason: "INVENTADO" } },
      { name: "sin reason", body: {} },
      { name: "un detail de mas de 500 caracteres", body: { reason: "OTHER", detail: "x".repeat(501) } },
    ])("$name responde 400 y el viaje no cambia", async ({ body }) => {
      const trip = await tripIn(null);

      const res = await cancel(trip.id, tokens.client(trip.clientId), body);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION");
      expect(await stateOf(trip.id)).toBe("PENDING_ARRIVAL");
    });
  });

  it("If-Match con una version vieja responde 412 PRECONDITION_FAILED y no cancela", async () => {
    const trip = await tripIn("DRIVER_ARRIVED"); // version 2

    const res = await cancel(
      trip.id,
      tokens.client(trip.clientId),
      { reason: "CHANGE_OF_PLANS" },
      { "If-Match": '"1"' }
    );

    expect(res.status).toBe(412);
    expect(res.body.code).toBe("PRECONDITION_FAILED");
    expect(res.headers.get("etag")).toBe('"2"');
    expect(await stateOf(trip.id)).toBe("DRIVER_ARRIVED");
  });

  it("deja el historial y publica TripCancelled con el payload del contrato", async () => {
    const { trip } = await createTrip();

    const res = await cancel(trip.id, tokens.driver(trip.driverId), {
      reason: "VEHICLE_PROBLEM",
      detail: "Se pincho una rueda",
    });
    expect(res.status).toBe(200);

    const historial = await api("GET", `/trips/${trip.id}/history`, { token: tokens.operator() });
    expect(historial.status).toBe(200);
    const filas = historial.body.transitions;
    expect(filas.map((f: any) => f.action)).toEqual(["CREATE", "CANCEL"]);
    expect(filas[1]).toMatchObject({
      sequence: 2,
      from: "PENDING_ARRIVAL",
      to: "CANCELLED",
      actor: { role: "DRIVER", id: trip.driverId },
      reason: "VEHICLE_PROBLEM",
      detail: "Se pincho una rueda",
    });

    const evento = eventPublisher
      .getPublishedEvents()
      .find((e) => e.tripId === trip.id && e.eventType === "TripCancelled") as any;
    expect(evento).toBeDefined();
    expect(evento.payload).toMatchObject({
      requestId: trip.requestId,
      clientId: trip.clientId,
      driverId: trip.driverId,
      cancelledBy: "DRIVER",
      reason: "VEHICLE_PROBLEM",
      detail: "Se pincho una rueda",
      previousState: "PENDING_ARRIVAL",
      requiresRedispatch: true,
    });
    expect(typeof evento.payload.secondsSinceCreation).toBe("number");
  });
});