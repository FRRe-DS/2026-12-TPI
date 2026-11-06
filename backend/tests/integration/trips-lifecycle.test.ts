import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

/** Token de QR distinto en cada uso (el service los trata como de un solo uso). */
const qr = () => `qr-${crypto.randomUUID()}`;

/** Tipos de evento publicados para un viaje, ordenados alfabeticamente. */
function eventTypesFor(tripId: string): string[] {
  return eventPublisher
    .getPublishedEvents()
    .filter((e) => e.tripId === tripId)
    .map((e) => e.eventType)
    .sort();
}

function bodyFor(action: string): unknown {
  if (action === "start") return { verificationToken: qr() };
  if (action === "complete") return { distanceKm: 2 };
  return undefined;
}

describe("Ciclo de vida del viaje (integracion)", () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(resetDatabase);

  it("recorre arrived -> start -> complete, con ETag, closure, historial y eventos", async () => {
    const { trip } = await createTrip();
    const driver = tokens.driver(trip.driverId);

    // 1) El conductor llega: version 1 -> 2
    const arrived = await api("POST", `/trips/${trip.id}/arrived`, { token: driver });
    expect(arrived.status).toBe(200);
    expect(arrived.body.state).toBe("DRIVER_ARRIVED");
    expect(arrived.body.version).toBe(2);
    expect(arrived.headers.get("etag")).toBe('"2"');
    expect(arrived.body.arrivedAt).not.toBeNull();

    // 2) Inicia el viaje con el QR: version 2 -> 3
    const started = await api("POST", `/trips/${trip.id}/start`, {
      token: driver,
      body: { verificationToken: qr() },
    });
    expect(started.status).toBe(200);
    expect(started.body.state).toBe("IN_PROGRESS");
    expect(started.body.version).toBe(3);
    expect(started.headers.get("etag")).toBe('"3"');
    expect(started.body.startedAt).not.toBeNull();

    // 3) Finaliza el viaje: version 3 -> 4
    const completed = await api("POST", `/trips/${trip.id}/complete`, {
      token: driver,
      body: { distanceKm: 6.4, finalLatitude: -27.46, finalLongitude: -58.98 },
    });
    expect(completed.status).toBe(200);
    expect(completed.body.state).toBe("COMPLETED");
    expect(completed.body.version).toBe(4);
    expect(completed.headers.get("etag")).toBe('"4"');
    expect(completed.body.completedAt).not.toBeNull();
    expect(completed.body.distanceKm).toBe(6.4);
    expect(completed.body.durationMinutes).toBe(1);

    // closure.durationSeconds = completedAt - startedAt, calculado por el servidor
    const esperado = Math.round(
      (Date.parse(completed.body.completedAt) - Date.parse(completed.body.startedAt)) / 1000
    );
    expect(completed.body.closure).toEqual({
      distanceKm: 6.4,
      durationSeconds: esperado,
      finalLatitude: -27.46,
      finalLongitude: -58.98,
    });

    // El cliente ve el mismo cierre al consultar el viaje
    const consulta = await api("GET", `/trips/${trip.id}`, { token: tokens.client(trip.clientId) });
    expect(consulta.status).toBe(200);
    expect(consulta.body.closure).toEqual(completed.body.closure);
    expect(consulta.headers.get("etag")).toBe('"4"');

    // Historial no destructivo: una fila por transicion, en orden
    const historial = await api("GET", `/trips/${trip.id}/history`, {
      token: tokens.client(trip.clientId),
    });
    expect(historial.status).toBe(200);
    const filas = historial.body.transitions;
    expect(filas.map((f: any) => f.sequence)).toEqual([1, 2, 3, 4]);
    expect(filas.map((f: any) => f.action)).toEqual([
      "CREATE",
      "REGISTER_ARRIVAL",
      "START",
      "COMPLETE",
    ]);
    expect(filas.map((f: any) => f.from)).toEqual([
      null,
      "PENDING_ARRIVAL",
      "DRIVER_ARRIVED",
      "IN_PROGRESS",
    ]);
    expect(filas.map((f: any) => f.to)).toEqual([
      "PENDING_ARRIVAL",
      "DRIVER_ARRIVED",
      "IN_PROGRESS",
      "COMPLETED",
    ]);
    expect(filas.map((f: any) => f.actor.role)).toEqual(["SYSTEM", "DRIVER", "DRIVER", "DRIVER"]);

    // Un evento de dominio por cada paso
    expect(eventTypesFor(trip.id)).toEqual([
      "DriverArrived",
      "TripCompleted",
      "TripCreated",
      "TripStarted",
    ]);
  });

  describe("transiciones invalidas: 409", () => {
    const casos: Array<{
      name: string;
      setup: "DRIVER_ARRIVED" | "IN_PROGRESS" | "COMPLETED" | null;
      action: string;
      state: string;
    }> = [
      { name: "arrived repetido", setup: "DRIVER_ARRIVED", action: "arrived", state: "DRIVER_ARRIVED" },
      { name: "start sin haber llegado", setup: null, action: "start", state: "PENDING_ARRIVAL" },
      { name: "complete sin haber llegado", setup: null, action: "complete", state: "PENDING_ARRIVAL" },
      { name: "complete sin haber iniciado", setup: "DRIVER_ARRIVED", action: "complete", state: "DRIVER_ARRIVED" },
      { name: "start con el viaje ya iniciado", setup: "IN_PROGRESS", action: "start", state: "IN_PROGRESS" },
      { name: "complete con el viaje ya completado", setup: "COMPLETED", action: "complete", state: "COMPLETED" },
    ];

    it.each(casos)(
      "$name responde 409 INVALID_STATE_TRANSITION y no cambia el viaje",
      async ({ setup, action, state }) => {
        const { trip } = await createTrip();
        if (setup) await advanceTrip(trip, setup);

        const res = await api("POST", `/trips/${trip.id}/${action}`, {
          token: tokens.driver(trip.driverId),
          body: bodyFor(action),
        });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe("INVALID_STATE_TRANSITION");
        expect(res.body.currentState).toBe(state);

        const actual = await api("GET", `/trips/${trip.id}`, { token: tokens.system });
        expect(actual.body.state).toBe(state);
      }
    );
  });

  describe("quien puede actuar", () => {
    const noAutorizados: Array<{
      name: string;
      token: (t: { clientId: string }) => string;
    }> = [
      { name: "un DRIVER que no es el asignado", token: () => tokens.driver(crypto.randomUUID()) },
      { name: "el CLIENT del viaje", token: (t) => tokens.client(t.clientId) },
      { name: "un OPERATOR", token: () => tokens.operator() },
      { name: "el servicio SYSTEM", token: () => tokens.system },
    ];

    it.each(noAutorizados)(
      "$name no puede registrar el arribo: 403 FORBIDDEN y el viaje no cambia",
      async ({ token }) => {
        const { trip } = await createTrip();

        const res = await api("POST", `/trips/${trip.id}/arrived`, { token: token(trip) });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe("FORBIDDEN");

        const actual = await api("GET", `/trips/${trip.id}`, { token: tokens.system });
        expect(actual.body.state).toBe("PENDING_ARRIVAL");
        expect(actual.body.version).toBe(1);
      }
    );

    it("registrar el arribo de un viaje que no existe responde 404 TRIP_NOT_FOUND", async () => {
      const res = await api("POST", `/trips/${crypto.randomUUID()}/arrived`, {
        token: tokens.driver(crypto.randomUUID()),
      });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("TRIP_NOT_FOUND");
    });
  });

  describe("If-Match (concurrencia optimista)", () => {
    it("con una version vieja responde 412 PRECONDITION_FAILED con el ETag actual", async () => {
      const { trip } = await createTrip();
      await advanceTrip(trip, "DRIVER_ARRIVED"); // el viaje queda en la version 2

      const res = await api("POST", `/trips/${trip.id}/start`, {
        token: tokens.driver(trip.driverId),
        headers: { "If-Match": '"1"' },
        body: { verificationToken: qr() },
      });

      expect(res.status).toBe(412);
      expect(res.body.code).toBe("PRECONDITION_FAILED");
      expect(res.headers.get("etag")).toBe('"2"');

      const actual = await api("GET", `/trips/${trip.id}`, { token: tokens.system });
      expect(actual.body.state).toBe("DRIVER_ARRIVED");
    });

    it("con la version actual aplica la accion: 200", async () => {
      const { trip } = await createTrip();

      const res = await api("POST", `/trips/${trip.id}/arrived`, {
        token: tokens.driver(trip.driverId),
        headers: { "If-Match": '"1"' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBe('"2"');
    });

    it("mal formado (sin comillas) responde 400 VALIDATION", async () => {
      const { trip } = await createTrip();

      const res = await api("POST", `/trips/${trip.id}/arrived`, {
        token: tokens.driver(trip.driverId),
        headers: { "If-Match": "1" },
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION");
    });
  });

  describe("start: validacion del QR (M8 simulado)", () => {
    it.each(["invalid", "expired", "invalid_abc"])(
      "el token %s responde 422 INVALID_VERIFICATION_CODE y el viaje sigue en DRIVER_ARRIVED",
      async (verificationToken) => {
        const { trip } = await createTrip();
        await advanceTrip(trip, "DRIVER_ARRIVED");

        const res = await api("POST", `/trips/${trip.id}/start`, {
          token: tokens.driver(trip.driverId),
          body: { verificationToken },
        });

        expect(res.status).toBe(422);
        expect(res.body.code).toBe("INVALID_VERIFICATION_CODE");

        const actual = await api("GET", `/trips/${trip.id}`, { token: tokens.system });
        expect(actual.body.state).toBe("DRIVER_ARRIVED");
      }
    );

    it("un token ya usado en otro viaje responde 422 INVALID_VERIFICATION_CODE", async () => {
      const { trip: viajeA } = await createTrip();
      const { trip: viajeB } = await createTrip();
      await advanceTrip(viajeA, "DRIVER_ARRIVED");
      await advanceTrip(viajeB, "DRIVER_ARRIVED");
      const repetido = qr();

      const primero = await api("POST", `/trips/${viajeA.id}/start`, {
        token: tokens.driver(viajeA.driverId),
        body: { verificationToken: repetido },
      });
      const segundo = await api("POST", `/trips/${viajeB.id}/start`, {
        token: tokens.driver(viajeB.driverId),
        body: { verificationToken: repetido },
      });

      expect(primero.status).toBe(200);
      expect(segundo.status).toBe(422);
      expect(segundo.body.code).toBe("INVALID_VERIFICATION_CODE");
    });

    it("si M8 no responde (simulate_503) da 503 DEPENDENCY_UNAVAILABLE con Retry-After y el viaje no cambia", async () => {
      const { trip } = await createTrip();
      await advanceTrip(trip, "DRIVER_ARRIVED");

      const res = await api("POST", `/trips/${trip.id}/start`, {
        token: tokens.driver(trip.driverId),
        body: { verificationToken: "simulate_503" },
      });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe("DEPENDENCY_UNAVAILABLE");
      expect(res.headers.get("retry-after")).toBe("5");

      const actual = await api("GET", `/trips/${trip.id}`, { token: tokens.system });
      expect(actual.body.state).toBe("DRIVER_ARRIVED");
    });

    it("sin verificationToken responde 400 VALIDATION", async () => {
      const { trip } = await createTrip();
      await advanceTrip(trip, "DRIVER_ARRIVED");

      const res = await api("POST", `/trips/${trip.id}/start`, {
        token: tokens.driver(trip.driverId),
        body: {},
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION");
    });
  });

  describe("complete: validacion del cuerpo", () => {
    it.each([
      { name: "distanceKm menor a 0.1", body: { distanceKm: 0.05 } },
      { name: "sin distanceKm", body: {} },
    ])("$name responde 400 VALIDATION y el viaje sigue en curso", async ({ body }) => {
      const { trip } = await createTrip();
      await advanceTrip(trip, "IN_PROGRESS");

      const res = await api("POST", `/trips/${trip.id}/complete`, {
        token: tokens.driver(trip.driverId),
        body,
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION");

      const actual = await api("GET", `/trips/${trip.id}`, { token: tokens.system });
      expect(actual.body.state).toBe("IN_PROGRESS");
    });
  });
});