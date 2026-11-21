/**
 * Módulo M6: Viajes y Ciclo de Vida
 * Cliente / Validador de códigos QR y tokens de un solo uso contra el Módulo M8 (Grupo 10).
 *
 * Cumplimiento de Requerimientos:
 * - RF-6.4: Validación de código QR / token de un solo uso para habilitar la transición DRIVER_ARRIVED -> IN_PROGRESS.
 * - RNF-03: Contratos e integración alineada al OpenAPI oficial de M8 (POST /api/v1/documents/qr/verify).
 * - RNF-06: Configuración mediante variables de entorno (M8_API_URL, M8_TIMEOUT_MS, M8_SERVICE_TOKEN, etc.).
 * - RNF-09: Unicidad y quemado atómico del token (Single-use token). En entorno integrado con M8 configurado,
 *   la fuente canónica de verdad es M8 (que persiste en Redis con TTL de 300s y PostgreSQL para auditoría,
 *   respondiendo 410 Gone si el token ya fue consumido o expiró). En entorno local sin M8, se utiliza una
 *   colección en memoria (usedTokens) como salvaguarda defensiva y simulación de replay attack.
 *   Nota de diseño sobre reintentos: si el primer intento contra M8 sufre timeout tras haber consumido el QR en M8,
 *   el reintento podría recibir 410 Gone; queda documentado para coordinar con M8 (Grupo 10) la idempotencia
 *   de POST /api/v1/documents/qr/verify para el mismo par (tripId, token).
 * - RNF-13: Resiliencia ante fallos en dependencias externas: timeout estricto por petición (AbortController),
 *   reintentos limitados (maxRetries) ante fallas transitorias de red o errores 5xx de M8, log de error y 503
 *   ante fallas de configuración (401/403), y respuesta explícita 503 DEPENDENCY_UNAVAILABLE con Retry-After.
 */

export interface QrValidationResult {
  valid: boolean;
  code?: "INVALID_VERIFICATION_CODE" | "DEPENDENCY_UNAVAILABLE";
  message?: string;
  retryAfterSeconds?: number;
}

export class M8QrValidatorService {
  /**
   * Registro en memoria de tokens consumidos para simulación y pruebas locales (RNF-09).
   * Nota de arquitectura: en producción con M8 activo, el quemado atómico lo garantiza M8 con Redis (410 Gone).
   */
  private readonly usedTokens = new Set<string>();
  private readonly m8ApiUrl: string | undefined;

  /**
   * @param m8ApiUrl URL base de M8. Pasar `""` desactiva explícitamente M8 (útil en tests unitarios para aislar del entorno).
   * @param timeoutMs Timeout por intento en milisegundos (RNF-13).
   * @param serviceToken Token de autorización inter-servicio enviado en Authorization: Bearer (RNF-06).
   * @param maxRetries Cantidad máxima de reintentos ante fallos transitorios de red o 5xx (RNF-13).
   * @param retryDelayMs Espera en milisegundos entre reintentos.
   */
  constructor(
    m8ApiUrl: string | undefined = process.env.M8_API_URL,
    private readonly timeoutMs: number = Number(process.env.M8_TIMEOUT_MS) || 3000,
    private readonly serviceToken: string = process.env.M8_SERVICE_TOKEN || "SYSTEM",
    private readonly maxRetries: number = Number.isFinite(Number(process.env.M8_MAX_RETRIES))
      ? Number(process.env.M8_MAX_RETRIES)
      : 1,
    private readonly retryDelayMs: number = Number(process.env.M8_RETRY_DELAY_MS) || 150
  ) {
    const trimmed = m8ApiUrl?.trim();
    this.m8ApiUrl = trimmed && trimmed.length > 0 ? trimmed : undefined;
  }

  /**
   * Valida un token de verificación leído del QR para un viaje específico.
   *
   * @param verificationToken Código o token de verificación presentado por el conductor
   * @param tripId Identificador UUID del viaje asociado
   */
  async validate(verificationToken: string, tripId?: string): Promise<QrValidationResult> {
    // Modo 1: Integración HTTP real cuando M8_API_URL está configurada.
    // Los tokens de simulación local no interceptan pedidos cuando hay un M8 real configurado.
    if (this.m8ApiUrl) {
      return this.validateAgainstM8Http(verificationToken, tripId);
    }

    // Modo 2: Simulación local en memoria (cuando M8_API_URL no está definida)
    return this.validateLocalSimulation(verificationToken);
  }

