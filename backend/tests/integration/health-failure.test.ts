import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { tripRepository } from "../../src/config/services.js";
import { startServer, stopServer, api } from "./helpers.js";

describe("/health/details con falla de PostgreSQL simulada: 503 (integracion)", () => {
  beforeAll(startServer);
  afterAll(stopServer);

  let errorLog: MockInstance<typeof console.error>;

  beforeEach(() => {
    // El health service registra la falla con console.error; se silencia para no ensuciar la salida.
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    // Devuelve checkDatabaseHealth y console.error a su version original.
    vi.restoreAllMocks();
  });

  it("si la consulta a PostgreSQL falla, responde 503 con status ERROR y el resto de los componentes intactos", async () => {
    vi.spyOn(tripRepository, "checkDatabaseHealth").mockRejectedValue(new Error("connection refused"));

    const res = await api("GET", "/health/details");

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.body.status).toBe("ERROR");
    expect(res.body.components.postgres.status).toBe("ERROR");
    expect(res.body.components.postgres.detail).toBe("No se pudo consultar PostgreSQL");
    expect(typeof res.body.components.postgres.latencyMs).toBe("number");
    expect(res.body.components.rabbitmq.status).toBe("NOT_CONFIGURED");
    expect(res.body.components.redis.status).toBe("NOT_CONFIGURED");
    expect(res.body.outbox).toBeNull();
  });

  it("no expone el error real en la respuesta, pero lo deja en el log del servidor", async () => {
    vi.spyOn(tripRepository, "checkDatabaseHealth").mockRejectedValue(
      new Error("password authentication failed for postgresql://admin:supersecreto@db:5432/m6_trips")
    );

    const res = await api("GET", "/health/details");
    const raw = JSON.stringify(res.body);

    expect(res.status).toBe(503);
    expect(raw).not.toContain("supersecreto");
    expect(raw).not.toContain("postgresql://");
    expect(raw).not.toContain("admin");

    const logged = errorLog.mock.calls.some((call) => String(call[0]).includes("[HEALTH]"));
    expect(logged).toBe(true);
  });

  it(
    "si PostgreSQL no responde, a los 1,5 s corta y responde 503 con detalle de timeout",
    async () => {
      // Una promesa que nunca se resuelve: simula una base colgada.
      vi.spyOn(tripRepository, "checkDatabaseHealth").mockImplementation(
        () => new Promise<boolean>(() => {})
      );

      const started = Date.now();
      const res = await api("GET", "/health/details");
      const elapsed = Date.now() - started;

      expect(res.status).toBe(503);
      expect(res.body.status).toBe("ERROR");
      expect(res.body.components.postgres.status).toBe("ERROR");
      expect(res.body.components.postgres.detail).toBe("Sin respuesta en 1500 ms");
      expect(res.body.components.postgres.latencyMs).toBeGreaterThanOrEqual(1400);
      expect(elapsed).toBeLessThan(5000);
    },
    10_000
  );

  it("/health (liveness) sigue en 200 aunque PostgreSQL falle y ni siquiera consulta la base", async () => {
    const dbCheck = vi
      .spyOn(tripRepository, "checkDatabaseHealth")
      .mockRejectedValue(new Error("connection refused"));

    const res = await api("GET", "/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("UP");
    expect(dbCheck).not.toHaveBeenCalled();
  });

  it("cuando PostgreSQL se recupera, /health/details vuelve a 200 sin reiniciar el servidor", async () => {
    // Falla solo en la primera consulta; la segunda usa la implementacion real (base de tests levantada).
    vi.spyOn(tripRepository, "checkDatabaseHealth").mockRejectedValueOnce(new Error("connection refused"));

    const down = await api("GET", "/health/details");
    expect(down.status).toBe(503);

    const up = await api("GET", "/health/details");
    expect(up.status).toBe(200);
    expect(up.body.status).toBe("OK");
    expect(up.body.components.postgres.status).toBe("OK");
  });
});