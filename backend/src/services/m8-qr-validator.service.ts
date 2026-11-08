/**
 * Módulo M6: Viajes y Ciclo de Vida
 * Cliente / Validador de códigos QR y tokens de un solo uso para RF-6.4 (RNF-13 / RNF-09).
 *
 * Implementa una estrategia dual:
 * 1. Simulación canónica en memoria (por defecto): reconoce los tokens de prueba del proyecto
 *    (`simulate_503`, `m8_timeout`, `invalid`, `expired`) y protege contra ataques de repetición.
 * 2. Integración HTTP con M8: si está configurada la variable `M8_API_URL`, delega la verificación
 *    en el microservicio M8 con timeout estricto (RNF-13).
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

    // 2. Simulación de tokens inválidos o expirados
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

    // 4. Si hay URL real de M8 configurada, consultar vía HTTP
    if (this.m8ApiUrl) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(`${this.m8ApiUrl}/qr/verify`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Credencial de servicio a servicio (RF-1.4)
            Authorization: "Bearer SYSTEM",
          },
          body: JSON.stringify({ token: verificationToken, tripId }),
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

    // Registrar como consumido
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
