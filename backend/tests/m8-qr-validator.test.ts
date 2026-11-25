import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { M8QrValidatorService } from "../src/services/m8-qr-validator.service.js";
import type { TokenProvider } from "../src/services/service-token.service.js";

const M8_URL = "http://m8-notificaciones:3000";
const TRIP_ID = "9082a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b";
const TOKEN = "qr_token_de_prueba_123";

function okResponse(body: unknown = { qrId: "q-1", viajeId: TRIP_ID, usadoEn: new Date().toISOString() }) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body };
}

function errorResponse(status: number, body: unknown = {}, headers = new Headers()) {
  return { ok: false, status, headers, json: async () => body };
}

/** Extrae el header Idempotency-Key de una llamada mockeada a fetch. */
function idempotencyKeyOf(call: unknown[] | undefined): string | undefined {
  const init = call?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.["Idempotency-Key"];
}

describe("M8QrValidatorService - simulación local (sin M8_API_URL)", () => {
  let validator: M8QrValidatorService;

  beforeEach(() => {
    validator = new M8QrValidatorService("", 100);
    validator.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("valida un token nuevo y rechaza la reutilización (RNF-09)", async () => {
    const token = "single_use_token_999";

    await expect(validator.validate(token)).resolves.toMatchObject({ valid: true });

    const replay = await validator.validate(token);
    expect(replay.valid).toBe(false);
    expect(replay.code).toBe("INVALID_VERIFICATION_CODE");
  });

  it("simula timeout/503 y tokens inválidos o expirados", async () => {
    await expect(validator.validate("m8_timeout")).resolves.toMatchObject({
      valid: false,
      code: "DEPENDENCY_UNAVAILABLE",
      retryAfterSeconds: 5,
    });
    await expect(validator.validate("invalid")).resolves.toMatchObject({
      valid: false,
      code: "INVALID_VERIFICATION_CODE",
    });
    await expect(validator.validate("expired")).resolves.toMatchObject({
      valid: false,
      code: "INVALID_VERIFICATION_CODE",
    });
  });

  it("pasar '' desactiva M8 aunque la variable de entorno esté definida", async () => {
    const originalEnv = process.env.M8_API_URL;
    process.env.M8_API_URL = "http://m8-en-env:3000";
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    try {
      const isolated = new M8QrValidatorService("", 100);
      await expect(isolated.validate("token_local_aislado")).resolves.toMatchObject({ valid: true });
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      if (originalEnv === undefined) delete process.env.M8_API_URL;
      else process.env.M8_API_URL = originalEnv;
    }
  });
});

describe("M8QrValidatorService - contrato vigente de M8 (POST /api/v1/qr/validaciones)", () => {
  let validator: M8QrValidatorService;

  beforeEach(() => {
    validator = new M8QrValidatorService(M8_URL, 500, "test-service-token", 1, 10);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("llama a la ruta, body y cabeceras del contrato", async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", mockFetch);

    await expect(validator.validate(TOKEN, TRIP_ID, "corr-1")).resolves.toMatchObject({ valid: true });

    expect(mockFetch).toHaveBeenCalledWith(
      `${M8_URL}/api/v1/qr/validaciones`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer test-service-token",
          "X-Request-Id": "corr-1",
        }),
        body: JSON.stringify({ token: TOKEN, viajeId: TRIP_ID }),
      })
    );

    const sent = mockFetch.mock.calls[0]![1] as { body: string; headers: Record<string, string> };
    expect(sent.headers["Idempotency-Key"]).toMatch(/^qr-.+-[0-9a-f]{32}$/);
  });

  it("no duplica /api/v1 si la URL base ya lo incluye", async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", mockFetch);
    const withPrefix = new M8QrValidatorService("http://m8:3000/api/v1", 500, "tok");

    await withPrefix.validate(TOKEN, TRIP_ID);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://m8:3000/api/v1/qr/validaciones",
      expect.anything()
    );
  });

  it("usa el mismo Idempotency-Key en los reintentos del mismo (viaje, token)", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(503, {}, new Headers({ "retry-after": "5" })))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", mockFetch);

    await expect(validator.validate(TOKEN, TRIP_ID)).resolves.toMatchObject({ valid: true });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(idempotencyKeyOf(mockFetch.mock.calls[0])).toBe(idempotencyKeyOf(mockFetch.mock.calls[1]));
  });

  it.each([
    [404, "El token no existe"],
    [409, "El QR ya fue usado"],
    [422, "El QR expiró"],
    [400, "Datos inválidos"],
  ])("mapea %i a INVALID_VERIFICATION_CODE sin reintentar", async (status, detail) => {
    const mockFetch = vi.fn().mockResolvedValue(errorResponse(status, { detail }));
    vi.stubGlobal("fetch", mockFetch);

    const result = await validator.validate(TOKEN, TRIP_ID);

    expect(result).toMatchObject({ valid: false, code: "INVALID_VERIFICATION_CODE", message: detail });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("rechaza el QR si M8 responde 200 pero el viaje no coincide", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      okResponse({ qrId: "q-1", viajeId: "otro-viaje", usadoEn: new Date().toISOString() })
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await validator.validate(TOKEN, TRIP_ID);

    expect(result).toMatchObject({ valid: false, code: "INVALID_VERIFICATION_CODE" });
  });

  it("un 401/403 de M8 es 503 (configuración), no QR inválido", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const mockFetch = vi.fn().mockResolvedValue(errorResponse(401, { detail: "Unauthorized" }));
    vi.stubGlobal("fetch", mockFetch);

    const result = await validator.validate(TOKEN, TRIP_ID);

    expect(result).toMatchObject({
      valid: false,
      code: "DEPENDENCY_UNAVAILABLE",
      retryAfterSeconds: 5,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/401.*token de servicio/i));
  });

  it("reintenta ante 5xx y devuelve 503 con Retry-After al agotar los intentos", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      errorResponse(503, {}, new Headers({ "retry-after": "10" }))
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await validator.validate(TOKEN, TRIP_ID);

    expect(result).toMatchObject({
      valid: false,
      code: "DEPENDENCY_UNAVAILABLE",
      retryAfterSeconds: 10,
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("un error de red o timeout es 503 después de reintentar", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("timeout"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await validator.validate(TOKEN, TRIP_ID);

    expect(result).toMatchObject({ valid: false, code: "DEPENDENCY_UNAVAILABLE" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("usa el token del proveedor cuando está configurado", async () => {
    const provider: TokenProvider = { getToken: async () => "provider-token" };
    const withProvider = new M8QrValidatorService(M8_URL, 500, "ignorado", 0, 10, provider);
    const mockFetch = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", mockFetch);

    await withProvider.validate(TOKEN, TRIP_ID);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer provider-token" }),
      })
    );
  });

  it("si el proveedor no puede dar token, responde 503 sin llamar a M8", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider: TokenProvider = {
      getToken: async () => {
        throw new Error("keycloak caído");
      },
    };
    const withProvider = new M8QrValidatorService(M8_URL, 500, undefined, 0, 10, provider);
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const result = await withProvider.validate(TOKEN, TRIP_ID);

    expect(result).toMatchObject({ valid: false, code: "DEPENDENCY_UNAVAILABLE" });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  it("sin token configurado responde 503 y no llama a M8", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const withoutToken = new M8QrValidatorService(M8_URL, 500, undefined, 0, 10);
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const result = await withoutToken.validate(TOKEN, TRIP_ID);

    expect(result).toMatchObject({ valid: false, code: "DEPENDENCY_UNAVAILABLE" });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
