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

/**
 * RF-6.1 (Estados del viaje): estados validos y transiciones controladas, por HTTP.
 * Este archivo es autosuficiente: no depende de trips-lifecycle ni de trips-cancellation.
 *
 * Nota: en arrived/start/complete el service exige primero ser el conductor asignado (403)
 * y despues consulta la maquina de estados (409). Por eso, por HTTP, el chequeo de ROL de la
 * maquina solo se alcanza en cancel. La regla completa del dominio la prueba el unitario
 * tests/rf-6.1-estados-viaje.test.ts.
 */

type Estado = "PENDING_ARRIVAL" | "DRIVER_ARRIVED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
type Accion = "arrived" | "start" | "complete" | "cancel";
type Rol = "CLIENT" | "DRIVER" | "OPERATOR";
type Viaje = { id: string; clientId: string; driverId: string };

const ESTADOS: Estado[] = [
  "PENDING_ARRIVAL",
  "DRIVER_ARRIVED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
];
const ACCIONES: Accion[] = ["arrived", "start", "complete", "cancel"];
const ROLES: Rol[] = ["CLIENT", "DRIVER", "OPERATOR"];

/** Escrito a mano: desde que estados se puede cada accion y a cual llega. */
const DESTINO: Record<Accion, { desde: Estado[]; hacia: Estado }> = {
  arrived: { desde: ["PENDING_ARRIVAL"], hacia: "DRIVER_ARRIVED" },
  start: { desde: ["DRIVER_ARRIVED"], hacia: "IN_PROGRESS" },
  complete: { desde: ["IN_PROGRESS"], hacia: "COMPLETED" },
  cancel: { desde: ["PENDING_ARRIVAL", "DRIVER_ARRIVED", "IN_PROGRESS"], hacia: "CANCELLED" },
};

const EVENTO: Record<Accion, string> = {
  arrived: "DriverArrived",
  start: "TripStarted",
  complete: "TripCompleted",
  cancel: "TripCancelled",
};

const ACCION_HISTORIAL: Record<Accion, string> = {
  arrived: "REGISTER_ARRIVAL",
  start: "START",
  complete: "COMPLETE",
  cancel: "CANCEL",
};

/** Un motivo de cancelacion valido para cada rol (para que el 422 nunca moleste). */
const MOTIVO: Record<Rol, string> = {
  CLIENT: "CHANGE_OF_PLANS",
  DRIVER: "VEHICLE_PROBLEM",
  OPERATOR: "OTHER",
};

/** Token de QR distinto en cada uso (el service los trata como de un solo uso). */
const qr = () => `qr-${crypto.randomUUID()}`;

function tokenFor(rol: Rol, viaje: Viaje): string {
  if (rol === "CLIENT") return tokens.client(viaje.clientId);
  if (rol === "DRIVER") return tokens.driver(viaje.driverId);
  return tokens.operator();
}

/** Crea un viaje y lo deja en el estado pedido. */
async function tripIn(estado: Estado): Promise<Viaje> {
  const { trip } = await createTrip();
  if (estado === "DRIVER_ARRIVED" || estado === "IN_PROGRESS" || estado === "COMPLETED") {
    await advanceTrip(trip, estado);
  }
  if (estado === "CANCELLED") {
    const res = await api("POST", `/trips/${trip.id}/cancel`, {
      token: tokens.client(trip.clientId),
      body: { reason: MOTIVO.CLIENT },
    });
    if (res.status !== 200) {
      throw new Error(`tripIn(CANCELLED): cancel respondio ${res.status}: ${JSON.stringify(res.body)}`);
    }
  }
  return trip;
}

/** Ejecuta una accion sobre el viaje con el cuerpo valido que corresponde. */
function ejecutar(accion: Accion, viaje: Viaje, token: string, rol: Rol = "OPERATOR") {
  let body: unknown;
  if (accion === "start") body = { verificationToken: qr() };
  if (accion === "complete") body = { distanceKm: 2 };
  if (accion === "cancel") body = { reason: MOTIVO[rol] };
  return api("POST", `/trips/${viaje.id}/${accion}`, { token, body });
}

