import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startServer,
  stopServer,
  resetDatabase,
  api,
  tokens,
  createTrip,
  advanceTrip,
} from "./helpers.js";

/**
 * RF-6.2 (Consulta de estado): integracion por HTTP contra la base real.
 *
 * Alcance: quien puede consultar GET /trips/{id}, que devuelve y como se comporta
 * con ETag / If-None-Match (RNF-08) y con pedidos no autorizados (RNF-12 / RNF-19).
 *
 * Fuera de alcance: las transiciones (RF-6.1), el arribo (RF-6.3), el inicio con QR
 * (RF-6.4), las cancelaciones (RF-6.6 / RF-6.7) y el historial (RF-6.8). advanceTrip
 * se usa solo como preparacion, no se afirma nada sobre la transicion.
 */
describe("RF-6.2: consulta de estado del viaje (integracion)", () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(resetDatabase);

  const get = (tripId: string, options: Parameters<typeof api>[2] = {}) =>
    api("GET", `/trips/${tripId}`, options);

  describe("roles autorizados", () => {
    it("el CLIENT titular obtiene 200 con el estado actual y los datos del viaje", async () => {
      const { trip } = await createTrip();

      const res = await get(trip.id, { token: tokens.client(trip.clientId) });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: trip.id,
        clientId: trip.clientId,
        driverId: trip.driverId,
        vehicleType: "AUTO",
        state: "PENDING_ARRIVAL",
        version: 1,
      });
      expect(typeof res.body.createdAt).toBe("string");
      expect(res.body.arrivedAt).toBeNull();
      expect(res.body.startedAt).toBeNull();
      expect(res.body.completedAt).toBeNull();
    });

    it("el DRIVER asignado obtiene 200", async () => {
      const { trip } = await createTrip();

      const res = await get(trip.id, { token: tokens.driver(trip.driverId) });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(trip.id);
      expect(res.body.state).toBe("PENDING_ARRIVAL");
    });

    it("un OPERATOR obtiene 200 de un viaje que no es suyo", async () => {
      const { trip } = await createTrip();

      const res = await get(trip.id, { token: tokens.operator() });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(trip.id);
    });

    it("el servicio SYSTEM obtiene 200", async () => {
      const { trip } = await createTrip();

      const res = await get(trip.id, { token: tokens.system });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(trip.id);
    });
  });

  describe("roles no autorizados: 404 para no revelar que el viaje existe (RNF-19)", () => {
    it("un CLIENT ajeno recibe 404 TRIP_NOT_FOUND en problem+json", async () => {
      const { trip } = await createTrip();

      const res = await get(trip.id, { token: tokens.client(crypto.randomUUID()) });

      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(res.body.code).toBe("TRIP_NOT_FOUND");
    });

    it("un DRIVER que no es el asignado recibe 404 TRIP_NOT_FOUND", async () => {
      const { trip } = await createTrip();

      const res = await get(trip.id, { token: tokens.driver(crypto.randomUUID()) });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("TRIP_NOT_FOUND");
    });

    it("sin credencial valida responde 401 UNAUTHENTICATED en problem+json", async () => {
      const { trip } = await createTrip();

      const res = await get(trip.id);

      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(res.body.code).toBe("UNAUTHENTICATED");
    });

    it("una credencial con formato invalido tambien responde 401 UNAUTHENTICATED", async () => {
      const { trip } = await createTrip();

      const res = await get(trip.id, {
        headers: { Authorization: "Bearer token-invalido" },
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHENTICATED");
    });
  });

  describe("pedidos invalidos", () => {
    it("un id que no es UUID responde 400 VALIDATION", async () => {
      const res = await get("no-es-un-uuid", { token: tokens.operator() });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION");
    });

    it("un viaje inexistente responde 404 TRIP_NOT_FOUND", async () => {
      const res = await get(crypto.randomUUID(), { token: tokens.operator() });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("TRIP_NOT_FOUND");
    });
  });

  describe("ETag y GET condicional (RNF-08)", () => {
    it("el ETag coincide con la version del viaje", async () => {
      const { trip } = await createTrip();

      const res = await get(trip.id, { token: tokens.client(trip.clientId) });

      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBe('"1"');
      expect(res.body.version).toBe(1);
    });

    it("el 200 responde application/json y siempre incluye ETag", async () => {
      const { trip } = await createTrip();

      const res = await get(trip.id, { token: tokens.operator() });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("etag")).not.toBeNull();
    });

    it("If-None-Match con el ETag actual responde 304 sin cuerpo", async () => {
      const { trip } = await createTrip();
      const token = tokens.client(trip.clientId);

      const res = await get(trip.id, {
        token,
        headers: { "if-none-match": '"1"' },
      });

      expect(res.status).toBe(304);
      expect(res.body).toBeNull();
      expect(res.headers.get("etag")).toBe('"1"');
    });

    it("If-None-Match con otro ETag responde 200 con el viaje", async () => {
      const { trip } = await createTrip();

      const res = await get(trip.id, {
        token: tokens.client(trip.clientId),
        headers: { "if-none-match": '"99"' },
      });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(trip.id);
    });
  });

  describe("consulta en cualquier estado del viaje", () => {
    it("un OPERATOR consulta un viaje COMPLETED: 200 con el estado final", async () => {
      const { trip } = await createTrip();
      await advanceTrip(trip, "COMPLETED");

      const res = await get(trip.id, { token: tokens.operator() });

      expect(res.status).toBe(200);
      expect(res.body.state).toBe("COMPLETED");
      expect(res.body.version).toBe(4);
    });
  });

  describe("la consulta refleja el estado actualizado", () => {
    it("despues de un arribo devuelve el estado y la version nuevos, y el ETag anterior ya no da 304", async () => {
      const { trip } = await createTrip();
      const token = tokens.client(trip.clientId);

      await advanceTrip(trip, "DRIVER_ARRIVED");

      const actual = await get(trip.id, { token });
      expect(actual.status).toBe(200);
      expect(actual.body.state).toBe("DRIVER_ARRIVED");
      expect(actual.body.version).toBe(2);
      expect(actual.headers.get("etag")).toBe('"2"');

      // El ETag viejo ya no representa la version actual: no debe responder 304.
      const conEtagViejo = await get(trip.id, {
        token,
        headers: { "if-none-match": '"1"' },
      });
      expect(conEtagViejo.status).toBe(200);
      expect(conEtagViejo.body.state).toBe("DRIVER_ARRIVED");

      const conEtagActual = await get(trip.id, {
        token,
        headers: { "if-none-match": '"2"' },
      });
      expect(conEtagActual.status).toBe(304);
    });
  });
});
