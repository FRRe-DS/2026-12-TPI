import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eventPublisher } from "../../src/services/event-publisher.service.js";
import { startServer, stopServer, resetDatabase, api, tokens, createTrip, advanceTrip } from "./helpers.js";

/** Eventos TripRated publicados para un viaje. */
function ratedEventsFor(tripId: string) {
  return eventPublisher
    .getPublishedEvents()
    .filter((e) => e.tripId === tripId && e.eventType === "TripRated");
}

/** Crea un viaje y lo deja COMPLETED. */
async function completedTrip() {
  const { trip } = await createTrip();
  await advanceTrip(trip, "COMPLETED");
  return trip;
}

describe("Calificaciones del viaje (integracion, RF-6.5)", () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(resetDatabase);

  it("el cliente y el conductor califican un viaje completado y se publica TripRated", async () => {
    const trip = await completedTrip();

    const delCliente = await api("POST", `/trips/${trip.id}/client-rating`, {
      token: tokens.client(trip.clientId),
      body: { score: 5, comment: "Muy buen viaje" },
    });
    expect(delCliente.status).toBe(201);
    expect(delCliente.body).toMatchObject({
      tripId: trip.id,
      ratedBy: "CLIENT",
      raterId: trip.clientId,
      ratedId: trip.driverId,
      score: 5,
      comment: "Muy buen viaje",
    });

    const delConductor = await api("POST", `/trips/${trip.id}/driver-rating`, {
      token: tokens.driver(trip.driverId),
      body: { score: 4 },
    });
    expect(delConductor.status).toBe(201);
    expect(delConductor.body).toMatchObject({
      ratedBy: "DRIVER",
      raterId: trip.driverId,
      ratedId: trip.clientId,
      score: 4,
      comment: null,
    });

    const eventos = ratedEventsFor(trip.id);
    expect(eventos).toHaveLength(2);
    expect(eventos.map((e) => e.payload).sort((a: any, b: any) => a.ratedBy.localeCompare(b.ratedBy)))
      .toEqual([
        { ratedBy: "CLIENT", raterId: trip.clientId, ratedId: trip.driverId, score: 5, comment: "Muy buen viaje" },
        { ratedBy: "DRIVER", raterId: trip.driverId, ratedId: trip.clientId, score: 4, comment: null },
      ]);
  });

  it("no permite calificar un viaje que no está COMPLETED", async () => {
    const { trip } = await createTrip();
    await advanceTrip(trip, "IN_PROGRESS");

    const res = await api("POST", `/trips/${trip.id}/client-rating`, {
      token: tokens.client(trip.clientId),
      body: { score: 5 },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TRIP_NOT_COMPLETED");
    expect(ratedEventsFor(trip.id)).toHaveLength(0);
  });

  it("cada participante califica una sola vez, incluso con pedidos simultáneos (RNF-08)", async () => {
    const trip = await completedTrip();
    const driver = tokens.driver(trip.driverId);

    // Dos pedidos al mismo tiempo: solo uno se guarda
    const [a, b] = await Promise.all([
      api("POST", `/trips/${trip.id}/driver-rating`, { token: driver, body: { score: 3 } }),
      api("POST", `/trips/${trip.id}/driver-rating`, { token: driver, body: { score: 3 } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);

    // Un reintento posterior también se rechaza
    const otra = await api("POST", `/trips/${trip.id}/driver-rating`, { token: driver, body: { score: 1 } });
    expect(otra.status).toBe(409);
    expect(otra.body.code).toBe("ALREADY_RATED");

    expect(ratedEventsFor(trip.id)).toHaveLength(1);
  });

  it("solo puede calificar el participante que corresponde (403)", async () => {
    const trip = await completedTrip();

    const otroCliente = await api("POST", `/trips/${trip.id}/client-rating`, {
      token: tokens.client(crypto.randomUUID()),
      body: { score: 5 },
    });
    expect(otroCliente.status).toBe(403);

    const conductorComoCliente = await api("POST", `/trips/${trip.id}/client-rating`, {
      token: tokens.driver(trip.driverId),
      body: { score: 5 },
    });
    expect(conductorComoCliente.status).toBe(403);
  });

  it("valida la nota y el comentario (400)", async () => {
    const trip = await completedTrip();
    const client = tokens.client(trip.clientId);

    for (const body of [{ score: 0 }, { score: 6 }, { score: 4.5 }, { score: "5" }, {}]) {
      const res = await api("POST", `/trips/${trip.id}/client-rating`, { token: client, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe("VALIDATION");
    }

    const largo = await api("POST", `/trips/${trip.id}/client-rating`, {
      token: client,
      body: { score: 5, comment: "x".repeat(501) },
    });
    expect(largo.status).toBe(400);

    // Nada de lo anterior quedó guardado: la calificación válida todavía se acepta
    const valida = await api("POST", `/trips/${trip.id}/client-rating`, { token: client, body: { score: 5 } });
    expect(valida.status).toBe(201);
  });

  it("responde 404 si el viaje no existe y 400 si el id no es un UUID", async () => {
    const noExiste = await api("POST", `/trips/${crypto.randomUUID()}/client-rating`, {
      token: tokens.client(crypto.randomUUID()),
      body: { score: 5 },
    });
    expect(noExiste.status).toBe(404);

    const idInvalido = await api("POST", `/trips/no-es-uuid/client-rating`, {
      token: tokens.client(crypto.randomUUID()),
      body: { score: 5 },
    });
    expect(idInvalido.status).toBe(400);
  });
});
