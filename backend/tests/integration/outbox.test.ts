import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/config/database.js";
import { tripRepository } from "../../src/config/services.js";
import { createDomainEvent, eventPublisher } from "../../src/services/event-publisher.service.js";
import {
  startServer,
  stopServer,
  resetDatabase,
  api,
  tokens,
  createTrip,
  advanceTrip,
  newTripBody,
} from "./helpers.js";

/** Filas de la outbox en el orden en que se van a enviar. */
const outbox = () => prisma.outboxEvent.findMany({ orderBy: { id: "asc" } });

describe("Outbox de eventos (integracion)", () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(resetDatabase);

  it("guarda un evento pendiente por cada cambio de estado, en orden y aunque no haya RabbitMQ", async () => {
    const { trip } = await createTrip();
    await advanceTrip(trip, "COMPLETED");

    const rows = await outbox();

    expect(rows.map((r) => r.eventType)).toEqual([
      "TripCreated",
      "DriverArrived",
      "TripStarted",
      "TripCompleted",
    ]);
    for (const row of rows) {
      expect(row.tripId).toBe(trip.id);
      expect(row.publishedAt).toBeNull();
      expect(row.attempts).toBe(0);
    }
  });

  it("el sobre guardado es el mismo que el del historial en memoria", async () => {
    const { trip } = await createTrip();

    const [row] = await outbox();
    const inMemory = eventPublisher.getPublishedEvents().find((e) => e.eventId === row!.eventId);

    expect(inMemory?.tripId).toBe(trip.id);
    expect(row!.envelope).toEqual(inMemory);
  });

  it("la cancelacion tambien deja su evento", async () => {
    const { trip } = await createTrip();
    const res = await api("POST", `/trips/${trip.id}/cancel`, {
      token: tokens.client(trip.clientId),
      body: { reason: "CHANGE_OF_PLANS" },
    });

    expect(res.status).toBe(200);
    expect((await outbox()).map((r) => r.eventType)).toEqual(["TripCreated", "TripCancelled"]);
  });

  it("una transicion rechazada no agrega eventos", async () => {
    const { trip } = await createTrip();
    const res = await api("POST", `/trips/${trip.id}/complete`, {
      token: tokens.driver(trip.driverId),
      body: { distanceKm: 2 },
    });

    expect(res.status).toBe(409);
    expect(await outbox()).toHaveLength(1);
  });

  it("repetir el mismo requestId no duplica el evento", async () => {
    const body = newTripBody();
    await api("POST", "/trips", { token: tokens.system, body });
    const replay = await api("POST", "/trips", { token: tokens.system, body });

    expect(replay.status).toBe(200);
    expect(await outbox()).toHaveLength(1);
  });

  it("si no se puede guardar el evento, tampoco cambia el viaje (misma transaccion)", async () => {
    const { trip } = await createTrip();
    const [existing] = await outbox();
    // Se fuerza la falla repitiendo un eventId, que es unico en la tabla.
    const repeated = {
      ...createDomainEvent("DriverArrived", trip.id, {
        clientId: trip.clientId,
        driverId: trip.driverId,
      }),
      eventId: existing!.eventId,
    };

    await expect(
      tripRepository.transitionStateAtomic({
        tripId: trip.id,
        expectedFromState: "PENDING_ARRIVAL",
        targetState: "DRIVER_ARRIVED",
        action: "REGISTER_ARRIVAL",
        actorId: trip.driverId,
        actorRole: "DRIVER",
        domainEvent: repeated,
      })
    ).rejects.toThrow();

    const stored = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
    expect(stored.state).toBe("PENDING_ARRIVAL");
    expect(await prisma.tripEventHistory.count({ where: { tripId: trip.id } })).toBe(1);
  });

  it("los viajes creados desde el panel generan un TripCreated completo", async () => {
    expect((await api("POST", "/api/seed")).status).toBe(201);
    expect((await api("POST", "/api/trips", { body: {} })).status).toBe(201);

    const rows = await outbox();

    expect(rows.map((r) => r.eventType)).toEqual(["TripCreated", "TripCreated"]);
    for (const row of rows) {
      expect(row.envelope).toMatchObject({
        payload: { vehicleType: "AUTO", originLatitude: expect.any(Number) },
      });
    }
  });
});