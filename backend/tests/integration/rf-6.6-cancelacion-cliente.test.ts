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

/**
 * RF-6.6 (Cancelacion por cliente): cancelacion con motivo del catalogo y tiempo transcurrido
 * para que M7 evalue un eventual cargo. Prueba por HTTP contra la base de tests.
 * Este archivo es autosuficiente: no depende de trips-cancellation ni de trips-idempotency.
 * Las reglas puras (catalogo, re-despacho, maquina de estados) estan en el unitario
 * tests/rf-6.6-cancelacion-cliente.test.ts.
 */

type Desde = "PENDING_ARRIVAL" | "DRIVER_ARRIVED";
type Viaje = { id: string; requestId: string; clientId: string; driverId: string };

const MOTIVOS_CLIENTE = ["CHANGE_OF_PLANS", "EXCESSIVE_DELAY", "DRIVER_NO_SHOW", "OTHER"] as const;

/** Version del viaje antes de cancelar: create = 1, arrived = 2. */
const VERSION_ANTES: Record<Desde, number> = { PENDING_ARRIVAL: 1, DRIVER_ARRIVED: 2 };

/** Crea un viaje y lo deja en el estado pedido. */
async function viajeEn(estado: Desde | "IN_PROGRESS" | "COMPLETED"): Promise<Viaje> {
  const { trip } = await createTrip();
  if (estado !== "PENDING_ARRIVAL") await advanceTrip(trip, estado);
  return trip;
}

function cancelar(viaje: Viaje, body: unknown, opciones: { token?: string; headers?: Record<string, string> } = {}) {
  return api("POST", `/trips/${viaje.id}/cancel`, {
    token: opciones.token ?? tokens.client(viaje.clientId),
    body,
    ...(opciones.headers ? { headers: opciones.headers } : {}),
  });
}

async function estadoDe(tripId: string): Promise<string> {
  const res = await api("GET", `/trips/${tripId}`, { token: tokens.operator() });
  return res.body.state;
}

/** Eventos TripCancelled publicados para un viaje. */
function eventosCancelacion(tripId: string): any[] {
  return eventPublisher
    .getPublishedEvents()
    .filter((e) => e.tripId === tripId && e.eventType === "TripCancelled");
}

