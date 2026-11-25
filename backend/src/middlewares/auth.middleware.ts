import http from "node:http";
import type { ActorRole } from "../../generated/prisma/client.js";
import { ApiError } from "./error.middleware.js";
import { loadAuthConfig } from "../config/auth.js";
import {
  InvalidTokenError,
  JwksUnavailableError,
  JwtVerifier,
  type JwtClaims,
} from "../services/jwt-verifier.service.js";

export interface AuthContext {
  sub: string;
  role: ActorRole;
}

/**
 * Roles que puede traer el token. Los `CLIENTE`/`CONDUCTOR`/`OPERADOR` son los
 * acordados con M1; los ingleses se aceptan por compatibilidad con tokens viejos.
 */
/** Roles de usuario: si el token los trae, tienen prioridad sobre los de servicio. */
const USER_ROLE_ALIASES: Record<string, ActorRole> = {
  CLIENT: "CLIENT",
  CLIENTE: "CLIENT",
  DRIVER: "DRIVER",
  CONDUCTOR: "DRIVER",
  OPERATOR: "OPERATOR",
  OPERADOR: "OPERATOR",
};

/** Alias de cuenta de servicio (llamadas entre módulos). */
const SERVICE_ROLE_ALIASES = new Set(["SYSTEM", "SERVICIO", "SERVICE"]);

function aliasToRole(rawRole: string): ActorRole | undefined {
  const key = rawRole.toUpperCase();
  return USER_ROLE_ALIASES[key] ?? (SERVICE_ROLE_ALIASES.has(key) ? "SYSTEM" : undefined);
}

/** Firma que usa el panel de demo; solo se acepta con `ENABLE_DEMO_AUTH=true`. */
const DEMO_SIGNATURE = Buffer.from("m6-demo-signature").toString("base64url");

/** Verificador único del proceso: reutiliza el JWKS cacheado entre peticiones. */
export const jwtVerifier = new JwtVerifier(loadAuthConfig());

/**
 * Atajos de demo: header `X-Actor-Role` / `X-Actor-Id` sin token y tokens rápidos
 * (`Bearer SYSTEM`, `Bearer DRIVER:<id>`). Solo se habilitan con ENABLE_DEMO_AUTH=true.
 */
export function isDemoAuthEnabled(): boolean {
  return process.env.ENABLE_DEMO_AUTH === "true";
}

/**
 * Genera un token JWT de demostración con claims `sub`, `role` y `roles` (M1) para pruebas en Swagger UI / Postman.
 * Lleva una firma simbólica: solo se acepta con `ENABLE_DEMO_AUTH=true`.
 */
export function createDemoJwt(sub: string, role: ActorRole): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const spanishRole =
    role === "SYSTEM"
      ? "SERVICIO"
      : role === "CLIENT"
      ? "CLIENTE"
      : role === "DRIVER"
      ? "CONDUCTOR"
      : "OPERADOR";
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      role,
      roles: [role, spanishRole],
      aud: "m6-trips",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
    })
  ).toString("base64url");
  return `${header}.${payload}.${DEMO_SIGNATURE}`;
}

function isDemoJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts[2] === DEMO_SIGNATURE;
}

/** Junta los roles que puede traer el token según el emisor. */
function collectRawRoles(claims: JwtClaims): string[] {
  const roles: unknown[] = [];
  if (Array.isArray(claims.roles)) roles.push(...claims.roles);
  if (typeof claims.role === "string") roles.push(claims.role);
  if (Array.isArray(claims.realm_access?.roles)) roles.push(...claims.realm_access.roles);

  return roles
    .filter((role): role is string => typeof role === "string" && role.trim() !== "")
    .map((role) => role.trim());
}

/**
 * Traduce los roles del token a los roles internos de M6.
 *
 * Keycloak emite un rol por módulo (`solicitud-be`, `viajes-be`, ...) para las
 * cuentas de servicio; cualquiera de esos se trata como `SYSTEM`. Si además hay
 * un rol de usuario (`CLIENTE`, `CONDUCTOR`, `OPERADOR`), ese tiene prioridad.
 */
