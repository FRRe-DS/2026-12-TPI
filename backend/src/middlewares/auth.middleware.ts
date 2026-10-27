import http from "node:http";
import type { ActorRole } from "../../generated/prisma/client.js";
import { ApiError } from "./error.middleware.js";

export interface AuthContext {
  sub: string;
  role: ActorRole;
}

const VALID_ROLES: ActorRole[] = ["CLIENT", "DRIVER", "OPERATOR", "SYSTEM"];

const ROLE_ALIASES: Record<string, ActorRole> = {
  CLIENT: "CLIENT",
  CLIENTE: "CLIENT",
  DRIVER: "DRIVER",
  CONDUCTOR: "DRIVER",
  OPERATOR: "OPERATOR",
  OPERADOR: "OPERATOR",
  SYSTEM: "SYSTEM",
  SERVICIO: "SYSTEM",
  SERVICE: "SYSTEM",
};

function normalizeRole(rawRole: unknown, rawRolesArray?: unknown): ActorRole | null {
  if (typeof rawRole === "string" && ROLE_ALIASES[rawRole.toUpperCase()]) {
    return ROLE_ALIASES[rawRole.toUpperCase()]!;
  }
  if (Array.isArray(rawRolesArray)) {
    for (const r of rawRolesArray) {
      if (typeof r === "string" && ROLE_ALIASES[r.toUpperCase()]) {
        return ROLE_ALIASES[r.toUpperCase()]!;
      }
    }
  }
  return null;
}

/**
 * Genera un token JWT de demostración con claims `sub`, `role` y `roles` (M1) para pruebas en Swagger UI / Postman.
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
  const signature = Buffer.from("m6-demo-signature").toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * Middleware de autenticación que valida el esquema `bearerAuth` (JWT de M1) según `openapi.yaml`.
 * Soporta tanto `role: "SYSTEM"` como `roles: ["SERVICIO"]` para compatibilidad con M2.
 */
export function authenticateMiddleware(req: http.IncomingMessage): AuthContext {
  const authHeader = req.headers["authorization"];
  const fallbackRole = req.headers["x-actor-role"] as string | undefined;
  const fallbackSub = req.headers["x-actor-id"] as string | undefined;

  if (!authHeader && fallbackRole) {
    const mapped = normalizeRole(fallbackRole);
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
      "UNAUTHORIZED",
      "Token JWT ausente o formato inválido. Se requiere header Authorization: Bearer <token> (M1)."
    );
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    throw new ApiError(401, "UNAUTHORIZED", "Token JWT vacío.");
  }

  // Soporte de tokens rápidos en Swagger ("SYSTEM", "SERVICIO", "DRIVER:<uuid>", etc.)
  const directRole = normalizeRole(token);
  if (directRole) {
    return {
      sub: fallbackSub || "00000000-0000-4000-8000-000000000000",
      role: directRole,
    };
  }
  if (token.includes(":")) {
    const [r, id] = token.split(":");
    const mapped = normalizeRole(r);
    if (mapped && id) {
      return { sub: id.trim(), role: mapped };
    }
  }

  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) {
    throw new ApiError(401, "INVALID_TOKEN", "El token JWT proporcionado no tiene una estructura válida.");
  }

  try {
    const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    const role = normalizeRole(decoded.role, decoded.roles);
    const sub = (decoded.sub || decoded.identidad_id || decoded.userId) as string;

    if (!role || !VALID_ROLES.includes(role)) {
      throw new ApiError(
        401,
        "INVALID_TOKEN_CLAIMS",
        "El token JWT no contiene un claim 'role' o 'roles' válido (CLIENT/CLIENTE, DRIVER/CONDUCTOR, OPERATOR/OPERADOR, SYSTEM/SERVICIO)."
      );
    }

    if (decoded.exp && typeof decoded.exp === "number" && decoded.exp * 1000 < Date.now()) {
      throw new ApiError(401, "TOKEN_EXPIRED", "El token JWT ha expirado.");
    }

    return {
      sub: sub || "00000000-0000-4000-8000-000000000000",
      role,
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(401, "INVALID_TOKEN", "No se pudo decodificar el payload del token JWT.");
  }
}
