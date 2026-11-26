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

function cancelAsDriver(tripId: string, driverId: string, body: unknown) {
  return api("POST", `/trips/${tripId}/cancel`, {
    token: tokens.driver(driverId),
    body,
  });
}

async function stateOf(tripId: string): Promise<string> {
  const res = await api("GET", `/trips/${tripId}`, { token: tokens.system });
  return res.body.state;
}

describe("RF-6.7: Cancelación del viaje por Conductor (Integración HTTP)", () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(resetDatabase);

  it("200 OK: el conductor asignado cancela en PENDING_ARRIVAL, registra historial con requiresRedispatch=true y publica TripCancelled", async () => {
    const { trip } = await createTrip();

    const res = await cancelAsDriver(trip.id, trip.driverId, {
      reason: "VEHICLE_PROBLEM",
      detail: "Desperfecto mecánico en ruta",
    });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("CANCELLED");
    expect(res.body.version).toBe(2);
    expect(res.headers.get("etag")).toBe('"2"');
    expect(res.body.cancellation).toEqual({
      cancelledBy: "DRIVER",
      reason: "VEHICLE_PROBLEM",
      detail: "Desperfecto mecánico en ruta",
      previousState: "PENDING_ARRIVAL",
      requiresRedispatch: true,
    });

    // Verificar historial de transiciones (CREATE -> CANCEL)
    const historial = await api("GET", `/trips/${trip.id}/history`, {
      token: tokens.operator(),
    });
    expect(historial.status).toBe(200);
    expect(historial.body.transitions.map((t: any) => t.action)).toEqual([
      "CREATE",
      "CANCEL",
    ]);
    expect(historial.body.transitions[1]).toMatchObject({
      sequence: 2,
      from: "PENDING_ARRIVAL",
      to: "CANCELLED",
      actor: { role: "DRIVER", id: trip.driverId },
      reason: "VEHICLE_PROBLEM",
      detail: "Desperfecto mecánico en ruta",
    });

    // Verificar evento de dominio publicado
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
      detail: "Desperfecto mecánico en ruta",
      previousState: "PENDING_ARRIVAL",
      requiresRedispatch: true,
    });
  });

  it("200 OK: el conductor cancela con CLIENT_NO_SHOW pasado el plazo de 5 minutos y requiresRedispatch es false", async () => {
    const { trip } = await createTrip();
    await advanceTrip(trip, "DRIVER_ARRIVED");

    // Simular arribo hace 6 minutos (> 5 min reglamentarios)
    await prisma.trip.update({
      where: { id: trip.id },
      data: { arrivedAt: new Date(Date.now() - 6 * 60_000) },
    });

    const res = await cancelAsDriver(trip.id, trip.driverId, {
      reason: "CLIENT_NO_SHOW",
    });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("CANCELLED");
    expect(res.body.cancellation).toMatchObject({
      cancelledBy: "DRIVER",
      reason: "CLIENT_NO_SHOW",
      previousState: "DRIVER_ARRIVED",
      requiresRedispatch: false,
    });
  });

  it("422 REASON_NOT_ALLOWED: rechaza si usa CLIENT_NO_SHOW antes de los 5 minutos o un motivo de pasajero", async () => {
    const { trip } = await createTrip();
    await advanceTrip(trip, "DRIVER_ARRIVED");

    // Intento temprano de CLIENT_NO_SHOW
    const resTemprano = await cancelAsDriver(trip.id, trip.driverId, {
      reason: "CLIENT_NO_SHOW",
    });
    expect(resTemprano.status).toBe(422);
    expect(resTemprano.body.code).toBe("REASON_NOT_ALLOWED");
    expect(await stateOf(trip.id)).toBe("DRIVER_ARRIVED");

    // Intento con motivo exclusivo de cliente
    const resMotivoAjeno = await cancelAsDriver(trip.id, trip.driverId, {
      reason: "CHANGE_OF_PLANS",
    });
    expect(resMotivoAjeno.status).toBe(422);
    expect(resMotivoAjeno.body.code).toBe("REASON_NOT_ALLOWED");
  });

  it("403 FORBIDDEN: rechaza si el viaje ya está IN_PROGRESS o si intenta cancelar otro conductor", async () => {
    // Caso A: Viaje en curso (IN_PROGRESS)
    const { trip: tripEnCurso } = await createTrip();
    await advanceTrip(tripEnCurso, "IN_PROGRESS");

    const resEnCurso = await cancelAsDriver(
      tripEnCurso.id,
      tripEnCurso.driverId,
      { reason: "VEHICLE_PROBLEM" }
    );
    expect(resEnCurso.status).toBe(403);
    expect(resEnCurso.body.code).toBe("FORBIDDEN");
    expect(await stateOf(tripEnCurso.id)).toBe("IN_PROGRESS");

    // Caso B: Conductor ajeno al viaje
    const { trip: tripAjeno } = await createTrip();
    const otroDriverId = crypto.randomUUID();

    const resOtroConductor = await cancelAsDriver(tripAjeno.id, otroDriverId, {
      reason: "VEHICLE_PROBLEM",
    });
    expect(resOtroConductor.status).toBe(403);
    expect(resOtroConductor.body.code).toBe("FORBIDDEN");
    expect(await stateOf(tripAjeno.id)).toBe("PENDING_ARRIVAL");
  });

  it("409 INVALID_STATE_TRANSITION: rechaza si el viaje ya está COMPLETED o CANCELLED", async () => {
    const { trip } = await createTrip();
    await advanceTrip(trip, "COMPLETED");

    const res = await cancelAsDriver(trip.id, trip.driverId, {
      reason: "VEHICLE_PROBLEM",
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_STATE_TRANSITION");
    expect(res.body.currentState).toBe("COMPLETED");
  });
});