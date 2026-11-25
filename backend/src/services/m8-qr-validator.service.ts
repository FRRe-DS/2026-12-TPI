import crypto from "node:crypto";
import { loadM8Config } from "../config/m8.js";
import {
  ClientCredentialsTokenProvider,
  ServiceTokenError,
  type TokenProvider,
} from "./service-token.service.js";

/**
 * Módulo M6: Viajes y Ciclo de Vida
 * Cliente / Validador de códigos QR y tokens de un solo uso contra el Módulo M8.
 *
 * Cumplimiento de Requerimientos:
 * - RF-6.4: Validación del token de un solo uso para habilitar `DRIVER_ARRIVED -> IN_PROGRESS`.
 * - RNF-03: Contrato vigente de M8: `POST /api/v1/qr/validaciones` con `{ token, viajeId }`,
 *   `Idempotency-Key` obligatorio y errores `404` / `409` / `422`.
 * - RNF-06: Configuración por entorno (`M8_API_URL`, timeout, reintentos y credenciales del
 *   cliente de M6 para pedir el token de servicio).
 * - RNF-09: El `Idempotency-Key` se deriva de `(viajeId, token)`, así un reintento después de
 *   un timeout devuelve la respuesta original de M8 en lugar de un `409` por "ya usado".
 *   La fuente canónica de verdad es M8; la simulación local usa memoria.
 * - RNF-13: Timeout por intento, reintentos limitados ante fallas transitorias y `503`
 *   explícito con `Retry-After`; un error de autenticación entre servicios nunca se
 *   presenta como QR inválido.
 */

export interface QrValidationResult {
  valid: boolean;
  code?: "INVALID_VERIFICATION_CODE" | "DEPENDENCY_UNAVAILABLE";
  message?: string;
  retryAfterSeconds?: number;
}

/** Errores de negocio del contrato de M8: el token no sirve, reintentar no ayuda. */
const INVALID_STATUSES = new Set([400, 404, 409, 413, 415, 422]);
/** Fallas transitorias: se reintentan y, si persisten, son `503` en M6. */
const TRANSIENT_STATUSES = new Set([408, 429]);

function buildIdempotencyKey(tripId: string | undefined, token: string): string {
  const digest = crypto.createHash("sha256").update(token).digest("hex").slice(0, 32);
  return `qr-${tripId ?? "sin-viaje"}-${digest}`;
}

/** El contrato de M8 usa RFC 9457 (`detail` / `title`); se acepta `message` por compatibilidad. */
function readProblemMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const problem = body as Record<string, unknown>;
  for (const field of ["detail", "title", "message"]) {
    const value = problem[field];
    if (typeof value === "string" && value.trim() !== "") return value;
    if (Array.isArray(value) && value.length > 0) return value.join("; ");
  }
  return undefined;
}

export class M8QrValidatorService {
  /**
   * Registro en memoria de tokens consumidos para simulación y pruebas locales (RNF-09).
   * Con M8 configurado, el quemado atómico lo garantiza M8.
   */
  private readonly usedTokens = new Set<string>();
  private readonly m8ApiUrl: string | undefined;

  /**
   * @param m8ApiUrl URL base de M8. Pasar `""` desactiva explícitamente M8 (tests aislados).
   * @param timeoutMs Timeout por intento en milisegundos (RNF-13).
   * @param serviceToken Token estático de servicio (solo desarrollo o pruebas).
   * @param maxRetries Reintentos ante fallas transitorias (RNF-13).
   * @param retryDelayMs Espera entre reintentos.
   * @param tokenProvider Si se indica, obtiene el token de servicio (client_credentials).
   */
  constructor(
    m8ApiUrl: string | undefined = process.env.M8_API_URL,
    private readonly timeoutMs: number = Number(process.env.M8_TIMEOUT_MS) || 3000,
    private readonly serviceToken: string | undefined = process.env.M8_SERVICE_TOKEN,
    private readonly maxRetries: number = Number.isFinite(Number(process.env.M8_MAX_RETRIES))
      ? Number(process.env.M8_MAX_RETRIES)
      : 1,
    private readonly retryDelayMs: number = Number(process.env.M8_RETRY_DELAY_MS) || 150,
    private readonly tokenProvider?: TokenProvider
  ) {
    const trimmed = m8ApiUrl?.trim();
    this.m8ApiUrl = trimmed && trimmed.length > 0 ? trimmed : undefined;
  }

  /**
   * Valida un token de verificación leído del QR para un viaje específico.
   *
   * @param verificationToken Código o token presentado por el conductor.
   * @param tripId Identificador UUID del viaje asociado.
   * @param correlationId Identificador de correlación a propagar a M8 (RNF-14).
   */
  async validate(
    verificationToken: string,
    tripId?: string,
    correlationId?: string
  ): Promise<QrValidationResult> {
    if (this.m8ApiUrl) {
      return this.validateAgainstM8Http(verificationToken, tripId, correlationId);
    }
    return this.validateLocalSimulation(verificationToken);
  }

  private buildEndpoint(): string {
    const baseUrl = this.m8ApiUrl!.replace(/\/+$/, "");
    return baseUrl.endsWith("/api/v1")
      ? `${baseUrl}/qr/validaciones`
      : `${baseUrl}/api/v1/qr/validaciones`;
  }

  private async resolveServiceToken(): Promise<string | undefined> {
    if (this.tokenProvider) {
      return this.tokenProvider.getToken();
    }
    return this.serviceToken;
  }

  private unavailable(message: string, retryAfterSeconds = 5): QrValidationResult {
    return { valid: false, code: "DEPENDENCY_UNAVAILABLE", message, retryAfterSeconds };
  }