async function historialDe(viaje: Viaje): Promise<any[]> {
  const res = await api("GET", `/trips/${viaje.id}/history`, { token: tokens.client(viaje.clientId) });
  return res.body.transitions;
}

function tiposDeEventos(viaje: Viaje): string[] {
  return eventPublisher
    .getPublishedEvents()
    .filter((e) => e.tripId === viaje.id)
    .map((e) => e.eventType);
}

/** Foto del viaje: estado, version, filas de historial y eventos publicados. */
async function foto(viaje: Viaje) {
  const actual = await api("GET", `/trips/${viaje.id}`, { token: tokens.system });
  const historial = await historialDe(viaje);
  return {
    state: actual.body.state as string,
    version: actual.body.version as number,
    filasHistorial: historial.length,
    eventos: tiposDeEventos(viaje).length,
  };
}

// ---------- Tablas de casos ----------

const casosAccionEstado = ACCIONES.flatMap((accion) =>
  ESTADOS.map((estado) => ({
    accion,
    estado,
    hacia: DESTINO[accion].hacia,
    // arrived/start/complete las hace el conductor asignado; cancel, el operador
    rol: (accion === "cancel" ? "OPERATOR" : "DRIVER") as Rol,
    permitida: DESTINO[accion].desde.includes(estado),
  }))
);
const accionesPermitidas = casosAccionEstado.filter((c) => c.permitida);
const accionesRechazadas = casosAccionEstado.filter((c) => !c.permitida);

const ACCIONES_DEL_CONDUCTOR: Array<{ accion: Accion; estado: Estado }> = [
  { accion: "arrived", estado: "PENDING_ARRIVAL" },
  { accion: "start", estado: "DRIVER_ARRIVED" },
  { accion: "complete", estado: "IN_PROGRESS" },
];
const NO_AUTORIZADOS: Array<{ nombre: string; token: (v: Viaje) => string }> = [
  { nombre: "el CLIENT del viaje", token: (v) => tokens.client(v.clientId) },
  { nombre: "un DRIVER que no es el asignado", token: () => tokens.driver(crypto.randomUUID()) },
  { nombre: "un OPERATOR", token: () => tokens.operator() },
  { nombre: "el servicio SYSTEM", token: () => tokens.system },
];
const casosSoloConductor = ACCIONES_DEL_CONDUCTOR.flatMap((a) =>
  NO_AUTORIZADOS.map((n) => ({ ...a, ...n }))
);

const casosCancelar = ESTADOS.flatMap((estado) =>
  ROLES.map((rol) => {
    const terminal = estado === "COMPLETED" || estado === "CANCELLED";
    const esperado = terminal ? 409 : estado === "IN_PROGRESS" && rol !== "OPERATOR" ? 403 : 200;
    return { estado, rol, esperado };
  })
);
const cancelaciones200 = casosCancelar.filter((c) => c.esperado === 200);
const cancelaciones403 = casosCancelar.filter((c) => c.esperado === 403);
const cancelaciones409 = casosCancelar.filter((c) => c.esperado === 409);

