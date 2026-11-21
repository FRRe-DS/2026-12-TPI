import { describe, it, expect } from "vitest";
import { toContractPath } from "../src/routes/contract-path.js";

describe("prefijo /api/v1 en las rutas del contrato", () => {
  it("acepta la forma canónica con prefijo", () => {
    expect(toContractPath("/api/v1/trips")).toBe("/trips");
    expect(toContractPath("/api/v1/trips/abc/history")).toBe("/trips/abc/history");
    expect(toContractPath("/api/v1/health/details")).toBe("/health/details");
  });

  it("mantiene el alias sin prefijo", () => {
    expect(toContractPath("/trips")).toBe("/trips");
    expect(toContractPath("/health")).toBe("/health");
  });

  it("no confunde rutas que solo se parecen al prefijo", () => {
    expect(toContractPath("/api/v1x/trips")).toBe("/api/v1x/trips");
    expect(toContractPath("/api/data")).toBe("/api/data");
    expect(toContractPath("/trips/api/v1")).toBe("/trips/api/v1");
  });

  it("reduce /api/v1 solo a la raíz", () => {
    expect(toContractPath("/api/v1")).toBe("/");
  });
});
