import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { prisma } from "../../src/config/database.js";
import { server } from "../../src/explorer.js";
import { resetRateLimits } from "../../src/middlewares/rate-limit.middleware.js";

let baseUrl = "";

/** Levanta el servidor real en un puerto libre. Usar en beforeAll. */
export async function startServer(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
}

/** Cierra el servidor y la conexión a la base. Usar en afterAll. */
export async function stopServer(): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
  await prisma.$disconnect();
}

/**
 * Vacía las tablas y reinicia el límite de pedidos. Usar en beforeEach.
 * Guardia: se niega a borrar si la base conectada no es de tests.
 */
export async function resetDatabase(): Promise<void> {
  const rows = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  const db = rows[0]?.db ?? "";
  if (!db.endsWith("_test")) {
    throw new Error(`Abortado: la base conectada es "${db}" y no es una base de tests.`);
  }
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE trip_event_history, trips, idempotency_keys RESTART IDENTITY CASCADE"
  );
  resetRateLimits();
}

export interface ApiResult {
  status: number;
  headers: Headers;
  body: any;
}

export interface ApiOptions {
  /** Valor después de "Bearer ": por ejemplo tokens.system o tokens.driver(id). */
  token?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Hace un pedido HTTP real al servidor de tests y devuelve status, headers y cuerpo (JSON si se puede). */
export async function api(
  method: string,
  path: string,
  options: ApiOptions = {}
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;

  let payload: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(options.body);
  }

  const res = await fetch(baseUrl + path, { method, headers, body: payload });
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, headers: res.headers, body };
}

/** Tokens rápidos de demo (requieren ENABLE_DEMO_AUTH=true, que la config de tests ya define). */
export const tokens = {
  system: "SYSTEM",
  client: (id: string) => `CLIENT:${id}`,
  driver: (id: string) => `DRIVER:${id}`,
  operator: (id: string = crypto.randomUUID()) => `OPERATOR:${id}`,
};

/** Cuerpo válido de POST /trips (CreateTripRequest). Cada llamada genera ids nuevos. */
export function newTripBody(overrides: Record<string, unknown> = {}) {
  return {
    requestId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    driverId: crypto.randomUUID(),
    vehicleId: crypto.randomUUID(),
    vehicleType: "AUTO",
    originLatitude: -27.4514,
    originLongitude: -58.9792,
    destinationLatitude: -27.4512,
    destinationLongitude: -58.9866,
    ...overrides,
  };
}

/** Crea un viaje por la API (como M5, con el token SYSTEM) y devuelve el viaje y el cuerpo enviado. */
export async function createTrip(overrides: Record<string, unknown> = {}) {
  const body = newTripBody(overrides);
  const res = await api("POST", "/trips", { token: tokens.system, body });
  if (res.status !== 201) {
    throw new Error(`createTrip: se esperaba 201 y llego ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return { trip: res.body as any, body, res };
}

/**
 * Lleva un viaje recién creado hasta un estado, usando al conductor asignado.
 * Cada paso tiene que responder 200; si no, el test falla con el detalle.
 */
export async function advanceTrip(
  trip: { id: string; driverId: string },
  target: "DRIVER_ARRIVED" | "IN_PROGRESS" | "COMPLETED"
): Promise<ApiResult> {
  const token = tokens.driver(trip.driverId);
  const steps: Array<{ action: string; body?: unknown }> = [{ action: "arrived" }];
  if (target !== "DRIVER_ARRIVED") {
    steps.push({ action: "start", body: { verificationToken: `qr-${crypto.randomUUID()}` } });
  }
  if (target === "COMPLETED") {
    steps.push({ action: "complete", body: { distanceKm: 6.4 } });
  }

  let last!: ApiResult;
  for (const step of steps) {
    last = await api("POST", `/trips/${trip.id}/${step.action}`, { token, body: step.body });
    if (last.status !== 200) {
      throw new Error(
        `advanceTrip: ${step.action} respondio ${last.status}: ${JSON.stringify(last.body)}`
      );
    }
  }
  return last;
}