import { describe, it, expect, afterEach } from "vitest";
import {
  authenticateMiddleware,
  createDemoJwt,
  mapClaimsToActor,
} from "../src/middlewares/auth.middleware.js";
import { JwtVerifier } from "../src/services/jwt-verifier.service.js";
import type { AuthConfig } from "../src/config/auth.js";
import { createTestKeyPair, jwksFetch, signJwt } from "./helpers/jwt-fixture.js";

const req = (headers: Record<string, string>) => ({ headers }) as any;
const nowSec = () => Math.floor(Date.now() / 1000);
const DRIVER_ID = "d1111111-1111-4111-8111-111111111111";
const CLIENT_ID = "c1111111-1111-4111-8111-111111111111";
const ISSUER = "http://localhost:8080/realms/ds-2026-realm";

const keyPair = createTestKeyPair();

const config: AuthConfig = {
  issuer: ISSUER,
  jwksUri: "http://m1.test/protocol/openid-connect/certs",
  timeoutMs: 1000,
  cacheTtlMs: 60_000,
  clockToleranceSec: 0,
  refreshCooldownMs: 5000,
};

function buildVerifier(jwks: unknown = keyPair.jwks, status = 200): JwtVerifier {
  return new JwtVerifier(config, jwksFetch(jwks, status).fetchImpl);
}

function serviceToken(overrides: Record<string, unknown> = {}): string {
  return signJwt(
    {
      iss: ISSUER,
      sub: "ac7d8284-f9dc-4cc6-8bb0-b680c9451733",
      azp: "grupo-05",
      roles: ["solicitud-be"],
      exp: nowSec() + 300,
      ...overrides,
    },
    keyPair.privateKey,
    keyPair.kid
  );
}

afterEach(() => {
  delete process.env.ENABLE_DEMO_AUTH;
});

