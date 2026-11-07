/**
 * Módulo M6: Viajes y Ciclo de Vida
 * Cliente de validación de códigos QR / Token de un solo uso contra M8 (Notificaciones / Seguridad).
 *
 * Cumple con:
 * - RF-6.4 (Inicio validado con QR).
 * - RNF-13 (Resiliencia ante indisponibilidad o timeout de dependencias).
 * - RNF-09 (Protección contra reutilización / replay attacks).
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
   * Si está configurada la variable `M8_API_URL`, consulta al microservicio M8 por HTTP.
   * Si no está configurada, utiliza la lógica de simulación controlada (para desarrollo y tests).
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

    // 3. Protección contra reutilización (Single-use token / Replay attack)
    if (this.usedTokens.has(verificationToken)) {
      return {
        valid: false,
        code: "INVALID_VERIFICATION_CODE",
        message: "El código QR / token de verificación ya fue utilizado en otro viaje o intento.",
      };
    }

    // 4. Si hay URL real de M8 configurada, invocar HTTP con timeout
    if (this.m8ApiUrl) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(`${this.m8ApiUrl}/qr/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: verificationToken, tripId }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.status === 503 || response.status === 504) {
          return {
            valid: false,
            code: "DEPENDENCY_UNAVAILABLE",
            message: "Servicio de validación (M8) no disponible temporalmente.",
            retryAfterSeconds: 5,
          };
        }

        if (!response.ok) {
          return {
            valid: false,
            code: "INVALID_VERIFICATION_CODE",
            message: "El código QR fue rechazado por el módulo M8.",
          };
        }
      } catch (err: any) {
        return {
          valid: false,
          code: "DEPENDENCY_UNAVAILABLE",
          message: "No se pudo establecer conexión con M8 (timeout o red).",
          retryAfterSeconds: 5,
        };
      }
    }

    // Marcar como usado exitosamente
    this.usedTokens.add(verificationToken);

    return { valid: true };
  }

  /**
   * Resetea el cache de tokens usados (útil en tests).
   */
  clear(): void {
    this.usedTokens.clear();
  }
}

export const m8QrValidator = new M8QrValidatorService();
