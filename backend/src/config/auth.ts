/**
 * Configuración de la validación del JWT emitido por M1 (Keycloak).
 *
 * Todo sale de variables de entorno (RNF-06): la URL del emisor cambia entre
 * desarrollo, el entorno compartido y un despliegue publicado, y el código no
 * debe cambiar por eso (RNF-18).
 */
export interface AuthConfig {
  /** `iss` esperado en el token. */
  issuer: string;
  /** Endpoint JWKS de donde se bajan las claves públicas. */
  jwksUri: string;
  /** Audiencia esperada, solo si el emisor la define (Keycloak no la incluye por defecto). */
  audience?: string;
  /** Plazo máximo para bajar el JWKS (RNF-13: nunca bloquear indefinidamente). */
  timeoutMs: number;
  /** Cuánto se conservan las claves en memoria antes de volver a pedirlas. */
  cacheTtlMs: number;
  /** Tolerancia de reloj al comparar `exp`, `nbf` e `iat`, en segundos. */
  clockToleranceSec: number;
  /** Tras un fallo al bajar el JWKS, cuánto se espera antes de volver a intentarlo. */
  refreshCooldownMs: number;
}

/** Realm de la cátedra (FRRe-DS/2026-TPI, carpeta `keycloak/`). El compose del módulo usa 8081. */
export const DEFAULT_AUTH_ISSUER = "http://localhost:8080/realms/ds-2026-realm";

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const issuer = (env.AUTH_ISSUER?.trim() || DEFAULT_AUTH_ISSUER).replace(/\/+$/, "");
  const jwksUri = env.AUTH_JWKS_URI?.trim() || `${issuer}/protocol/openid-connect/certs`;

  return {
    issuer,
    jwksUri,
    ...(env.AUTH_AUDIENCE?.trim() ? { audience: env.AUTH_AUDIENCE.trim() } : {}),
    timeoutMs: positiveNumber(env.AUTH_JWKS_TIMEOUT_MS, 3000),
    cacheTtlMs: positiveNumber(env.AUTH_JWKS_CACHE_MS, 10 * 60 * 1000),
    clockToleranceSec: positiveNumber(env.AUTH_CLOCK_TOLERANCE_SEC, 5),
    refreshCooldownMs: positiveNumber(env.AUTH_JWKS_COOLDOWN_MS, 5000),
  };
}
