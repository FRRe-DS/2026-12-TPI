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
  newTripBody,
  createTrip,
} from "./helpers.js";

/** Cuántos eventos TripCreated se publicaron para un viaje. */
function createdEventsFor(tripId: string): number {
  return eventPublisher
    .getPublishedEvents()
    .filter((e) => e.tripId === tripId && e.eventType === "TripCreated").length;
}

describe("POST /trips (integracion)", () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(resetDatabase);

  it("crea el viaje: 201 con Location, ETag y TripCreated publicado una vez", async () => {
    const body = newTripBody();
    const res = await api("POST", "/trips", { token: tokens.system, body });

    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(res.headers.get("location")).toBe(`/trips/${res.body.id}`);
    expect(res.headers.get("etag")).toBe('"1"');
    expect(res.headers.get("ratelimit-limit")).not.toBeNull();
    expect(res.body).toMatchObject({
      requestId: body.requestId,
      clientId: body.clientId,
      driverId: body.driverId,
      vehicleId: body.vehicleId,
      vehicleType: "CAR",
      state: "PENDING_ARRIVAL",
      version: 1,
    });
    expect(createdEventsFor(res.body.id)).toBe(1);
  });

  it("el viaje creado se puede consultar con la URL del header Location", async () => {
    const { res } = await createTrip();
    const location = res.headers.get("location")!;

    const consulta = await api("GET", location, { token: tokens.system });

    expect(consulta.status).toBe(200);
    expect(consulta.body.id).toBe(res.body.id);
  });

  it("repetir el mismo requestId con los mismos datos responde 200, sin Location ni evento nuevo", async () => {
    const { body, res: primera } = await createTrip();

    const repetida = await api("POST", "/trips", { token: tokens.system, body });

    expect(repetida.status).toBe(200);
    expect(repetida.body.id).toBe(primera.body.id);
    expect(repetida.headers.get("etag")).toBe(primera.headers.get("etag"));
    expect(repetida.headers.get("location")).toBeNull();
    expect(createdEventsFor(primera.body.id)).toBe(1);
    expect(await prisma.trip.count()).toBe(1);
  });

  it("el mismo requestId con datos distintos responde 409 REQUEST_ID_CONFLICT y no crea otro viaje", async () => {
    const { body } = await createTrip();

    const conflicto = await api("POST", "/trips", {
      token: tokens.system,
      body: { ...body, destinationLatitude: -27.5 },
    });

    expect(conflicto.status).toBe(409);
    expect(conflicto.body.code).toBe("REQUEST_ID_CONFLICT");
    expect(await prisma.trip.count()).toBe(1);
  });

  it.each(["CLIENT", "DRIVER", "OPERATOR"])(
    "el rol %s no puede crear viajes: 403 FORBIDDEN",
    async (role) => {
      const res = await api("POST", "/trips", {
        token: `${role}:${crypto.randomUUID()}`,
        body: newTripBody(),
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
      expect(await prisma.trip.count()).toBe(0);
    }
  );

  it.each([
    { name: "vehicleType invalido", overrides: { vehicleType: "TRUCK" } },
    { name: "requestId que no es UUID", overrides: { requestId: "123" } },
    { name: "latitud fuera de rango", overrides: { originLatitude: 95 } },
  ])("$name responde 400 VALIDATION y no crea el viaje", async ({ overrides }) => {
    const res = await api("POST", "/trips", {
      token: tokens.system,
      body: newTripBody(overrides),
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
    expect(await prisma.trip.count()).toBe(0);
  });
});

describe("GET /trips/{id} (integracion)", () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(resetDatabase);

  it("devuelve 200 con ETag al cliente del viaje", async () => {
    const { trip } = await createTrip();

    const res = await api("GET", `/trips/${trip.id}`, { token: tokens.client(trip.clientId) });

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"1"');
    expect(res.body.id).toBe(trip.id);
    expect(res.body.state).toBe("PENDING_ARRIVAL");
  });

  it("If-None-Match con el ETag actual responde 304 sin cuerpo", async () => {
    const { trip } = await createTrip();

    const res = await api("GET", `/trips/${trip.id}`, {
      token: tokens.system,
      headers: { "If-None-Match": '"1"' },
    });

    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    expect(res.headers.get("etag")).toBe('"1"');
  });

  it("If-None-Match con otro ETag responde 200 con el viaje", async () => {
    const { trip } = await createTrip();

    const res = await api("GET", `/trips/${trip.id}`, {
      token: tokens.system,
      headers: { "If-None-Match": '"99"' },
    });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(trip.id);
  });

  const viewers: Array<{
    name: string;
    token: (t: { clientId: string; driverId: string }) => string;
  }> = [
    { name: "el DRIVER del viaje", token: (t) => tokens.driver(t.driverId) },
    { name: "un OPERATOR", token: () => tokens.operator() },
    { name: "el servicio SYSTEM", token: () => tokens.system },
  ];

  it.each(viewers)("$name puede consultar el viaje: 200", async ({ token }) => {
    const { trip } = await createTrip();

    const res = await api("GET", `/trips/${trip.id}`, { token: token(trip) });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(trip.id);
  });

  it.each([
    { name: "un CLIENT ajeno", token: () => tokens.client(crypto.randomUUID()) },
    { name: "un DRIVER ajeno", token: () => tokens.driver(crypto.randomUUID()) },
  ])("$name recibe 404 TRIP_NOT_FOUND (no se revela que existe)", async ({ token }) => {
    const { trip } = await createTrip();

    const res = await api("GET", `/trips/${trip.id}`, { token: token() });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("TRIP_NOT_FOUND");
  });

  it("un viaje que no existe responde 404 TRIP_NOT_FOUND", async () => {
    const res = await api("GET", `/trips/${crypto.randomUUID()}`, { token: tokens.system });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("TRIP_NOT_FOUND");
  });

  it("un id que no es UUID responde 400 VALIDATION", async () => {
    const res = await api("GET", "/trips/no-es-un-uuid", { token: tokens.system });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });
});