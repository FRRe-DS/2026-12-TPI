import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startServer, stopServer, resetDatabase, api, tokens } from "./helpers.js";

describe("Health y autenticacion (integracion)", () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(resetDatabase);

  it("GET /health responde 200 UP sin token", async () => {
    const res = await api("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("UP");
  });

  it("GET /health/details responde 200 con PostgreSQL OK contra la base real", async () => {
    const res = await api("GET", "/health/details");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("OK");
    expect(res.body.components.postgres.status).toBe("OK");
    expect(res.body.components.rabbitmq.status).toBe("NOT_CONFIGURED");
    expect(res.body.components.redis.status).toBe("NOT_CONFIGURED");
    expect(res.body.outbox).toBeNull();
  });

  it("GET /health/details no expone la cadena de conexion", async () => {
    const res = await api("GET", "/health/details");
    expect(JSON.stringify(res.body)).not.toContain("postgresql://");
  });

  it("GET /trips sin token responde 401 UNAUTHENTICATED en problem+json", async () => {
    const res = await api("GET", "/trips");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.body.code).toBe("UNAUTHENTICATED");
  });

  it("el atajo Bearer SYSTEM funciona con ENABLE_DEMO_AUTH=true", async () => {
    const res = await api("GET", "/trips?clientId=00000000-0000-4000-8000-000000000001", {
      token: tokens.system,
    });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("con ENABLE_DEMO_AUTH=false el atajo Bearer SYSTEM da 401", async () => {
    const previous = process.env.ENABLE_DEMO_AUTH;
    process.env.ENABLE_DEMO_AUTH = "false";
    try {
      const res = await api("GET", "/trips?clientId=00000000-0000-4000-8000-000000000001", {
        token: tokens.system,
      });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHENTICATED");
    } finally {
      process.env.ENABLE_DEMO_AUTH = previous;
    }
  });
});