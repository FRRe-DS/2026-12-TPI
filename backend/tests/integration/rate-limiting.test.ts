import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { resetRateLimits } from "../../src/middlewares/rate-limit.middleware.js";
import { startServer, stopServer, resetDatabase, api, tokens, newTripBody } from "./helpers.js";

const USER_VAR = "RATE_LIMIT_USER_PER_MIN";
const SERVICE_VAR = "RATE_LIMIT_SERVICE_PER_MIN";

// Valores originales, para dejar el entorno como estaba al terminar cada test.
const originalUser = process.env[USER_VAR];
const originalService = process.env[SERVICE_VAR];

/** Asigna una variable de entorno; con undefined la borra (asignar undefined la dejaria como el texto "undefined"). */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("Limite de pedidos: 429 (integracion)", () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(resetDatabase);
  afterEach(() => {
    setEnv(USER_VAR, originalUser);
    setEnv(SERVICE_VAR, originalService);
  });

  it("el pedido que supera el limite responde 429 con Retry-After y headers RateLimit-*", async () => {
    setEnv(USER_VAR, "3");
    const token = tokens.client(crypto.randomUUID());

    for (const remaining of ["2", "1", "0"]) {
      const res = await api("GET", "/trips", { token });
      expect(res.status).toBe(200);
      expect(res.headers.get("ratelimit-limit")).toBe("3");
      expect(res.headers.get("ratelimit-remaining")).toBe(remaining);
    }

    const blocked = await api("GET", "/trips", { token });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("content-type")).toContain("application/problem+json");
    expect(blocked.body.code).toBe("TOO_MANY_REQUESTS");
    expect(blocked.body.status).toBe(429);
    expect(blocked.headers.get("ratelimit-limit")).toBe("3");
    expect(blocked.headers.get("ratelimit-remaining")).toBe("0");

    const retryAfter = Number(blocked.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(blocked.headers.get("ratelimit-reset")).toBe(String(retryAfter));
  });

  it("mientras dure la ventana, todos los pedidos siguientes tambien dan 429", async () => {
    setEnv(USER_VAR, "1");
    const token = tokens.client(crypto.randomUUID());

    expect((await api("GET", "/trips", { token })).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      const res = await api("GET", "/trips", { token });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe("TOO_MANY_REQUESTS");
    }
  });

  it("el limite es por actor: otro usuario, o el mismo id con otro rol, no se ve afectado", async () => {
    setEnv(USER_VAR, "2");
    const sharedId = crypto.randomUUID();
    const clientA = tokens.client(sharedId);

    expect((await api("GET", "/trips", { token: clientA })).status).toBe(200);
    expect((await api("GET", "/trips", { token: clientA })).status).toBe(200);
    expect((await api("GET", "/trips", { token: clientA })).status).toBe(429);

    // Otro cliente: contador propio.
    const clientB = await api("GET", "/trips", { token: tokens.client(crypto.randomUUID()) });
    expect(clientB.status).toBe(200);
    expect(clientB.headers.get("ratelimit-remaining")).toBe("1");

    // Mismo id pero rol DRIVER: la clave es "ROL:id", asi que tambien es otro contador.
    const driverSameId = await api("GET", "/trips", { token: tokens.driver(sharedId) });
    expect(driverSameId.status).toBe(200);
    expect(driverSameId.headers.get("ratelimit-remaining")).toBe("1");
  });

  it("usuarios y servicios (SYSTEM) tienen limites distintos", async () => {
    setEnv(USER_VAR, "1");
    setEnv(SERVICE_VAR, "3");

    // Usuario: limite 1.
    const clientToken = tokens.client(crypto.randomUUID());
    expect((await api("GET", "/trips", { token: clientToken })).status).toBe(200);
    expect((await api("GET", "/trips", { token: clientToken })).status).toBe(429);

    // Servicio: limite 3.
    const path = `/trips?clientId=${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i++) {
      const res = await api("GET", path, { token: tokens.system });
      expect(res.status).toBe(200);
      expect(res.headers.get("ratelimit-limit")).toBe("3");
    }
    const blocked = await api("GET", path, { token: tokens.system });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("ratelimit-limit")).toBe("3");
  });

  it("los pedidos que terminan en error tambien cuentan, y el limite se aplica antes de buscar la ruta", async () => {
    setEnv(USER_VAR, "2");
    const token = tokens.client(crypto.randomUUID());

    // Viajes inexistentes: 404, pero cada uno consume un pedido.
    expect((await api("GET", `/trips/${crypto.randomUUID()}`, { token })).status).toBe(404);
    expect((await api("GET", `/trips/${crypto.randomUUID()}`, { token })).status).toBe(404);

    const blocked = await api("GET", `/trips/${crypto.randomUUID()}`, { token });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("TOO_MANY_REQUESTS");
  });

  it("un POST bloqueado por 429 no ejecuta la accion (no se crea el viaje)", async () => {
    setEnv(SERVICE_VAR, "2");

    for (let i = 0; i < 2; i++) {
      const created = await api("POST", "/trips", { token: tokens.system, body: newTripBody() });
      expect(created.status).toBe(201);
    }

    const blockedBody = newTripBody();
    const blocked = await api("POST", "/trips", { token: tokens.system, body: blockedBody });
    expect(blocked.status).toBe(429);

    // Se reinician los contadores solo para poder consultar la base con el mismo token.
    resetRateLimits();
    const list = await api("GET", `/trips?clientId=${blockedBody.clientId}`, {
      token: tokens.system,
    });
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([]);
  });

  it("/health y /health/details no cuentan para el limite ni llevan headers RateLimit-*", async () => {
    setEnv(USER_VAR, "1");
    const token = tokens.client(crypto.randomUUID());

    // El unico pedido permitido del usuario.
    expect((await api("GET", "/trips", { token })).status).toBe(200);

    for (let i = 0; i < 3; i++) {
      for (const path of ["/health", "/health/details"]) {
        const res = await api("GET", path);
        expect(res.status).toBe(200);
        expect(res.headers.get("ratelimit-limit")).toBeNull();
      }
    }

    // Y el contador del usuario sigue agotado.
    expect((await api("GET", "/trips", { token })).status).toBe(429);
  });

  it("si la variable de entorno es invalida, se usan los limites por defecto (120 usuarios, 1200 servicios)", async () => {
    setEnv(USER_VAR, "abc");
    setEnv(SERVICE_VAR, "0");

    const user = await api("GET", "/trips", { token: tokens.client(crypto.randomUUID()) });
    expect(user.status).toBe(200);
    expect(user.headers.get("ratelimit-limit")).toBe("120");

    const service = await api("GET", `/trips?clientId=${crypto.randomUUID()}`, {
      token: tokens.system,
    });
    expect(service.status).toBe(200);
    expect(service.headers.get("ratelimit-limit")).toBe("1200");
  });
});