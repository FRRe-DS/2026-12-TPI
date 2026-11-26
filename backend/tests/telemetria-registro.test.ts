import { describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { routeName } from "../src/telemetria/registro.js";
import { sendJsonResponse } from "../src/middlewares/error.middleware.js";

/** ServerResponse falso: getHeader solo ve lo guardado por setHeader, como en Node. */
function fakeResponse(): ServerResponse {
  const stored = new Map<string, string | number | readonly string[]>();
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string | number | readonly string[]): void {
      stored.set(name.toLowerCase(), value);
    },
    getHeader(name: string): unknown {
      return stored.get(name.toLowerCase());
    },
    writeHead(status: number): void {
      res.statusCode = status;
    },
    end(): void {},
  };
  return res as unknown as ServerResponse;
}

describe("nombre de ruta para telemetría", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const token = "token-ficticio-para-pruebas";

  it.each(["", "/api/v1"])("normaliza datos de la ruta con prefijo %j", (prefix) => {
    expect(routeName(`${prefix}/trips/${id}/history`)).toBe(`${prefix}/trips/{id}/history`);
    expect(routeName(`${prefix}/trips/${token}/start`)).toBe(`${prefix}/trips/{id}/start`);
    expect(routeName(`${prefix}/ruta-desconocida/${token}`)).toBe(`${prefix}/{unmatched}`);
  });

  it.each(["client-rating", "driver-rating"])("clasifica la ruta retirada %s como desconocida", (route) => {
    expect(routeName(`/trips/${id}/${route}`)).toBe("/{unmatched}");
  });
});

describe("log de telemetría", () => {
  it("conserva X-Correlation-Id en la respuesta para que el log la lea", () => {
    const res = fakeResponse();

    sendJsonResponse(res, 401, { code: "UNAUTHENTICATED" }, "corr-123");

    expect(res.getHeader("X-Correlation-Id")).toBe("corr-123");
  });
});