describe("RF-6.6: Cancelacion por cliente (POST /trips/{id}/cancel)", () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(resetDatabase);

  // 1. Camino feliz: los 4 motivos del cliente desde los 2 estados permitidos
  describe("cancelaciones validas: 200", () => {
    const casos = (["PENDING_ARRIVAL", "DRIVER_ARRIVED"] as Desde[]).flatMap((desde) =>
      MOTIVOS_CLIENTE.map((motivo) => ({ desde, motivo }))
    );

    it.each(casos)("cancela desde $desde con $motivo", async ({ desde, motivo }) => {
      const viaje = await viajeEn(desde);

      const res = await cancelar(viaje, { reason: motivo, detail: "Detalle del cliente" });

      const version = VERSION_ANTES[desde] + 1;
      expect(res.status).toBe(200);
      expect(res.body.state).toBe("CANCELLED");
      expect(res.body.version).toBe(version);
      expect(res.headers.get("etag")).toBe(`"${version}"`);
      expect(res.body.cancelledAt).not.toBeNull();
      expect(res.body.cancellation).toEqual({
        cancelledBy: "CLIENT",
        reason: motivo,
        detail: "Detalle del cliente",
        previousState: desde,
        requiresRedispatch: false,
      });
    });

    it("detail es opcional: sin detail cancela y la respuesta no lo incluye", async () => {
      const viaje = await viajeEn("PENDING_ARRIVAL");

      const res = await cancelar(viaje, { reason: "CHANGE_OF_PLANS" });

      expect(res.status).toBe(200);
      expect(res.body.cancellation).not.toHaveProperty("detail");
    });
  });

  // 2. Tiempo transcurrido para M7: es el nucleo del requisito
  describe("tiempo transcurrido para el cargo de M7", () => {
    it("TripCancelled lleva secondsSinceCreation igual al tiempo desde la creacion del viaje", async () => {
      const viaje = await viajeEn("DRIVER_ARRIVED");
      // Simula que el viaje se creo hace 10 minutos.
      await prisma.trip.update({
        where: { id: viaje.id },
        data: { createdAt: new Date(Date.now() - 10 * 60_000) },
      });

      const res = await cancelar(viaje, { reason: "EXCESSIVE_DELAY" });
      expect(res.status).toBe(200);

      const eventos = eventosCancelacion(viaje.id);
      expect(eventos).toHaveLength(1);
      const segundos = eventos[0].payload.secondsSinceCreation;
      expect(Number.isInteger(segundos)).toBe(true);
      expect(segundos).toBeGreaterThanOrEqual(600);
      expect(segundos).toBeLessThan(610);

      // El mismo valor queda guardado en el historial (metadata de la fila CANCEL).
      const fila = await prisma.tripEventHistory.findFirst({
        where: { tripId: viaje.id, action: "CANCEL" },
      });
      expect((fila?.metadata as any)?.secondsSinceCreation).toBe(segundos);
    });

    it("un viaje recien creado informa un tiempo cercano a 0", async () => {
      const viaje = await viajeEn("PENDING_ARRIVAL");

      await cancelar(viaje, { reason: "CHANGE_OF_PLANS" });

      const segundos = eventosCancelacion(viaje.id)[0]?.payload.secondsSinceCreation;
      expect(segundos).toBeGreaterThanOrEqual(0);
      expect(segundos).toBeLessThan(10);
    });
  });

  // 3. Evento e historial (RF-6.8 / RNF-03)
  describe("evento e historial", () => {
    it("publica un unico TripCancelled con el payload del contrato", async () => {
      const viaje = await viajeEn("DRIVER_ARRIVED");

      await cancelar(viaje, { reason: "DRIVER_NO_SHOW", detail: "No lo veo en el punto" });

      const eventos = eventosCancelacion(viaje.id);
      expect(eventos).toHaveLength(1);
      expect(eventos[0].payload).toMatchObject({
        requestId: viaje.requestId,
        clientId: viaje.clientId,
        driverId: viaje.driverId,
        cancelledBy: "CLIENT",
        reason: "DRIVER_NO_SHOW",
        detail: "No lo veo en el punto",
        previousState: "DRIVER_ARRIVED",
        requiresRedispatch: false,
      });
    });

    it("agrega una fila CANCEL al historial con el cliente como actor", async () => {
      const viaje = await viajeEn("PENDING_ARRIVAL");

      await cancelar(viaje, { reason: "OTHER", detail: "Me equivoque de destino" });

      const historial = await api("GET", `/trips/${viaje.id}/history`, {
        token: tokens.client(viaje.clientId),
      });
      expect(historial.status).toBe(200);
      const filas = historial.body.transitions;
      expect(filas.map((f: any) => f.action)).toEqual(["CREATE", "CANCEL"]);
      expect(filas[1]).toMatchObject({
        sequence: 2,
        from: "PENDING_ARRIVAL",
        to: "CANCELLED",
        actor: { role: "CLIENT", id: viaje.clientId },
        reason: "OTHER",
        detail: "Me equivoque de destino",
      });
    });
  });

  // 4. Rechazos: el viaje no cambia y no se publica evento
  describe("rechazos", () => {
    it.each(["VEHICLE_PROBLEM", "CLIENT_NO_SHOW", "ORIGIN_UNREACHABLE", "SECURITY_INCIDENT", "ADMINISTRATIVE_BLOCK"])(
      "un motivo de otro rol (%s) responde 422 REASON_NOT_ALLOWED",
      async (motivo) => {
        const viaje = await viajeEn("PENDING_ARRIVAL");

        const res = await cancelar(viaje, { reason: motivo });

        expect(res.status).toBe(422);
        expect(res.body.code).toBe("REASON_NOT_ALLOWED");
        expect(await estadoDe(viaje.id)).toBe("PENDING_ARRIVAL");
        expect(eventosCancelacion(viaje.id)).toHaveLength(0);
      }
    );

    it.each([
      { nombre: "sin reason", body: {} },
      { nombre: "un reason que no existe", body: { reason: "ME_ABURRI" } },
      { nombre: "un detail de mas de 500 caracteres", body: { reason: "OTHER", detail: "x".repeat(501) } },
    ])("$nombre responde 400 VALIDATION", async ({ body }) => {
      const viaje = await viajeEn("PENDING_ARRIVAL");

      const res = await cancelar(viaje, body);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION");
      expect(await estadoDe(viaje.id)).toBe("PENDING_ARRIVAL");
    });

    it("un cliente que no es el del viaje recibe 403 FORBIDDEN", async () => {
      const viaje = await viajeEn("PENDING_ARRIVAL");

      const res = await cancelar(viaje, { reason: "CHANGE_OF_PLANS" }, {
        token: tokens.client(crypto.randomUUID()),
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
      expect(await estadoDe(viaje.id)).toBe("PENDING_ARRIVAL");
      expect(eventosCancelacion(viaje.id)).toHaveLength(0);
    });

    // Comportamiento actual: la transicion IN_PROGRESS -> CANCELLED existe solo para OPERATOR,
    // asi que el cliente recibe 403 (rol) y no 409 (estado). Pendiente de confirmar con el grupo y el G5.
    it("con el viaje en curso (IN_PROGRESS) responde 403 FORBIDDEN y sigue en curso", async () => {
      const viaje = await viajeEn("IN_PROGRESS");

      const res = await cancelar(viaje, { reason: "CHANGE_OF_PLANS" });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
      expect(await estadoDe(viaje.id)).toBe("IN_PROGRESS");
    });

    it("un viaje COMPLETED responde 409 INVALID_STATE_TRANSITION", async () => {
      const viaje = await viajeEn("COMPLETED");

      const res = await cancelar(viaje, { reason: "CHANGE_OF_PLANS" });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("INVALID_STATE_TRANSITION");
      expect(res.body.currentState).toBe("COMPLETED");
    });

    it("cancelar dos veces: la segunda responde 409 y hay un solo evento", async () => {
      const viaje = await viajeEn("PENDING_ARRIVAL");
      await cancelar(viaje, { reason: "CHANGE_OF_PLANS" });

      const res = await cancelar(viaje, { reason: "CHANGE_OF_PLANS" });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("INVALID_STATE_TRANSITION");
      expect(res.body.currentState).toBe("CANCELLED");
      expect(eventosCancelacion(viaje.id)).toHaveLength(1);
    });
  });

  // 5. Concurrencia (RNF-08) e idempotencia (RNF-09)
  describe("concurrencia e idempotencia", () => {
    it("cliente y conductor cancelan a la vez: una sola cancelacion gana y hay un solo evento", async () => {
      const viaje = await viajeEn("DRIVER_ARRIVED");

      const [delCliente, delConductor] = await Promise.all([
        cancelar(viaje, { reason: "CHANGE_OF_PLANS" }),
        cancelar(viaje, { reason: "VEHICLE_PROBLEM" }, { token: tokens.driver(viaje.driverId) }),
      ]);

      const estados = [delCliente.status, delConductor.status].sort();
      expect(estados).toEqual([200, 409]);
      const perdedor = delCliente.status === 409 ? delCliente : delConductor;
      expect(["CONCURRENCY_CONFLICT", "INVALID_STATE_TRANSITION"]).toContain(perdedor.body.code);

      expect(await estadoDe(viaje.id)).toBe("CANCELLED");
      expect(eventosCancelacion(viaje.id)).toHaveLength(1);
      const historial = await api("GET", `/trips/${viaje.id}/history`, { token: tokens.operator() });
      const cancelaciones = historial.body.transitions.filter((f: any) => f.action === "CANCEL");
      expect(cancelaciones).toHaveLength(1);
    });

    it("reintentar con la misma Idempotency-Key devuelve la misma respuesta sin volver a cancelar", async () => {
      const viaje = await viajeEn("PENDING_ARRIVAL");
      const headers = { "Idempotency-Key": crypto.randomUUID() };
      const body = { reason: "CHANGE_OF_PLANS" };

      const primera = await cancelar(viaje, body, { headers });
      const reintento = await cancelar(viaje, body, { headers });

      expect(primera.status).toBe(200);
      expect(reintento.status).toBe(200);
      expect(reintento.headers.get("idempotent-replayed")).toBe("true");
      expect(reintento.body.cancellation).toEqual(primera.body.cancellation);
      expect(eventosCancelacion(viaje.id)).toHaveLength(1);
    });
  });
});
