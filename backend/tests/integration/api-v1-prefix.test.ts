import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startServer,
  stopServer,
  resetDatabase,
  api,
  tokens,
  newTripBody,
} from "./helpers.js";

describe("prefijo /api/v1 (integracion)", () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(resetDatabase);

  it("crea y consulta el viaje por la ruta canónica con prefijo", async () => {
    const body = newTripBody();
    const creado = await api("POST", "/api/v1/trips", { token: tokens.system, body });

    expect(creado.status).toBe(201);
    expect(creado.headers.get("location")).toBe(`/api/v1/trips/${creado.body.id}`);

    const consulta = await api("GET", `/api/v1/trips/${creado.body.id}`, {
      token: tokens.system,
    });
    expect(consulta.status).toBe(200);
    expect(consulta.body.id).toBe(creado.body.id);
  });

  it("aplica una acción del ciclo de vida con prefijo", async () => {
    const creado = await api("POST", "/api/v1/trips", {
      token: tokens.system,
      body: newTripBody(),
    });
    const driver = tokens.driver(creado.body.driverId);

    const arrived = await api("POST", `/api/v1/trips/${creado.body.id}/arrived`, {
      token: driver,
    });

    expect(arrived.status).toBe(200);
    expect(arrived.body.state).toBe("DRIVER_ARRIVED");
  });

  it("mantiene el alias sin prefijo y su Location", async () => {
    const creado = await api("POST", "/trips", { token: tokens.system, body: newTripBody() });

    expect(creado.status).toBe(201);
    expect(creado.headers.get("location")).toBe(`/trips/${creado.body.id}`);
  });

  it("responde el preflight CORS en la ruta con prefijo", async () => {
    const res = await api("OPTIONS", "/api/v1/trips");

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("expone health también con prefijo", async () => {
    const res = await api("GET", "/api/v1/health");

    expect(res.status).toBe(200);
  });
});
