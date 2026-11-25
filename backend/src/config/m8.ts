import { loadAuthConfig } from "./auth.js";

/**
 * Configuración de la integración con M8 (Notificaciones y Documentos).
 *
 * El token de servicio se obtiene del mismo emisor que valida M6 (M1/Keycloak)
 * con `client_credentials`, pero la URL del endpoint de token puede diferir de
 * la pública: en el compose, el emisor es `localhost:8081` y el backend llega a
 * Keycloak por `http://keycloak:8080` (RNF-06 / RNF-13).
 */
export interface M8Config {
  /** URL base de M8. Sin valor, la validación de QR usa la simulación local. */
  apiUrl?: string;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  /** Token estático (solo desarrollo o pruebas manuales). */
  serviceToken?: string;
  /** Credenciales del cliente de M6 para pedir el token de servicio. */
  clientId?: string;
  clientSecret?: string;
  /** Endpoint de token del emisor. Por defecto se deriva del JWKS. */
  tokenUrl?: string;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function loadM8Config(env: NodeJS.ProcessEnv = process.env): M8Config {
  const auth = loadAuthConfig(env);
  const tokenUrl =
    env.AUTH_TOKEN_URL?.trim() || auth.jwksUri.replace(/\/certs\/?$/, "/token");

  return {
    ...(env.M8_API_URL?.trim() ? { apiUrl: env.M8_API_URL.trim() } : {}),
    timeoutMs: positiveNumber(env.M8_TIMEOUT_MS, 3000),
    maxRetries: nonNegativeInt(env.M8_MAX_RETRIES, 1),
    retryDelayMs: positiveNumber(env.M8_RETRY_DELAY_MS, 150),
    ...(env.M8_SERVICE_TOKEN?.trim() ? { serviceToken: env.M8_SERVICE_TOKEN.trim() } : {}),
    ...(env.AUTH_CLIENT_ID?.trim() ? { clientId: env.AUTH_CLIENT_ID.trim() } : {}),
    ...(env.AUTH_CLIENT_SECRET?.trim() ? { clientSecret: env.AUTH_CLIENT_SECRET.trim() } : {}),
    tokenUrl,
  };
}
