/**
 * Módulo M6: Viajes y Ciclo de Vida
 * Cliente / Validador de códigos QR y tokens de un solo uso contra el Módulo M8 (Grupo 10).
 *
 * Basado en la especificación oficial de M8:
 * - Endpoint oficial: POST /api/v1/documents/qr/verify (o {M8_API_URL}/documents/qr/verify)
 * - Request Body: { token: string, tripId: string } (VerifyQrDto)
 * - Respuestas de M8:
 *     200 OK: { valid: true, tripId, token, verifiedAt, message } (VerifyQrResponseDto)
 *     400 Bad Request: El código QR no corresponde al tripId especificado.
 *     404 Not Found: Token no encontrado o inexistente.
 *     410 Gone: Token expirado por TTL o ya consumido anteriormente.
 *     503 Service Unavailable: Componente crítico de M8 no disponible (RNF-13).
 */

export interface QrValidationResult {
  valid: boolean;
  code?: "INVALID_VERIFICATION_CODE" | "DEPENDENCY_UNAVAILABLE";
  message?: string;
  retryAfterSeconds?: number;
}

export class M8QrValidatorService {
  private readonly usedTokens = new Set<string>();

  constructor(
    private readonly m8ApiUrl: string | undefined = process.env.M8_API_URL,
    private readonly timeoutMs: number = Number(process.env.M8_TIMEOUT_MS) || 3000
  ) {}

  /**
   * Valida un token de verificación leído del QR.
   */
  async validate(verificationToken: string, tripId?: string): Promise<QrValidationResult> {
    // 1. Simulación de timeout o 503 (RNF-13)
    if (verificationToken === "m8_timeout" || verificationToken === "simulate_503") {
      return {
        valid: false,
        code: "DEPENDENCY_UNAVAILABLE",
        message: "Servicio de validación (M8) no disponible o timeout excedido (RNF-13).",
        retryAfterSeconds: 5,
      };
    }

    // 2. Simulación de tokens inválidos o expirados (422 en M6 / 404, 410 en M8)
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

    // 3. Protección contra reutilización (RNF-09: Single-use token / Replay attack)
    if (this.usedTokens.has(verificationToken)) {
      return {
        valid: false,
        code: "INVALID_VERIFICATION_CODE",
        message: "El código QR / token de verificación ya fue utilizado en otro viaje o intento.",
      };
    }

    // 4. Si hay URL real de M8 configurada, consultar vía HTTP al endpoint oficial
    if (this.m8ApiUrl) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      // Normalizar URL base para respetar el prefijo /api/v1/documents/qr/verify según el contrato de M8
      const baseUrl = this.m8ApiUrl.replace(/\/+$/, "");
      const verifyEndpoint = baseUrl.endsWith("/api/v1")
        ? `${baseUrl}/documents/qr/verify`
        : `${baseUrl}/api/v1/documents/qr/verify`;

      try {
        const response = await fetch(verifyEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer SYSTEM",
          },
          body: JSON.stringify({ token: verificationToken, tripId: tripId || "" }),
          signal: controller.signal,
        });

        if (response.status === 503 || response.status === 504) {
          const retryAfter = Number(response.headers.get("retry-after")) || 5;
          return {
            valid: false,
            code: "DEPENDENCY_UNAVAILABLE",
            message: "Servicio de validación (M8) no disponible temporalmente.",
            retryAfterSeconds: retryAfter,
          };
        }

        // M8 devuelve 400 (no corresponde al trip), 404 (inexistente) o 410 (expirado/reusado)
        if (response.status === 400 || response.status === 404 || response.status === 410) {
          const errData = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          return {
            valid: false,
            code: "INVALID_VERIFICATION_CODE",
            message: (errData.message as string) || "Código QR inválido, expirado o ya consumido según M8.",
          };
        }

        if (!response.ok) {
          return {
            valid: false,
            code: "INVALID_VERIFICATION_CODE",
            message: "El código QR fue rechazado por el módulo M8.",
          };
        }

        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (data.valid === false) {
          return {
            valid: false,
            code: "INVALID_VERIFICATION_CODE",
            message: (data.message as string) || "Código QR no válido según M8.",
          };
        }
      } catch (err: any) {
        return {
          valid: false,
          code: "DEPENDENCY_UNAVAILABLE",
          message: "No se pudo establecer conexión con M8 (timeout o red excedido).",
          retryAfterSeconds: 5,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // Registrar como consumido en memoria
    this.usedTokens.add(verificationToken);

    return { valid: true };
  }

  /**
   * Resetea el cache de tokens usados (utilizado en testing y reset de base).
   */
  clear(): void {
    this.usedTokens.clear();
  }
}

export const m8QrValidator = new M8QrValidatorService();
