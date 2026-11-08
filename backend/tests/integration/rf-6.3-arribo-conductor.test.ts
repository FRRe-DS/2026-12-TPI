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

describe("RF-6.3: Arribo del conductor (POST /trips/{id}/arrived)", () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(resetDatabase);

  // 1. Camino feliz: el chofer asignado marca llegada
  it("permite al conductor asignado registrar arribo, avanza a DRIVER_ARRIVED y emite evento", async () => {
    const { trip } = await createTrip();
    const driverToken = tokens.driver(trip.driverId);

    const res = await api("POST", `/trips/${trip.id}/arrived`, {
      token: driverToken,
    });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("DRIVER_ARRIVED");
    expect(res.body.version).toBe(2);
    expect(res.headers.get("etag")).toBe('"2"');
    expect(res.body.arrivedAt).not.toBeNull();

    // Verificamos que se haya registrado en el historial de auditoria (RF-6.8)
    const historyRes = await api("GET", `/trips/${trip.id}/history`, {
      token: driverToken,
    });
    expect(historyRes.status).toBe(200);
    const transitions = historyRes.body.transitions;
    expect(transitions).toHaveLength(2); // CREATE + REGISTER_ARRIVAL
    expect(transitions[1].action).toBe("REGISTER_ARRIVAL");
    expect(transitions[1].from).toBe("PENDING_ARRIVAL");
    expect(transitions[1].to).toBe("DRIVER_ARRIVED");
    expect(transitions[1].actorRole).toBe("DRIVER");

    // Verificamos que se haya emitido el evento DriverArrived hacia M8
    const events = eventPublisher
      .getPublishedEvents()
      .filter((e) => e.tripId === trip.id && e.eventType === "DriverArrived");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      clientId: trip.clientId,
      driverId: trip.driverId,
    });
  });

  // 2. Seguridad: un cliente NO puede registrar el arribo
  it("rechaza con 403 Forbidden si un cliente intenta registrar el arribo", async () => {
    const { trip } = await createTrip();
    const clientToken = tokens.client(trip.clientId);

    const res = await api("POST", `/trips/${trip.id}/arrived`, {
      token: clientToken,
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  // 3. Seguridad: un operador NO puede registrar el arribo (solo el chofer asignado)
  it("rechaza con 403 Forbidden si un operador intenta registrar el arribo", async () => {
    const { trip } = await createTrip();

    const res = await api("POST", `/trips/${trip.id}/arrived`, {
      token: tokens.operator(),
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  // 4. Seguridad: otro chofer NO asignado al viaje NO puede marcar llegada
  it("rechaza con 403 Forbidden si otro chofer diferente intenta registrar el arribo", async () => {
    const { trip } = await createTrip();
    const otroDriverToken = tokens.driver(crypto.randomUUID());

    const res = await api("POST", `/trips/${trip.id}/arrived`, {
      token: otroDriverToken,
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  // 5. Validacion: tripId con formato invalido responde 400 Bad Request
  it("responde 400 Bad Request si el id no es un UUID valido", async () => {
    const res = await api("POST", `/trips/id-invalido-123/arrived`, {
      token: tokens.driver(crypto.randomUUID()),
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  // 6. Validacion: viaje inexistente responde 404 Not Found
  it("responde 404 Not Found si el viaje no existe", async () => {
    const fakeId = crypto.randomUUID();
    const res = await api("POST", `/trips/${fakeId}/arrived`, {
      token: tokens.driver(crypto.randomUUID()),
    });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("TRIP_NOT_FOUND");
  });

  // 7. Maquina de estados (RF-6.1): no permite arribo si el viaje ya inicio
  it("responde 409 Conflict si se intenta marcar arribo en un viaje IN_PROGRESS", async () => {
    const { trip } = await createTrip();
    await advanceTrip(trip, "IN_PROGRESS");

    const res = await api("POST", `/trips/${trip.id}/arrived`, {
      token: tokens.driver(trip.driverId),
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ILLEGAL_TRANSITION");
  });

  // 8. Concurrencia optimista (RNF-08): control de version con If-Match
  it("responde 412 Precondition Failed si el If-Match no coincide con la version actual", async () => {
    const { trip } = await createTrip();

    const res = await api("POST", `/trips/${trip.id}/arrived`, {
      token: tokens.driver(trip.driverId),
      headers: { "if-match": '"99"' }, // Version incorrecta
    });

    expect(res.status).toBe(412);
    expect(res.body.code).toBe("PRECONDITION_FAILED");
  });

  // 9. Idempotencia (RNF-09): reintentos con Idempotency-Key
  it("soporta Idempotency-Key y reenvia el mismo 200 sin duplicar transiciones de auditoria", async () => {
    const { trip } = await createTrip();
    const driverToken = tokens.driver(trip.driverId);
    const key = `idemp-arrived-${crypto.randomUUID()}`;

    // Primer intento
    const primerIntento = await api("POST", `/trips/${trip.id}/arrived`, {
      token: driverToken,
      headers: { "idempotency-key": key },
    });
    expect(primerIntento.status).toBe(200);
    expect(primerIntento.body.state).toBe("DRIVER_ARRIVED");

    // Segundo intento con la misma clave (simulando reintento por caida de conexion)
    const segundoIntento = await api("POST", `/trips/${trip.id}/arrived`, {
      token: driverToken,
      headers: { "idempotency-key": key },
    });
    expect(segundoIntento.status).toBe(200);
    expect(segundoIntento.headers.get("idempotent-replayed")).toBe("true");

    // Comprobamos que el historial solo tenga 2 filas (no creo una tercera duplicada)
    const historyRes = await api("GET", `/trips/${trip.id}/history`, {
      token: driverToken,
    });
    expect(historyRes.body.transitions).toHaveLength(2);
  });
});