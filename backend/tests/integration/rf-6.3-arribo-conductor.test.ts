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
} from "./helpers.js";

/**
 * RF-6.3: Arribo del conductor (Integracion)
 *
 * Prueba por HTTP real contra PostgreSQL el endpoint POST /trips/{id}/arrived:
 * - Transicion de PENDING_ARRIVAL a DRIVER_ARRIVED
 * - Actualizacion de version y cabecera ETag
 * - Emision del evento de dominio DriverArrived hacia M8
 * - Seguridad por roles (403 para CLIENT, OPERATOR y conductor no asignado)
 * - Validacion de identificador UUID (400) y viaje inexistente (404)
 * - Rechazo de arribo redundante o invalido (409)
 * - Precondiciones de concurrencia optimista con If-Match (412)
 * - Idempotencia con Idempotency-Key (200 con cabecera Idempotent-Replayed)
 *
 * Aislamiento funcional: no invoca endpoints de otros requisitos (RF-6.4, RF-6.5, RF-6.8).
 */
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

  // 7. Maquina de estados: rechaza transicion redundante si ya se registro arribo (409)
  it("responde 409 Conflict si se intenta marcar arribo cuando el viaje ya esta en DRIVER_ARRIVED", async () => {
    const { trip } = await createTrip();
    const driverToken = tokens.driver(trip.driverId);

    // Primer arribo: exitoso
    const primerArribo = await api("POST", `/trips/${trip.id}/arrived`, {
      token: driverToken,
    });
    expect(primerArribo.status).toBe(200);
    expect(primerArribo.body.state).toBe("DRIVER_ARRIVED");

    // Segundo arribo (sin Idempotency-Key): intento redundante no permitido
    const segundoArribo = await api("POST", `/trips/${trip.id}/arrived`, {
      token: driverToken,
    });
    expect(segundoArribo.status).toBe(409);
    expect(segundoArribo.body.code).toBe("INVALID_STATE_TRANSITION");
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
  it("soporta Idempotency-Key y reenvia el mismo 200 sin volver a aplicar la transicion", async () => {
    const { trip } = await createTrip();
    const driverToken = tokens.driver(trip.driverId);
    const key = `idemp-arrived-${crypto.randomUUID()}`;

    // Primer intento con la clave de idempotencia
    const primerIntento = await api("POST", `/trips/${trip.id}/arrived`, {
      token: driverToken,
      headers: { "idempotency-key": key },
    });
    expect(primerIntento.status).toBe(200);
    expect(primerIntento.body.state).toBe("DRIVER_ARRIVED");
    expect(primerIntento.body.version).toBe(2);

    // Segundo intento con la misma clave (simula que se corto internet y reintento)
    const segundoIntento = await api("POST", `/trips/${trip.id}/arrived`, {
      token: driverToken,
      headers: { "idempotency-key": key },
    });
    expect(segundoIntento.status).toBe(200);
    expect(segundoIntento.headers.get("idempotent-replayed")).toBe("true");
    expect(segundoIntento.body.state).toBe("DRIVER_ARRIVED");
    expect(segundoIntento.body.version).toBe(2);
  });
});