  /**
   * Consulta el contrato vigente de M8: `POST /api/v1/qr/validaciones`.
   */
  private async validateAgainstM8Http(
    verificationToken: string,
    tripId?: string,
    correlationId?: string
  ): Promise<QrValidationResult> {
    const endpoint = this.buildEndpoint();
    const idempotencyKey = buildIdempotencyKey(tripId, verificationToken);

    let serviceToken: string | undefined;
    try {
      serviceToken = await this.resolveServiceToken();
    } catch (err) {
      const detail = err instanceof ServiceTokenError ? err.message : "error desconocido";
      console.error(`[M8QrValidatorService] No se pudo obtener el token de servicio: ${detail}`);
      return this.unavailable("No se pudo autenticar contra M8 para validar el QR.");
    }

    if (!serviceToken) {
      console.error(
        "[M8QrValidatorService] Falta el token de servicio hacia M8: configure AUTH_CLIENT_ID/AUTH_CLIENT_SECRET (o M8_SERVICE_TOKEN en desarrollo)."
      );
      return this.unavailable("Falta configurar la autenticación entre servicios hacia M8.");
    }

    const attempts = 1 + Math.max(0, this.maxRetries);
    let lastFailure: QrValidationResult | null = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceToken}`,
            "Idempotency-Key": idempotencyKey,
            ...(correlationId ? { "X-Request-Id": correlationId } : {}),
          },
          body: JSON.stringify({ token: verificationToken, viajeId: tripId ?? "" }),
          signal: controller.signal,
        });

        // Configuración de servicio a servicio: no es culpa del pasajero (RNF-19).
        if (response.status === 401 || response.status === 403) {
          console.error(
            `[M8QrValidatorService] Error HTTP ${response.status} al autenticar contra M8 (${endpoint}). Verifique el token de servicio de M6.`
          );
          return this.unavailable(
            "Servicio de validación (M8) no disponible por error de autenticación entre servicios."
          );
        }

        // Fallas transitorias: se reintentan y, si persisten, son 503 en M6 (RNF-13).
        if (TRANSIENT_STATUSES.has(response.status) || response.status >= 500) {
          const retryAfter = Number(response.headers?.get?.("retry-after")) || 5;
          lastFailure = this.unavailable(
            "Servicio de validación (M8) no disponible temporalmente.",
            retryAfter
          );

          if (attempt < attempts) {
            await this.sleep(this.retryDelayMs);
            continue;
          }
          return lastFailure;
        }

        // Errores de negocio del contrato: el token no existe, ya se usó, fue reemplazado,
        // expiró o no corresponde al viaje. No se reintentan (RF-6.4).
        if (INVALID_STATUSES.has(response.status)) {
          const body = await response.json().catch(() => ({}));
          return {
            valid: false,
            code: "INVALID_VERIFICATION_CODE",
            message:
              readProblemMessage(body) ??
              "El código QR es inválido, ya fue usado, expiró o no corresponde a este viaje.",
          };
        }

        if (!response.ok) {
          return {
            valid: false,
            code: "INVALID_VERIFICATION_CODE",
            message: "El código QR fue rechazado por el módulo M8.",
          };
        }

        // 200: el QR quedó consumido en M8. Se devuelve { qrId, viajeId, usadoEn }.
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (tripId && typeof data.viajeId === "string" && data.viajeId !== tripId) {
          return {
            valid: false,
            code: "INVALID_VERIFICATION_CODE",
            message: "El código QR no corresponde a este viaje.",
          };
        }

        return { valid: true };
      } catch {
        lastFailure = this.unavailable(
          "No se pudo establecer conexión con M8 (timeout o error de red)."
        );

        if (attempt < attempts) {
          await this.sleep(this.retryDelayMs);
          continue;
        }
        return lastFailure;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return lastFailure ?? this.unavailable("Servicio de validación (M8) no disponible.");
  }

  /**
   * Simulación local en memoria cuando M8_API_URL no está configurada.
   */
  private validateLocalSimulation(verificationToken: string): QrValidationResult {
    if (verificationToken === "m8_timeout" || verificationToken === "simulate_503") {
      return this.unavailable("Servicio de validación (M8) no disponible o timeout excedido (RNF-13).");
    }

    if (
      verificationToken === "invalid" ||
      verificationToken === "expired" ||
      verificationToken.startsWith("invalid_")
    ) {
      return {
        valid: false,
        code: "INVALID_VERIFICATION_CODE",
        message: "El código QR / token de verificación es inválido, ya fue usado o expiró.",
      };
    }

    if (this.usedTokens.has(verificationToken)) {
      return {
        valid: false,
        code: "INVALID_VERIFICATION_CODE",
        message: "El código QR / token de verificación ya fue utilizado en otro viaje o intento.",
      };
    }

    this.usedTokens.add(verificationToken);
    return { valid: true };
  }

  /** Resetea el cache de tokens usados (tests). */
  clear(): void {
    this.usedTokens.clear();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

const m8Config = loadM8Config();

/** Con credenciales configuradas se pide el token por `client_credentials`; si no, se usa el estático. */
const m8TokenProvider =
  !m8Config.serviceToken && m8Config.clientId && m8Config.clientSecret && m8Config.tokenUrl
    ? new ClientCredentialsTokenProvider({
        tokenUrl: m8Config.tokenUrl,
        clientId: m8Config.clientId,
        clientSecret: m8Config.clientSecret,
        timeoutMs: m8Config.timeoutMs,
      })
    : undefined;

export const m8QrValidator = new M8QrValidatorService(
  m8Config.apiUrl,
  m8Config.timeoutMs,
  m8Config.serviceToken,
  m8Config.maxRetries,
  m8Config.retryDelayMs,
  m8TokenProvider
);