  /**
   * Consulta vía HTTP al endpoint oficial de M8: POST /api/v1/documents/qr/verify
   * con timeout estricto y reintentos limitados ante fallas transitorias (RNF-13).
   */
  private async validateAgainstM8Http(
    verificationToken: string,
    tripId?: string
  ): Promise<QrValidationResult> {
    const baseUrl = this.m8ApiUrl!.replace(/\/+$/, "");
    const verifyEndpoint = baseUrl.endsWith("/api/v1")
      ? `${baseUrl}/documents/qr/verify`
      : `${baseUrl}/api/v1/documents/qr/verify`;

    const attempts = 1 + Math.max(0, this.maxRetries);
    let lastFailureResult: QrValidationResult | null = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(verifyEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.serviceToken}`,
          },
          body: JSON.stringify({ token: verificationToken, tripId: tripId || "" }),
          signal: controller.signal,
        });

        // Error de autenticación/autorización servicio a servicio (401 / 403):
        // No es culpa del QR del pasajero sino de configuración (ej. M8_SERVICE_TOKEN inválido).
        // Se registra en el log del servidor (sin exponer secretos, RNF-19) y se devuelve 503 sin reintentar.
        if (response.status === 401 || response.status === 403) {
          console.error(
            `[M8QrValidatorService] Error HTTP ${response.status} al autenticar contra M8 (${verifyEndpoint}). Verifique la configuracion de M8_SERVICE_TOKEN.`
          );
          return {
            valid: false,
            code: "DEPENDENCY_UNAVAILABLE",
            message: "Servicio de validación (M8) no disponible por error de autenticación entre servicios.",
            retryAfterSeconds: 5,
          };
        }

        // Fallas del servidor en M8 (5xx: 500, 502, 503, 504):
        // Se mapean a 503 DEPENDENCY_UNAVAILABLE (nunca a 422 QR inválido) y admiten reintento.
        if (response.status >= 500) {
          const retryAfter = Number(response.headers?.get?.("retry-after")) || 5;
          lastFailureResult = {
            valid: false,
            code: "DEPENDENCY_UNAVAILABLE",
            message: "Servicio de validación (M8) no disponible temporalmente.",
            retryAfterSeconds: retryAfter,
          };

          if (attempt < attempts) {
            await this.sleep(this.retryDelayMs);
            continue;
          }
          return lastFailureResult;
        }

        // Respuestas definitivas de negocio según el contrato de M8 (no reintentables):
        // 400 Bad Request: El código QR no corresponde a este viaje
        // 404 Not Found: Código QR no encontrado o inexistente
        // 410 Gone: El código QR ya fue utilizado anteriormente o expiró por TTL
        if (response.status === 400 || response.status === 404 || response.status === 410) {
          const errData = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          const rawMessage = Array.isArray(errData.message)
            ? errData.message.join("; ")
            : (errData.message as string);
          return {
            valid: false,
            code: "INVALID_VERIFICATION_CODE",
            message: rawMessage || "Código QR inválido, expirado o ya consumido según M8.",
          };
        }

        if (!response.ok) {
          return {
            valid: false,
            code: "INVALID_VERIFICATION_CODE",
            message: "El código QR fue rechazado por el módulo M8.",
          };
        }

        // 200 OK: Verificar explícitamente el cuerpo { valid: true }
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (data.valid !== true) {
          return {
            valid: false,
            code: "INVALID_VERIFICATION_CODE",
            message: (data.message as string) || "Código QR no válido según M8.",
          };
        }

        // Validación exitosa contra M8 (M8 ya quemó atómicamente el código en su Redis)
        return { valid: true };
      } catch {
        // Error de red, socket cerrado o AbortError (timeout excedido) -> falla transitoria (RNF-13)
        lastFailureResult = {
          valid: false,
          code: "DEPENDENCY_UNAVAILABLE",
          message: "No se pudo establecer conexión con M8 (timeout o red excedido).",
          retryAfterSeconds: 5,
        };

        if (attempt < attempts) {
          await this.sleep(this.retryDelayMs);
          continue;
        }
        return lastFailureResult;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return (
      lastFailureResult ?? {
        valid: false,
        code: "DEPENDENCY_UNAVAILABLE",
        message: "Servicio de validación (M8) no disponible.",
        retryAfterSeconds: 5,
      }
    );
  }

  /**
   * Simulación local en memoria cuando M8_API_URL no está configurada.
   */
  private validateLocalSimulation(verificationToken: string): QrValidationResult {
    // 1. Simulación de timeout o falla 503 para tests (RNF-13)
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

    // 3. Protección local contra reutilización (RNF-09: Single-use token en modo desarrollo/simulado)
    if (this.usedTokens.has(verificationToken)) {
      return {
        valid: false,
        code: "INVALID_VERIFICATION_CODE",
        message: "El código QR / token de verificación ya fue utilizado en otro viaje o intento.",
      };
    }

    // 4. Registrar el token como consumido en memoria
    this.usedTokens.add(verificationToken);

    return { valid: true };
  }

  /**
   * Resetea el cache de tokens usados (utilizado en tests).
   */
  clear(): void {
    this.usedTokens.clear();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const m8QrValidator = new M8QrValidatorService();