describe("RF-6.1 Estados del viaje (integracion)", () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(resetDatabase);

  describe("ciclo completo", () => {
    it("PENDING_ARRIVAL -> DRIVER_ARRIVED -> IN_PROGRESS -> COMPLETED con estado, version, historial y eventos", async () => {
      const { trip } = await createTrip();
      expect(trip.state).toBe("PENDING_ARRIVAL");
      expect(trip.version).toBe(1);

      const pasos: Array<{ accion: Accion; estado: Estado; version: number }> = [
        { accion: "arrived", estado: "DRIVER_ARRIVED", version: 2 },
        { accion: "start", estado: "IN_PROGRESS", version: 3 },
        { accion: "complete", estado: "COMPLETED", version: 4 },
      ];
      for (const paso of pasos) {
        const res = await ejecutar(paso.accion, trip, tokens.driver(trip.driverId));
        expect(res.status).toBe(200);
        expect(res.body.state).toBe(paso.estado);
        expect(res.body.version).toBe(paso.version);

        const consulta = await api("GET", `/trips/${trip.id}`, { token: tokens.client(trip.clientId) });
        expect(consulta.status).toBe(200);
        expect(consulta.body.state).toBe(paso.estado);
      }

      const filas = await historialDe(trip);
      expect(filas.map((f) => f.sequence)).toEqual([1, 2, 3, 4]);
      expect(filas.map((f) => f.action)).toEqual(["CREATE", "REGISTER_ARRIVAL", "START", "COMPLETE"]);
      expect(filas.map((f) => f.from)).toEqual([null, "PENDING_ARRIVAL", "DRIVER_ARRIVED", "IN_PROGRESS"]);
      expect(filas.map((f) => f.to)).toEqual(["PENDING_ARRIVAL", "DRIVER_ARRIVED", "IN_PROGRESS", "COMPLETED"]);

      expect(tiposDeEventos(trip).sort()).toEqual([
        "DriverArrived",
        "TripCompleted",
        "TripCreated",
        "TripStarted",
      ]);
    });
  });

  describe("cada accion desde cada estado, con el actor correcto", () => {
    it("la tabla de prueba tiene el tamano esperado (6 permitidas, 14 rechazadas)", () => {
      expect(casosAccionEstado).toHaveLength(20);
      expect(accionesPermitidas).toHaveLength(6);
      expect(accionesRechazadas).toHaveLength(14);
    });

    it.each(accionesPermitidas)(
      "$accion desde $estado: 200, pasa a $hacia y deja una fila de historial y un evento",
      async ({ accion, estado, hacia, rol }) => {
        const viaje = await tripIn(estado);
        const antes = await foto(viaje);

        const res = await ejecutar(accion, viaje, tokenFor(rol, viaje), rol);

        expect(res.status).toBe(200);
        expect(res.body.state).toBe(hacia);

        const despues = await foto(viaje);
        expect(despues.state).toBe(hacia);
        expect(despues.version).toBe(antes.version + 1);
        expect(despues.filasHistorial).toBe(antes.filasHistorial + 1);
        expect(despues.eventos).toBe(antes.eventos + 1);

        const filas = await historialDe(viaje);
        expect(filas[filas.length - 1]).toMatchObject({
          from: estado,
          to: hacia,
          action: ACCION_HISTORIAL[accion],
        });
        expect(tiposDeEventos(viaje)).toContain(EVENTO[accion]);
      }
    );

    it.each(accionesRechazadas)(
      "$accion desde $estado: 409 INVALID_STATE_TRANSITION y no deja rastro",
      async ({ accion, estado, rol }) => {
        const viaje = await tripIn(estado);
        const antes = await foto(viaje);

        const res = await ejecutar(accion, viaje, tokenFor(rol, viaje), rol);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe("INVALID_STATE_TRANSITION");
        expect(res.body.currentState).toBe(estado);
        // ni estado, ni version, ni historial, ni eventos
        expect(await foto(viaje)).toEqual(antes);
      }
    );
  });

  describe("arrived, start y complete: solo el conductor asignado", () => {
    it.each(casosSoloConductor)(
      "$nombre no puede hacer $accion (con el viaje en $estado): 403 FORBIDDEN y no deja rastro",
      async ({ accion, estado, token }) => {
        const viaje = await tripIn(estado);
        const antes = await foto(viaje);

        const res = await ejecutar(accion, viaje, token(viaje));

        expect(res.status).toBe(403);
        expect(res.body.code).toBe("FORBIDDEN");
        expect(await foto(viaje)).toEqual(antes);
      }
    );
  });

  describe("cancelar: rol x estado", () => {
    it("la tabla de prueba tiene el tamano esperado (7 permitidas, 2 por rol, 6 por estado terminal)", () => {
      expect(casosCancelar).toHaveLength(15);
      expect(cancelaciones200).toHaveLength(7);
      expect(cancelaciones403).toHaveLength(2);
      expect(cancelaciones409).toHaveLength(6);
    });

    it.each(cancelaciones200)(
      "$rol cancela desde $estado: 200, CANCELLED, y queda en historial y eventos",
      async ({ estado, rol }) => {
        const viaje = await tripIn(estado);
        const antes = await foto(viaje);

        const res = await ejecutar("cancel", viaje, tokenFor(rol, viaje), rol);

        expect(res.status).toBe(200);
        expect(res.body.state).toBe("CANCELLED");
        expect(res.body.cancellation).toMatchObject({ cancelledBy: rol });

        const despues = await foto(viaje);
        expect(despues.state).toBe("CANCELLED");
        expect(despues.version).toBe(antes.version + 1);
        expect(despues.filasHistorial).toBe(antes.filasHistorial + 1);
        expect(tiposDeEventos(viaje)).toContain("TripCancelled");
      }
    );

    it.each(cancelaciones403)(
      "$rol no puede cancelar desde $estado: 403 FORBIDDEN y el viaje sigue en curso",
      async ({ estado, rol }) => {
        const viaje = await tripIn(estado);
        const antes = await foto(viaje);

        const res = await ejecutar("cancel", viaje, tokenFor(rol, viaje), rol);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe("FORBIDDEN");
        expect(await foto(viaje)).toEqual(antes);
      }
    );

    it.each(cancelaciones409)(
      "$rol no puede cancelar un viaje $estado: 409 INVALID_STATE_TRANSITION y no cambia nada",
      async ({ estado, rol }) => {
        const viaje = await tripIn(estado);
        const antes = await foto(viaje);

        const res = await ejecutar("cancel", viaje, tokenFor(rol, viaje), rol);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe("INVALID_STATE_TRANSITION");
        expect(res.body.currentState).toBe(estado);
        expect(await foto(viaje)).toEqual(antes);
      }
    );

    it.each([
      { nombre: "un CLIENT ajeno", token: () => tokens.client(crypto.randomUUID()) },
      { nombre: "un DRIVER ajeno", token: () => tokens.driver(crypto.randomUUID()) },
      { nombre: "el servicio SYSTEM", token: () => tokens.system },
    ])("$nombre no puede cancelar: 403 FORBIDDEN y el viaje no cambia", async ({ token }) => {
      const viaje = await tripIn("PENDING_ARRIVAL");
      const antes = await foto(viaje);

      const res = await ejecutar("cancel", viaje, token());

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
      expect(await foto(viaje)).toEqual(antes);
    });
  });

  describe("viaje inexistente", () => {
    it.each(ACCIONES)("%s sobre un viaje que no existe: 404 TRIP_NOT_FOUND", async (accion) => {
      const fantasma: Viaje = {
        id: crypto.randomUUID(),
        clientId: crypto.randomUUID(),
        driverId: crypto.randomUUID(),
      };
      const token = accion === "cancel" ? tokens.operator() : tokens.driver(fantasma.driverId);

      const res = await ejecutar(accion, fantasma, token);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("TRIP_NOT_FOUND");
    });
  });

  describe("concurrencia", () => {
    it("dos arrived al mismo tiempo: solo uno gana, el otro recibe 409 y hay una sola transicion", async () => {
      const viaje = await tripIn("PENDING_ARRIVAL");
      const driver = tokens.driver(viaje.driverId);
      const antes = await foto(viaje);

      const [a, b] = await Promise.all([
        ejecutar("arrived", viaje, driver),
        ejecutar("arrived", viaje, driver),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const perdedor = a.status === 409 ? a : b;
      expect(["CONCURRENCY_CONFLICT", "INVALID_STATE_TRANSITION"]).toContain(perdedor.body.code);

      const despues = await foto(viaje);
      expect(despues.state).toBe("DRIVER_ARRIVED");
      expect(despues.version).toBe(antes.version + 1);
      expect(despues.filasHistorial).toBe(antes.filasHistorial + 1);
      expect(despues.eventos).toBe(antes.eventos + 1);
    });
  });
});