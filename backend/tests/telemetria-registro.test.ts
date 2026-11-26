import { describe, expect, it } from "vitest";
import { routeName } from "../src/telemetria/registro.js";

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
