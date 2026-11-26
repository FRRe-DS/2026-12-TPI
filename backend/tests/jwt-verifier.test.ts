import { describe, it, expect, vi, afterEach } from "vitest";
import {
  InvalidTokenError,
  JwksUnavailableError,
  JwtVerifier,
} from "../src/services/jwt-verifier.service.js";
import type { AuthConfig } from "../src/config/auth.js";
import { createTestKeyPair, jwksFetch, signJwt } from "./helpers/jwt-fixture.js";

const ISSUER = "http://localhost:8080/realms/ds-2026-realm";
const nowSec = () => Math.floor(Date.now() / 1000);

const config: AuthConfig = {
  issuer: ISSUER,
  jwksUri: "http://m1.test/protocol/openid-connect/certs",
  timeoutMs: 1000,
  cacheTtlMs: 60_000,
  clockToleranceSec: 0,
  refreshCooldownMs: 5000,
};

const keyPair = createTestKeyPair();

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: "u-1",
    exp: nowSec() + 300,
    iat: nowSec(),
    ...overrides,
  };
}

function token(overrides: Record<string, unknown> = {}): string {
  return signJwt(claims(overrides), keyPair.privateKey, keyPair.kid);
}

describe("JwtVerifier", () => {
  it("acepta un token firmado por M1 y devuelve los claims", async () => {
    const fake = jwksFetch(keyPair.jwks);
    const verifier = new JwtVerifier(config, fake.fetchImpl);

    await expect(verifier.verify(token())).resolves.toMatchObject({ iss: ISSUER, sub: "u-1" });
  });

  it("reutiliza el JWKS cacheado entre peticiones", async () => {
    const fake = jwksFetch(keyPair.jwks);
    const verifier = new JwtVerifier(config, fake.fetchImpl);

    await verifier.verify(token());
    await verifier.verify(token());

    expect(fake.calls()).toBe(1);
  });

  it("refresca el JWKS cuando aparece un kid nuevo (rotación de claves)", async () => {
    const rotated = createTestKeyPair("rotated-key");
    const jwkSets = [keyPair.jwks, rotated.jwks];
    let calls = 0;
    const fetchImpl = async () => {
      const body = jwkSets[Math.min(calls, jwkSets.length - 1)];
      calls += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const verifier = new JwtVerifier(config, fetchImpl, 0);

    // Primer token: cachea la clave original.
    await verifier.verify(token());
    // Segundo token: firmado con una clave que todavía no estaba publicada.
    const rotatedToken = signJwt(claims(), rotated.privateKey, rotated.kid);

    await expect(verifier.verify(rotatedToken)).resolves.toMatchObject({ sub: "u-1" });
    expect(calls).toBe(2);
  });

  it("rechaza un token cuyo payload fue alterado", async () => {
    const verifier = new JwtVerifier(config, jwksFetch(keyPair.jwks).fetchImpl);
    const [header, , signature] = token().split(".");
    const tampered = Buffer.from(JSON.stringify(claims({ sub: "otro" }))).toString("base64url");

    await expect(verifier.verify(`${header}.${tampered}.${signature}`)).rejects.toBeInstanceOf(
      InvalidTokenError
    );
  });

  it("rechaza algoritmos distintos de RS256", async () => {
    const verifier = new JwtVerifier(config, jwksFetch(keyPair.jwks).fetchImpl);
    const hs256 = signJwt(claims(), keyPair.privateKey, keyPair.kid, { alg: "HS256" });

    await expect(verifier.verify(hs256)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rechaza un token vencido", async () => {
    const verifier = new JwtVerifier(config, jwksFetch(keyPair.jwks).fetchImpl);

    await expect(verifier.verify(token({ exp: nowSec() - 1 }))).rejects.toThrow(/vencido/);
  });

  it("rechaza un token sin exp", async () => {
    const verifier = new JwtVerifier(config, jwksFetch(keyPair.jwks).fetchImpl);
    const withoutExp = signJwt({ iss: ISSUER, sub: "u-1" }, keyPair.privateKey, keyPair.kid);

    await expect(verifier.verify(withoutExp)).rejects.toThrow(/exp/);
  });

  it("rechaza un token emitido para otro emisor", async () => {
    const verifier = new JwtVerifier(config, jwksFetch(keyPair.jwks).fetchImpl);

    await expect(verifier.verify(token({ iss: "http://otro.example/realms/x" }))).rejects.toThrow(
      /emisor/
    );
  });

  it("valida la audiencia solo si está configurada", async () => {
    const withAudience: AuthConfig = { ...config, audience: "m6-trips" };
    const verifier = new JwtVerifier(withAudience, jwksFetch(keyPair.jwks).fetchImpl);

    await expect(verifier.verify(token({ aud: "otra" }))).rejects.toThrow(/audiencia/);
    await expect(verifier.verify(token({ aud: ["m6-trips", "account"] }))).resolves.toMatchObject({
      sub: "u-1",
    });
  });

  it("rechaza un token que todavía no es válido (nbf)", async () => {
    const verifier = new JwtVerifier(config, jwksFetch(keyPair.jwks).fetchImpl);

    await expect(verifier.verify(token({ nbf: nowSec() + 120 }))).rejects.toThrow(/nbf/);
  });

  it("informa JWKS no disponible cuando M1 responde con error", async () => {
    const verifier = new JwtVerifier(config, jwksFetch({}, 500).fetchImpl);

    await expect(verifier.verify(token())).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  it("informa JWKS no disponible cuando la respuesta no tiene claves utilizables", async () => {
    const verifier = new JwtVerifier(config, jwksFetch({ keys: [] }).fetchImpl);

    await expect(verifier.verify(token())).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  it("rechaza un token con formato inválido", async () => {
    const verifier = new JwtVerifier(config, jwksFetch(keyPair.jwks).fetchImpl);

    await expect(verifier.verify("no-es-un-jwt")).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("si el JWKS no se puede refrescar, sigue usando las claves cacheadas (RNF-13)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify(keyPair.jwks), { status: 200 });
      }
      throw new Error("ECONNREFUSED");
    };
    const verifier = new JwtVerifier({ ...config, cacheTtlMs: 1 }, fetchImpl);

    await expect(verifier.verify(token())).resolves.toMatchObject({ sub: "u-1" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(verifier.verify(token())).resolves.toMatchObject({ sub: "u-1" });

    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("si el kid no está en la caché y el refresco falla, informa JWKS no disponible", async () => {
    const rotated = createTestKeyPair("rotated-key");
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify(keyPair.jwks), { status: 200 });
      }
      throw new Error("ECONNREFUSED");
    };
    const verifier = new JwtVerifier({ ...config, cacheTtlMs: 1 }, fetchImpl, 0);

    await verifier.verify(token());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const rotatedToken = signJwt(claims(), rotated.privateKey, rotated.kid);

    await expect(verifier.verify(rotatedToken)).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  it("un kid desconocido durante el cooldown es 503, no 401", async () => {
    const stopped = createTestKeyPair("stopped-key");
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify(keyPair.jwks), { status: 200 });
      }
      throw new Error("ECONNREFUSED");
    };
    const verifier = new JwtVerifier(
      { ...config, cacheTtlMs: 60_000, refreshCooldownMs: 60_000 },
      fetchImpl,
      0
    );

    // Cachea la clave original (la caché queda vigente).
    await verifier.verify(token());
    const stoppedToken = signJwt(claims(), stopped.privateKey, stopped.kid);

    // Primero intenta refrescar y falla: el problema es la dependencia, no el token.
    await expect(verifier.verify(stoppedToken)).rejects.toBeInstanceOf(JwksUnavailableError);

    // Dentro del cooldown no se reintenta la descarga y sigue siendo 503.
    await expect(verifier.verify(stoppedToken)).rejects.toBeInstanceOf(JwksUnavailableError);

    expect(calls).toBe(2);
  });

  it("después de un fallo de refresco no reintenta en cada pedido (cooldown)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify(keyPair.jwks), { status: 200 });
      }
      // Simula un Keycloak colgado: el pedido no responde y vence el timeout.
      throw new Error("timeout");
    };
    const verifier = new JwtVerifier(
      { ...config, cacheTtlMs: 1, refreshCooldownMs: 60_000 },
      fetchImpl
    );

    await expect(verifier.verify(token())).resolves.toMatchObject({ sub: "u-1" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Primer pedido con la caché vencida: intenta refrescar, falla y usa las viejas.
    await expect(verifier.verify(token())).resolves.toMatchObject({ sub: "u-1" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Siguiente pedido dentro del cooldown: no vuelve a intentar la descarga.
    await expect(verifier.verify(token())).resolves.toMatchObject({ sub: "u-1" });

    expect(calls).toBe(2);
    warn.mockRestore();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
