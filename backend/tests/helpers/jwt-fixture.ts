import crypto from "node:crypto";

/**
 * Utilidades de test: generan un par de claves RSA real y firman tokens igual
 * que Keycloak, para probar la verificación sin depender de M1 levantado.
 */
export interface TestKeyPair {
  kid: string;
  privateKey: crypto.KeyObject;
  jwks: { keys: Array<Record<string, unknown>> };
}

export function createTestKeyPair(kid = "test-key"): TestKeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return {
    kid,
    privateKey,
    jwks: { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] },
  };
}

export function signJwt(
  claims: Record<string, unknown>,
  privateKey: crypto.KeyObject,
  kid: string,
  headerOverrides: Record<string, unknown> = {}
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid, ...headerOverrides })
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey)
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export interface FakeJwks {
  fetchImpl: () => Promise<Response>;
  calls: () => number;
}

/** Devuelve un `fetch` falso que responde el JWKS indicado y cuenta las llamadas. */
export function jwksFetch(jwks: unknown, status = 200): FakeJwks {
  let calls = 0;
  return {
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(jwks), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
    calls: () => calls,
  };
}
