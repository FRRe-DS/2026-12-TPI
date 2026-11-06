import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startServer, stopServer, resetDatabase, api, tokens, newTripBody } from "./helpers.js";

/** Mismo valor que MAX_BODY_BYTES en trip.controller.ts (RNF-12): 16 KB. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Cuerpo válido de POST /trips con un campo sobrante ("padding", que el servidor ignora)
 * para que el JSON mida exactamente `bytes` bytes.
 */
function tripBodyOfSize(bytes: number) {
  const base = newTripBody({ padding: "" });
  const baseSize = JSON.stringify(base).length;
  return { ...base, padding: "x".repeat(bytes - baseSize) };
}

describe("Limite de tamano del cuerpo: 413 (integracion)", () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(resetDatabase);

  it("POST /trips con un cuerpo mayor a 16 KB responde 413 PAYLOAD_TOO_LARGE en problem+json", async () => {
    const res = await api("POST", "/trips", {
      token: tokens.system,
      body: tripBodyOfSize(20_000),
    });

    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.body.code).toBe("PAYLOAD_TOO_LARGE");
    expect(res.body.status).toBe(413);
  });

  it("un POST /trips rechazado por tamano no crea el viaje", async () => {
    const body = tripBodyOfSize(20_000);
    const rejected = await api("POST", "/trips", { token: tokens.system, body });
    expect(rejected.status).toBe(413);

    const list = await api("GET", `/trips?clientId=${body.clientId}`, { token: tokens.system });
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([]);
  });

  it("el tamano se controla antes que el contenido: un cuerpo grande e invalido da 413, no 400", async () => {
    const res = await api("POST", "/trips", {
      token: tokens.system,
      body: { padding: "x".repeat(20_000) },
    });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it.each(["start", "complete", "cancel"])(
    "POST /trips/{id}/%s con un cuerpo mayor a 16 KB responde 413 (antes de buscar el viaje)",
    async (action) => {
      // El viaje no existe: si el servidor buscara primero, daria 404.
      const res = await api("POST", `/trips/${crypto.randomUUID()}/${action}`, {
        token: tokens.driver(crypto.randomUUID()),
        body: { padding: "x".repeat(20_000) },
      });

      expect(res.status).toBe(413);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(res.body.code).toBe("PAYLOAD_TOO_LARGE");
    }
  );

  it("un cuerpo de exactamente 16 KB (16384 bytes) todavia se acepta", async () => {
    const body = tripBodyOfSize(MAX_BODY_BYTES);
    expect(Buffer.byteLength(JSON.stringify(body))).toBe(MAX_BODY_BYTES);

    const res = await api("POST", "/trips", { token: tokens.system, body });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
  });

  it("un cuerpo de 16 KB + 1 byte (16385 bytes) se rechaza con 413", async () => {
    const body = tripBodyOfSize(MAX_BODY_BYTES + 1);
    expect(Buffer.byteLength(JSON.stringify(body))).toBe(MAX_BODY_BYTES + 1);

    const res = await api("POST", "/trips", { token: tokens.system, body });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe("PAYLOAD_TOO_LARGE");
  });
});