export function mapClaimsToActor(claims: JwtClaims): AuthContext {
  const rawRoles = collectRawRoles(claims);

  let role: ActorRole | null = null;

  // 1) Rol de usuario: tiene prioridad sobre el de servicio.
  for (const raw of rawRoles) {
    const mapped = USER_ROLE_ALIASES[raw.toUpperCase()];
    if (mapped) {
      role = mapped;
      break;
    }
  }

  // 2) Alias explícito de servicio (SERVICIO / SYSTEM / SERVICE).
  if (!role) {
    for (const raw of rawRoles) {
      if (SERVICE_ROLE_ALIASES.has(raw.toUpperCase())) {
        role = "SYSTEM";
        break;
      }
    }
  }

  // 3) Rol de módulo emitido por Keycloak (`solicitud-be`, `viajes-be`, ...).
  if (!role) {
    for (const raw of rawRoles) {
      if (raw.toLowerCase().endsWith("-be")) {
        role = "SYSTEM";
        break;
      }
    }
  }

  if (!role) {
    throw new ApiError(
      401,
      "UNAUTHENTICATED",
      "El token JWT no contiene un rol reconocido (CLIENTE, CONDUCTOR, OPERADOR o SERVICIO)."
    );
  }

  // En los tokens de servicio el módulo viaja en `azp` (Keycloak) y no en `sub`,
  // que es el UUID del service account. Para los usuarios, `sub` es la persona.
  const clientId =
    typeof claims.azp === "string"
      ? claims.azp
      : typeof claims.client_id === "string"
      ? claims.client_id
      : undefined;
  const sub = role === "SYSTEM" ? clientId ?? claims.sub : claims.sub;

  if (typeof sub !== "string" || sub.trim() === "") {
    throw new ApiError(401, "UNAUTHENTICATED", "El token JWT no identifica al usuario o servicio.");
  }

  return { sub, role };
}

/**
 * Middleware de autenticación: valida el JWT de M1 (firma, emisor y vencimiento)
 * y devuelve el actor con su rol interno (RNF-12).
 *
 * Es asíncrono porque la primera vez baja el JWKS de M1; después usa la copia en
 * memoria. Si M1 no responde se devuelve `503 DEPENDENCY_UNAVAILABLE` (RNF-13),
 * nunca un `401` que haría pensar al cliente que su token es inválido.
 */
export async function authenticateMiddleware(
  req: http.IncomingMessage,
  verifier: JwtVerifier = jwtVerifier
): Promise<AuthContext> {
  const demo = isDemoAuthEnabled();
  // Node puede entregar un header repetido como array: se acepta solo el caso simple.
  const rawAuthHeader = req.headers["authorization"];
  const authHeader = typeof rawAuthHeader === "string" ? rawAuthHeader : undefined;
  const rawFallbackRole = req.headers["x-actor-role"];
  const fallbackRole = typeof rawFallbackRole === "string" ? rawFallbackRole : undefined;
  const rawFallbackSub = req.headers["x-actor-id"];
  const fallbackSub = typeof rawFallbackSub === "string" ? rawFallbackSub : undefined;

  // Atajo de demo 1: rol por header, sin token.
  if (demo && !authHeader && fallbackRole) {
    const mapped = aliasToRole(fallbackRole);
    if (mapped) {
      return {
        sub: fallbackSub || "00000000-0000-4000-8000-000000000000",
        role: mapped,
      };
    }
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new ApiError(
      401,
      "UNAUTHENTICATED",
      "Token JWT ausente o formato inválido. Se requiere header Authorization: Bearer <token> (M1)."
    );
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    throw new ApiError(401, "UNAUTHENTICATED", "Token JWT vacío.");
  }

  // Atajos de demo 2: tokens rápidos ("SYSTEM", "SERVICIO", "DRIVER:<uuid>", etc.).
  if (demo) {
    const directRole = aliasToRole(token);
    if (directRole) {
      return {
        sub: fallbackSub || "00000000-0000-4000-8000-000000000000",
        role: directRole,
      };
    }
    if (token.includes(":")) {
      const [r, id] = token.split(":");
      const mapped = r ? aliasToRole(r) : undefined;
      if (mapped && id) {
        return { sub: id.trim(), role: mapped };
      }
    }
  }

  // Atajo de demo 3: JWT del panel (firma simbólica), solo en desarrollo.
  if (demo && isDemoJwt(token)) {
    const [, payloadSegment] = token.split(".");
    let claims: JwtClaims;
    try {
      claims = JSON.parse(Buffer.from(payloadSegment!, "base64url").toString("utf-8")) as JwtClaims;
    } catch {
      throw new ApiError(401, "UNAUTHENTICATED", "No se pudo leer el token de demostración.");
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp < nowSec) {
      throw new ApiError(
        401,
        "UNAUTHENTICATED",
        "El token de demostración no tiene vencimiento válido o está vencido."
      );
    }

    return mapClaimsToActor(claims);
  }

  try {
    const claims = await verifier.verify(token);
    return mapClaimsToActor(claims);
  } catch (err) {
    if (err instanceof JwksUnavailableError) {
      throw new ApiError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "No se pudo validar el token: el servicio de identidad (M1) no está disponible.",
        { headers: { "Retry-After": "5" } }
      );
    }
    if (err instanceof InvalidTokenError) {
      throw new ApiError(401, "UNAUTHENTICATED", err.message);
    }
    throw err;
  }
}