describe("Autenticación: atajos de demo", () => {
  it("sin ENABLE_DEMO_AUTH el token 'SYSTEM' es 401", async () => {
    await expect(
      authenticateMiddleware(req({ authorization: "Bearer SYSTEM" }), buildVerifier())
    ).rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
  });

  it("sin ENABLE_DEMO_AUTH el header x-actor-role es 401", async () => {
    await expect(
      authenticateMiddleware(req({ "x-actor-role": "SYSTEM" }), buildVerifier())
    ).rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
  });

  it("con ENABLE_DEMO_AUTH=true funcionan los atajos", async () => {
    process.env.ENABLE_DEMO_AUTH = "true";

    await expect(
      authenticateMiddleware(req({ authorization: "Bearer SYSTEM" }), buildVerifier())
    ).resolves.toMatchObject({ role: "SYSTEM" });

    await expect(
      authenticateMiddleware(req({ authorization: `Bearer DRIVER:${DRIVER_ID}` }), buildVerifier())
    ).resolves.toEqual({ sub: DRIVER_ID, role: "DRIVER" });

    await expect(
      authenticateMiddleware(req({ "x-actor-role": "CLIENT", "x-actor-id": "c-1" }), buildVerifier())
    ).resolves.toEqual({ sub: "c-1", role: "CLIENT" });
  });

  it("el JWT del panel se acepta solo con ENABLE_DEMO_AUTH=true", async () => {
    const demoJwt = createDemoJwt(DRIVER_ID, "DRIVER");

    await expect(
      authenticateMiddleware(req({ authorization: `Bearer ${demoJwt}` }), buildVerifier())
    ).rejects.toMatchObject({ statusCode: 401 });

    process.env.ENABLE_DEMO_AUTH = "true";
    await expect(
      authenticateMiddleware(req({ authorization: `Bearer ${demoJwt}` }), buildVerifier())
    ).resolves.toEqual({ sub: DRIVER_ID, role: "DRIVER" });
  });

  it("con la demo activada, un JWT del panel vencido sigue siendo 401", async () => {
    process.env.ENABLE_DEMO_AUTH = "true";
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const demoSignature = Buffer.from("m6-demo-signature").toString("base64url");
    const expired = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
      sub: DRIVER_ID,
      roles: ["DRIVER"],
      exp: nowSec() - 10,
    })}.${demoSignature}`;

    await expect(
      authenticateMiddleware(req({ authorization: `Bearer ${expired}` }), buildVerifier())
    ).rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
  });
});

describe("Autenticación: token real de Keycloak", () => {
  it("acepta un token de servicio y usa azp como identidad", async () => {
    await expect(
      authenticateMiddleware(req({ authorization: `Bearer ${serviceToken()}` }), buildVerifier())
    ).resolves.toEqual({ sub: "grupo-05", role: "SYSTEM" });
  });

  it("acepta un token de cliente y usa sub como identidad", async () => {
    const token = signJwt(
      { iss: ISSUER, sub: CLIENT_ID, roles: ["CLIENTE"], exp: nowSec() + 300 },
      keyPair.privateKey,
      keyPair.kid
    );

    await expect(
      authenticateMiddleware(req({ authorization: `Bearer ${token}` }), buildVerifier())
    ).resolves.toEqual({ sub: CLIENT_ID, role: "CLIENT" });
  });

  it("si el token trae un rol de usuario y uno de módulo, gana el de usuario", async () => {
    const token = signJwt(
      { iss: ISSUER, sub: CLIENT_ID, roles: ["CLIENTE", "viajes-be"], exp: nowSec() + 300 },
      keyPair.privateKey,
      keyPair.kid
    );

    await expect(
      authenticateMiddleware(req({ authorization: `Bearer ${token}` }), buildVerifier())
    ).resolves.toEqual({ sub: CLIENT_ID, role: "CLIENT" });
  });

  it("rechaza un token vencido con 401", async () => {
    await expect(
      authenticateMiddleware(
        req({ authorization: `Bearer ${serviceToken({ exp: nowSec() - 10 })}` }),
        buildVerifier()
      )
    ).rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
  });

  it("rechaza un token firmado con otra clave con 401", async () => {
    const otherKey = createTestKeyPair(keyPair.kid);
    const forged = signJwt(
      { iss: ISSUER, sub: CLIENT_ID, roles: ["CLIENTE"], exp: nowSec() + 300 },
      otherKey.privateKey,
      otherKey.kid
    );

    await expect(
      authenticateMiddleware(req({ authorization: `Bearer ${forged}` }), buildVerifier())
    ).rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
  });

  it("rechaza un token de otro emisor con 401", async () => {
    await expect(
      authenticateMiddleware(
        req({ authorization: `Bearer ${serviceToken({ iss: "http://otro.example/realms/x" })}` }),
        buildVerifier()
      )
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rechaza un token sin rol reconocido con 401", async () => {
    await expect(
      authenticateMiddleware(
        req({ authorization: `Bearer ${serviceToken({ roles: ["default-roles-ds-2026-realm"] })}` }),
        buildVerifier()
      )
    ).rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
  });

  it("si M1 no responde devuelve 503 con Retry-After, no 401", async () => {
    const error = await authenticateMiddleware(
      req({ authorization: `Bearer ${serviceToken()}` }),
      buildVerifier({}, 500)
    ).catch((e) => e);

    expect(error).toMatchObject({ statusCode: 503, code: "DEPENDENCY_UNAVAILABLE" });
    expect(error.options.headers).toMatchObject({ "Retry-After": "5" });
  });
});

describe("Traducción de roles de Keycloak", () => {
  it.each([
    ["solicitud-be", "SYSTEM"],
    ["clientes-be", "SYSTEM"],
    ["viajes-be", "SYSTEM"],
    ["CLIENTE", "CLIENT"],
    ["CONDUCTOR", "DRIVER"],
    ["OPERADOR", "OPERATOR"],
    ["SERVICIO", "SYSTEM"],
  ])("mapea %s a %s", (rawRole, expected) => {
    expect(
      mapClaimsToActor({ sub: "x", roles: [rawRole], exp: nowSec() + 60 })
    ).toMatchObject({ role: expected });
  });

  it("prioriza el rol de usuario sobre el de servicio, sin importar el orden", () => {
    expect(
      mapClaimsToActor({ sub: "x", roles: ["SERVICIO", "CONDUCTOR"], exp: nowSec() + 60 })
    ).toMatchObject({ role: "DRIVER" });

    expect(
      mapClaimsToActor({ sub: "x", roles: ["CONDUCTOR", "SERVICIO"], exp: nowSec() + 60 })
    ).toMatchObject({ role: "DRIVER" });
  });
});
