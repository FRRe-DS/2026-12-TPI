import crypto from "node:crypto";
import type { AuthConfig } from "../config/auth.js";

/** Claims del token que M6 necesita. El resto se conserva por si otro módulo los usa. */
export interface JwtClaims {
  iss?: string;
  sub?: string;
  azp?: string;
  client_id?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  aud?: string | string[];
  roles?: unknown;
  role?: unknown;
  realm_access?: { roles?: unknown };
  [claim: string]: unknown;
}

/** El token está mal formado, vencido, mal firmado o no lo emitió M1. Siempre es un 401. */
export class InvalidTokenError extends Error {}

/** No se pudo obtener el JWKS (red, timeout o error del emisor). Se responde 503, no 401. */
export class JwksUnavailableError extends Error {}

interface Jwk extends crypto.webcrypto.JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

interface JwkSet {
  keys?: Jwk[];
}

/** No se vuelve a pedir el JWKS por un `kid` desconocido más de una vez cada 10 s (evita abuso). */
const MIN_FORCED_REFRESH_MS = 10_000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function decodeJsonSegment(segment: string): Record<string, unknown> {
  try {
    const json = Buffer.from(segment, "base64url").toString("utf-8");
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("no es un objeto");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new InvalidTokenError("El token no tiene un payload JSON válido.");
  }
}

/**
 * Verifica la firma de un JWT contra el JWKS de M1 y valida `iss`, `exp`, `nbf`,
 * `iat` y (opcionalmente) `aud`.
 *
 * Se implementa con `node:crypto` para no sumar dependencias: el algoritmo
 * acordado con Keycloak es RS256 y las claves viajan como JWK.
 */
export class JwtVerifier {
  private keys = new Map<string, crypto.KeyObject>();
  private fetchedAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly config: AuthConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly minForcedRefreshMs: number = MIN_FORCED_REFRESH_MS
  ) {}

  async verify(token: string): Promise<JwtClaims> {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw new InvalidTokenError("El token no tiene el formato header.payload.firma.");
    }

    const header = decodeJsonSegment(parts[0]);
    if (header.alg !== "RS256") {
      // Rechazar cualquier otro algoritmo evita el ataque de confusión de algoritmos
      // (por ejemplo, un token HS256 firmado con la clave pública como secreto).
      throw new InvalidTokenError("El token no está firmado con RS256.");
    }
    const kid = typeof header.kid === "string" ? header.kid : "";
    if (!kid) {
      throw new InvalidTokenError("El token no indica la clave con la que fue firmado (kid).");
    }

    const key = await this.getKey(kid);
    const signedData = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], "base64url");
    let signatureIsValid = false;
    try {
      signatureIsValid = crypto.verify("RSA-SHA256", signedData, key, signature);
    } catch {
      signatureIsValid = false;
    }
    if (!signatureIsValid) {
      throw new InvalidTokenError("La firma del token no es válida.");
    }

    const claims = decodeJsonSegment(parts[1]) as JwtClaims;
    this.validateClaims(claims);
    return claims;
  }

  private isCacheFresh(): boolean {
    return this.keys.size > 0 && Date.now() - this.fetchedAt < this.config.cacheTtlMs;
  }

  private async getKey(kid: string): Promise<crypto.KeyObject> {
    if (!this.isCacheFresh()) {
      await this.refresh();
    }

    const cached = this.keys.get(kid);
    if (cached) return cached;

    // `kid` desconocido: puede ser una rotación de claves de M1. Se reintenta una vez.
    if (Date.now() - this.fetchedAt >= this.minForcedRefreshMs) {
      await this.refresh();
      const rotated = this.keys.get(kid);
      if (rotated) return rotated;
    }

    throw new InvalidTokenError("M1 no publica la clave con la que se firmó el token.");
  }

  private async refresh(): Promise<void> {
    // Varias peticiones concurrentes comparten una sola descarga del JWKS.
    if (!this.inFlight) {
      this.inFlight = this.downloadKeys().finally(() => {
        this.inFlight = null;
      });
    }
    await this.inFlight;
  }

  private async downloadKeys(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await this.fetchImpl(this.config.jwksUri, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new JwksUnavailableError(`El JWKS de M1 respondió HTTP ${response.status}.`);
      }

      const body = (await response.json()) as JwkSet;
      const next = new Map<string, crypto.KeyObject>();
      for (const jwk of body.keys ?? []) {
        if (jwk.kty !== "RSA" || !jwk.kid) continue;
        if (jwk.use && jwk.use !== "sig") continue;
        try {
          next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" }));
        } catch {
          // Una clave mal formada no invalida el resto del set.
        }
      }

      if (next.size === 0) {
        throw new JwksUnavailableError("El JWKS de M1 no tiene claves RSA utilizables.");
      }

      this.keys = next;
      this.fetchedAt = Date.now();
    } catch (err) {
      if (err instanceof JwksUnavailableError) throw err;
      const reason = err instanceof Error ? err.message : "error desconocido";
      throw new JwksUnavailableError(`No se pudo obtener el JWKS de M1: ${reason}.`);
    } finally {
      clearTimeout(timer);
    }
  }

  private validateClaims(claims: JwtClaims): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const tolerance = this.config.clockToleranceSec;

    if (claims.iss !== this.config.issuer) {
      throw new InvalidTokenError("El emisor (iss) del token no es M1.");
    }

    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
      throw new InvalidTokenError("El token no tiene vencimiento (exp).");
    }
    if (claims.exp + tolerance < nowSec) {
      throw new InvalidTokenError("El token está vencido.");
    }

    if (claims.nbf !== undefined) {
      if (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf)) {
        throw new InvalidTokenError("El claim nbf no es un número.");
      }
      if (claims.nbf - tolerance > nowSec) {
        throw new InvalidTokenError("El token todavía no es válido (nbf).");
      }
    }

    if (claims.iat !== undefined) {
      if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) {
        throw new InvalidTokenError("El claim iat no es un número.");
      }
      if (claims.iat - tolerance > nowSec) {
        throw new InvalidTokenError("El token fue emitido en el futuro (iat).");
      }
    }

    if (this.config.audience) {
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audiences.includes(this.config.audience)) {
        throw new InvalidTokenError("La audiencia (aud) del token no es la esperada.");
      }
    }
  }
}
