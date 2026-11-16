import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { M8QrValidatorService } from "../src/services/m8-qr-validator.service.js";

describe("M8QrValidatorService - Pruebas Unitarias Directas", () => {
  let validator: M8QrValidatorService;

  beforeEach(() => {
    validator = new M8QrValidatorService(undefined, 100);
    validator.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("debe validar exitosamente un token válido en modo simulado", async () => {
    const result = await validator.validate("token_valido_123");
    expect(result.valid).toBe(true);
    expect(result.code).toBeUndefined();
  });

  it("debe rechazar tokens con error 503 cuando se envía m8_timeout o simulate_503 (RNF-13)", async () => {
    const resTimeout = await validator.validate("m8_timeout");
    expect(resTimeout.valid).toBe(false);
    expect(resTimeout.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(resTimeout.retryAfterSeconds).toBe(5);

    const res503 = await validator.validate("simulate_503");
    expect(res503.valid).toBe(false);
    expect(res503.code).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("debe rechazar tokens con error 422 cuando son invalid o expired", async () => {
    const resInvalid = await validator.validate("invalid");
    expect(resInvalid.valid).toBe(false);
    expect(resInvalid.code).toBe("INVALID_VERIFICATION_CODE");

    const resExpired = await validator.validate("expired");
    expect(resExpired.valid).toBe(false);
    expect(resExpired.code).toBe("INVALID_VERIFICATION_CODE");

    const resPrefix = await validator.validate("invalid_codigo");
    expect(resPrefix.valid).toBe(false);
    expect(resPrefix.code).toBe("INVALID_VERIFICATION_CODE");
  });

  it("debe rechazar la reutilización de tokens en modo local (single-use / replay attack - RNF-09)", async () => {
    const token = "single_use_token_999";

    const primerIntento = await validator.validate(token);
    expect(primerIntento.valid).toBe(true);

    const segundoIntento = await validator.validate(token);
    expect(segundoIntento.valid).toBe(false);
    expect(segundoIntento.code).toBe("INVALID_VERIFICATION_CODE");
    expect(segundoIntento.message).toMatch(/ya fue utilizado/i);
  });

  it("debe limpiar los tokens usados al invocar clear()", async () => {
    const token = "token_a_limpiar";
    await validator.validate(token);

    validator.clear();

    const reintento = await validator.validate(token);
    expect(reintento.valid).toBe(true);
  });

  it("cuando M8_API_URL está configurada, debe realizar fetch HTTP hacia /api/v1/documents/qr/verify según contrato oficial", async () => {
    const httpValidator = new M8QrValidatorService("http://m8-notificaciones:3000", 500);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        tripId: "trip-9082",
        token: "qr_trip-9082_a1b2c3d4e5f67890",
        message: "Código QR verificado exitosamente.",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await httpValidator.validate("qr_trip-9082_a1b2c3d4e5f67890", "trip-9082");

    expect(result.valid).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://m8-notificaciones:3000/api/v1/documents/qr/verify",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer SYSTEM",
        },
        body: JSON.stringify({ token: "qr_trip-9082_a1b2c3d4e5f67890", tripId: "trip-9082" }),
      })
    );
  });

  it("debe usar el token de servicio configurable (M8_SERVICE_TOKEN) en la cabecera Authorization (RNF-06)", async () => {
    const customTokenValidator = new M8QrValidatorService(
      "http://m8-notificaciones:3000",
      500,
      "custom_m8_jwt_service_token_xyz"
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        tripId: "trip-9082",
        token: "qr_trip-9082_a1b2c3d4e5f67890",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await customTokenValidator.validate("qr_trip-9082_a1b2c3d4e5f67890", "trip-9082");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer custom_m8_jwt_service_token_xyz",
        }),
      })
    );
  });

  it("debe reintentar ante fallas transitorias (503/red) y tener éxito si el segundo intento responde 200 (RNF-13)", async () => {
    // Configuramos 1 reintento con espera corta de 10ms
    const retryValidator = new M8QrValidatorService(
      "http://m8-notificaciones:3000",
      500,
      "SYSTEM",
      1,
      10
    );

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers({ "retry-after": "5" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          valid: true,
          tripId: "trip-9082",
          token: "qr_token_ok",
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await retryValidator.validate("qr_token_ok", "trip-9082");

    expect(result.valid).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("cuando se agotan todos los reintentos ante error de red/timeout, debe retornar DEPENDENCY_UNAVAILABLE (RNF-13)", async () => {
    const retryValidator = new M8QrValidatorService(
      "http://m8-notificaciones:3000",
      200,
      "SYSTEM",
      1,
      10
    );

    const mockFetch = vi.fn().mockRejectedValue(new Error("Connection reset / timeout"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await retryValidator.validate("qr_timeout_token", "trip-9082");

    expect(result.valid).toBe(false);
    expect(result.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(result.retryAfterSeconds).toBe(5);
    expect(mockFetch).toHaveBeenCalledTimes(2); // 1 inicial + 1 reintento
  });

  it("cuando M8 responde 410 (Token consumido/expirado), es un error definitivo y NO debe reintentar", async () => {
    const retryValidator = new M8QrValidatorService(
      "http://m8-notificaciones:3000",
      500,
      "SYSTEM",
      2,
      10
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 410,
      json: async () => ({
        statusCode: 410,
        message: "El código QR ya fue utilizado anteriormente (código de un solo uso consumido).",
        error: "Gone",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await retryValidator.validate("qr_ya_quemado", "trip-9082");

    expect(result.valid).toBe(false);
    expect(result.code).toBe("INVALID_VERIFICATION_CODE");
    expect(result.message).toMatch(/consumido|utilizado/i);
    expect(mockFetch).toHaveBeenCalledTimes(1); // Error definitivo: NO reintenta
  });

  it("cuando M8 responde 404 (No encontrado), debe mapear a INVALID_VERIFICATION_CODE sin reintentar", async () => {
    const retryValidator = new M8QrValidatorService(
      "http://m8-notificaciones:3000",
      500,
      "SYSTEM",
      1,
      10
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        statusCode: 404,
        message: "Código QR no encontrado o inválido.",
        error: "Not Found",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await retryValidator.validate("qr_inexistente", "trip-9082");

    expect(result.valid).toBe(false);
    expect(result.code).toBe("INVALID_VERIFICATION_CODE");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("cuando M8 responde 503 HTTP y se agotan los reintentos, debe retornar DEPENDENCY_UNAVAILABLE con Retry-After", async () => {
    const retryValidator = new M8QrValidatorService(
      "http://m8-notificaciones:3000",
      500,
      "SYSTEM",
      1,
      10
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ "retry-after": "10" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await retryValidator.validate("qr_con_m8_caido");

    expect(result.valid).toBe(false);
    expect(result.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(result.retryAfterSeconds).toBe(10);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
