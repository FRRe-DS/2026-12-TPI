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
    vehicleType: "CAR",
    originLatitude: -27.4514,
    originLongitude: -58.9792,
    destinationLatitude: -27.4512,
    destinationLongitude: -58.9866,
    ...overrides,
  };
}