import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/config/database.js";
import { startServer, stopServer, resetDatabase, api, tokens, createTrip } from "./helpers.js";

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
    expect(res.body.outbox).toEqual({ pending: 0, oldestPendingSeconds: 0 });
  });

  it("GET /health/details cuenta los pendientes y degrada si esperan mas de 60 s", async () => {
    await createTrip();
    const recent = await api("GET", "/health/details");
    expect(recent.body.status).toBe("OK");
    expect(recent.body.outbox.pending).toBe(1);

    // Se envejece el evento para no tener que esperar un minuto de verdad.
    await prisma.outboxEvent.updateMany({ data: { createdAt: new Date(Date.now() - 120_000) } });
    const delayed = await api("GET", "/health/details");

    expect(delayed.status).toBe(200);
    expect(delayed.body.status).toBe("DEGRADED");
    expect(delayed.body.outbox.oldestPendingSeconds).toBeGreaterThanOrEqual(120);
  });

  it("GET /health/details no cuenta como pendientes los eventos ya enviados", async () => {
    await createTrip();
    await prisma.outboxEvent.updateMany({ data: { publishedAt: new Date() } });

    const res = await api("GET", "/health/details");

    expect(res.body.outbox).toEqual({ pending: 0, oldestPendingSeconds: 0 });
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