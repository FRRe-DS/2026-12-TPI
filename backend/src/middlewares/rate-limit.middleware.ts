import http from "node:http";
import type { AuthContext } from "./auth.middleware.js";
import { ApiError } from "./error.middleware.js";

const WINDOW_MS = 60_000;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

/** Cuenta un pedido de `key` en una ventana fija de 1 minuto. */
export function checkRateLimit(key: string, limit: number, now: number = Date.now()): RateLimitResult {
  // Limpieza para que el mapa no crezca sin límite.
  if (buckets.size > 10_000) {
    buckets.forEach((b, k) => {
      if (b.resetAt <= now) buckets.delete(k);
    });
  }

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, bucket);
  }

  const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  if (bucket.count >= limit) {
    return { allowed: false, limit, remaining: 0, resetSeconds };
  }
  bucket.count += 1;
  return { allowed: true, limit, remaining: limit - bucket.count, resetSeconds };
}

/** Solo para tests. */
export function resetRateLimits(): void {
  buckets.clear();
}

function limitFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Aplica el límite por usuario o servicio (RNF-12): 120/min para usuarios y 1200/min para servicios
 * (SYSTEM), configurables con RATE_LIMIT_USER_PER_MIN y RATE_LIMIT_SERVICE_PER_MIN.
 * Deja los headers RateLimit-* en la respuesta y lanza 429 si se superó el límite.
 */
export function applyRateLimit(auth: AuthContext, res: http.ServerResponse): void {
  const limit =
    auth.role === "SYSTEM"
      ? limitFromEnv("RATE_LIMIT_SERVICE_PER_MIN", 1200)
      : limitFromEnv("RATE_LIMIT_USER_PER_MIN", 120);

  const result = checkRateLimit(`${auth.role}:${auth.sub}`, limit);
  res.setHeader("RateLimit-Limit", String(result.limit));
  res.setHeader("RateLimit-Remaining", String(result.remaining));
  res.setHeader("RateLimit-Reset", String(result.resetSeconds));

  if (!result.allowed) {
    throw new ApiError(
      429,
      "TOO_MANY_REQUESTS",
      `Superaste el límite de ${result.limit} pedidos por minuto. Reintentá en ${result.resetSeconds} segundos.`,
      { headers: { "Retry-After": String(result.resetSeconds) } }
    );
  }
}