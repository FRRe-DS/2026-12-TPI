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

const qr = () => `qr-${crypto.randomUUID()}`;
const newKey = () => crypto.randomUUID();

/** Cuantos eventos de un tipo se publicaron para un viaje. */
function countEvents(tripId: string, eventType: string): number {
  return eventPublisher
    .getPublishedEvents()
    .filter((e) => e.tripId === tripId && e.eventType === eventType).length;
}

describe("Idempotency-Key (integracion)", () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(resetDatabase);

  describe("el reintento con la misma clave devuelve la respuesta original", () => {
    it("arrived: 200 con Idempotent-Replayed y sin repetir la accion", async () => {
      const { trip } = await createTrip();
      const driver = tokens.driver(trip.driverId);
      const headers = { "Idempotency-Key": newKey() };

      const primera = await api("POST", `/trips/${trip.id}/arrived`, { token: driver, headers });
      const reintento = await api("POST", `/trips/${trip.id}/arrived`, { token: driver, headers });

      expect(primera.status).toBe(200);
      expect(primera.headers.get("idempotent-replayed")).toBeNull();
      expect(reintento.status).toBe(200);
      expect(reintento.headers.get("idempotent-replayed")).toBe("true");
      expect(reintento.headers.get("etag")).toBe(primera.headers.get("etag"));
      expect(reintento.body).toEqual(primera.body);

      // La accion se aplico una sola vez: un evento y una fila de historial por transicion
      expect(countEvents(trip.id, "DriverArrived")).toBe(1);
      const historial = await api("GET", `/trips/${trip.id}/history`, { token: tokens.operator() });
      expect(historial.body.transitions).toHaveLength(2);
      expect(await prisma.idempotencyKey.count()).toBe(1);
    });

    it("start: el reintento con el mismo QR da el 200 original y el QR no se vuelve a consumir", async () => {
      const { trip } = await createTrip();
      await advanceTrip(trip, "DRIVER_ARRIVED");
      const driver = tokens.driver(trip.driverId);
      const headers = { "Idempotency-Key": newKey() };
      const body = { verificationToken: qr() };

      const primera = await api("POST", `/trips/${trip.id}/start`, { token: driver, headers, body });
      const reintento = await api("POST", `/trips/${trip.id}/start`, { token: driver, headers, body });

      expect(primera.status).toBe(200);
      expect(reintento.status).toBe(200);
      expect(reintento.headers.get("idempotent-replayed")).toBe("true");
      expect(reintento.body).toEqual(primera.body);
      expect(reintento.body.state).toBe("IN_PROGRESS");
      expect(countEvents(trip.id, "TripStarted")).toBe(1);
    });

    it("complete: el reintento devuelve el mismo closure y TripCompleted se publica una sola vez", async () => {
      const { trip } = await createTrip();
      await advanceTrip(trip, "IN_PROGRESS");
      const driver = tokens.driver(trip.driverId);
      const headers = { "Idempotency-Key": newKey() };
      const body = { distanceKm: 6.4 };

      const primera = await api("POST", `/trips/${trip.id}/complete`, { token: driver, headers, body });
      const reintento = await api("POST", `/trips/${trip.id}/complete`, { token: driver, headers, body });

      expect(primera.status).toBe(200);
      expect(primera.body.closure).not.toBeNull();
      expect(reintento.status).toBe(200);
      expect(reintento.headers.get("idempotent-replayed")).toBe("true");
      expect(reintento.body.closure).toEqual(primera.body.closure);
      expect(countEvents(trip.id, "TripCompleted")).toBe(1);
    });

    it("cancel: el reintento devuelve la misma cancelacion y TripCancelled se publica una sola vez", async () => {
      const { trip } = await createTrip();
      const client = tokens.client(trip.clientId);
      const headers = { "Idempotency-Key": newKey() };
      const body = { reason: "CHANGE_OF_PLANS" };

      const primera = await api("POST", `/trips/${trip.id}/cancel`, { token: client, headers, body });
      const reintento = await api("POST", `/trips/${trip.id}/cancel`, { token: client, headers, body });

      expect(primera.status).toBe(200);
      expect(reintento.status).toBe(200);
      expect(reintento.headers.get("idempotent-replayed")).toBe("true");
      expect(reintento.body.cancellation).toEqual(primera.body.cancellation);
      expect(countEvents(trip.id, "TripCancelled")).toBe(1);
    });
  });

  describe("reutilizar la clave con otro pedido: 422 IDEMPOTENCY_KEY_REUSED", () => {
    it("con otro cuerpo (start con un QR distinto)", async () => {
      const { trip } = await createTrip();
      await advanceTrip(trip, "DRIVER_ARRIVED");
      const driver = tokens.driver(trip.driverId);
      const headers = { "Idempotency-Key": newKey() };

      const primera = await api("POST", `/trips/${trip.id}/start`, {
        token: driver,
        headers,
        body: { verificationToken: qr() },
      });
      const distinta = await api("POST", `/trips/${trip.id}/start`, {
        token: driver,
        headers,
        body: { verificationToken: qr() },
      });

      expect(primera.status).toBe(200);
      expect(distinta.status).toBe(422);
      expect(distinta.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    });

    it("con otra ruta (la clave de arrived usada en cancel) y el viaje no cambia", async () => {
      const { trip } = await createTrip();
      const driver = tokens.driver(trip.driverId);
      const headers = { "Idempotency-Key": newKey() };

      const arrived = await api("POST", `/trips/${trip.id}/arrived`, { token: driver, headers });
      const cancelar = await api("POST", `/trips/${trip.id}/cancel`, {
        token: driver,
        headers,
        body: { reason: "VEHICLE_PROBLEM" },
      });

      expect(arrived.status).toBe(200);
      expect(cancelar.status).toBe(422);
      expect(cancelar.body.code).toBe("IDEMPOTENCY_KEY_REUSED");

      const actual = await api("GET", `/trips/${trip.id}`, { token: tokens.system });
      expect(actual.body.state).toBe("DRIVER_ARRIVED");
    });
  });

  it("los errores no se guardan: tras un 409 se puede reintentar con la misma clave", async () => {
    const { trip } = await createTrip();
    const driver = tokens.driver(trip.driverId);
    const headers = { "Idempotency-Key": newKey() };
    const body = { verificationToken: qr() };

    // El viaje todavia no llego: start falla con 409 y la clave queda libre
    const fallido = await api("POST", `/trips/${trip.id}/start`, { token: driver, headers, body });
    expect(fallido.status).toBe(409);
    expect(fallido.body.code).toBe("INVALID_STATE_TRANSITION");
    expect(await prisma.idempotencyKey.count()).toBe(0);

    // Ahora el conductor llega y reintenta con la misma clave y el mismo cuerpo
    const arrived = await api("POST", `/trips/${trip.id}/arrived`, { token: driver });
    expect(arrived.status).toBe(200);

    const reintento = await api("POST", `/trips/${trip.id}/start`, { token: driver, headers, body });
    expect(reintento.status).toBe(200);
    expect(reintento.headers.get("idempotent-replayed")).toBeNull();
    expect(reintento.body.state).toBe("IN_PROGRESS");
  });

  it("la clave es por actor: dos conductores pueden usar el mismo valor sin chocar", async () => {
    const { trip: viajeA } = await createTrip();
    const { trip: viajeB } = await createTrip();
    const headers = { "Idempotency-Key": newKey() };

    const resA = await api("POST", `/trips/${viajeA.id}/arrived`, {
      token: tokens.driver(viajeA.driverId),
      headers,
    });
    const resB = await api("POST", `/trips/${viajeB.id}/arrived`, {
      token: tokens.driver(viajeB.driverId),
      headers,
    });

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.headers.get("idempotent-replayed")).toBeNull();
    expect(resB.headers.get("idempotent-replayed")).toBeNull();
    expect(await prisma.idempotencyKey.count()).toBe(2);
  });

  it("una clave de mas de 200 caracteres responde 400 VALIDATION y no aplica la accion", async () => {
    const { trip } = await createTrip();

    const res = await api("POST", `/trips/${trip.id}/arrived`, {
      token: tokens.driver(trip.driverId),
      headers: { "Idempotency-Key": "k".repeat(201) },
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");

    const actual = await api("GET", `/trips/${trip.id}`, { token: tokens.system });
    expect(actual.body.state).toBe("PENDING_ARRIVAL");
  });

  it("una clave vencida se descarta: el pedido se evalua de nuevo (aca da 409 porque el viaje ya llego)", async () => {
    const { trip } = await createTrip();
    const driver = tokens.driver(trip.driverId);
    const headers = { "Idempotency-Key": newKey() };

    const primera = await api("POST", `/trips/${trip.id}/arrived`, { token: driver, headers });
    expect(primera.status).toBe(200);

    // Simula que pasaron las 24 horas de vigencia
    await prisma.idempotencyKey.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const reintento = await api("POST", `/trips/${trip.id}/arrived`, { token: driver, headers });
    expect(reintento.status).toBe(409);
    expect(reintento.body.code).toBe("INVALID_STATE_TRANSITION");
    expect(reintento.headers.get("idempotent-replayed")).toBeNull();
  });
});