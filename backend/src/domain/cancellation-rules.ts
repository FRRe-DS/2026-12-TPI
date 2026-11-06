/**
 * Reglas de negocio de la cancelación (RF-6.6 / RF-6.7).
 * Lógica pura, sin base de datos ni HTTP, para poder probarla con tests unitarios.
 */

export const CANCELLATION_REASONS = [
  "CHANGE_OF_PLANS",
  "EXCESSIVE_DELAY",
  "DRIVER_NO_SHOW",
  "CLIENT_NO_SHOW",
  "VEHICLE_PROBLEM",
  "ORIGIN_UNREACHABLE",
  "SECURITY_INCIDENT",
  "ADMINISTRATIVE_BLOCK",
  "OTHER",
] as const;

export type CancellationReasonValue = (typeof CANCELLATION_REASONS)[number];
export type CancellationRoleValue = "CLIENT" | "DRIVER" | "OPERATOR";

/** Motivos que puede usar cada rol (tabla de openapi.yaml, `POST /trips/{tripId}/cancel`). */
export const ALLOWED_REASONS: Record<CancellationRoleValue, readonly CancellationReasonValue[]> = {
  CLIENT: ["CHANGE_OF_PLANS", "EXCESSIVE_DELAY", "DRIVER_NO_SHOW", "OTHER"],
  DRIVER: ["CLIENT_NO_SHOW", "VEHICLE_PROBLEM", "ORIGIN_UNREACHABLE", "OTHER"],
  OPERATOR: ["SECURITY_INCIDENT", "ADMINISTRATIVE_BLOCK", "OTHER"],
};

export function isCancellationReason(value: unknown): value is CancellationReasonValue {
  return typeof value === "string" && (CANCELLATION_REASONS as readonly string[]).includes(value);
}

/**
 * ¿M5 debe buscar otro conductor? Solo si cancela el conductor, salvo que el cliente no se presentó.
 * Con OPERATOR siempre es false: si hace falta re-despachar, lo pide el operador explícitamente.
 */
export function requiresRedispatch(role: CancellationRoleValue, reason: CancellationReasonValue): boolean {
  return role === "DRIVER" && reason !== "CLIENT_NO_SHOW";
}

/**
 * Valida que el motivo corresponda al rol y, para CLIENT_NO_SHOW, que hayan pasado
 * `noShowMinutes` desde el arribo. Devuelve `null` si es válido o el texto del problema.
 */
export function checkCancellationReason(
  role: CancellationRoleValue,
  reason: CancellationReasonValue,
  arrivedAt: Date | null,
  now: Date,
  noShowMinutes: number
): string | null {
  if (!ALLOWED_REASONS[role].includes(reason)) {
    return `El motivo ${reason} no corresponde al rol ${role}. Motivos permitidos: ${ALLOWED_REASONS[role].join(", ")}.`;
  }

  if (reason === "CLIENT_NO_SHOW") {
    if (arrivedAt === null) {
      return "CLIENT_NO_SHOW solo se acepta después del arribo del conductor.";
    }
    const elapsedMs = now.getTime() - arrivedAt.getTime();
    if (elapsedMs < noShowMinutes * 60_000) {
      return `CLIENT_NO_SHOW solo se acepta desde ${noShowMinutes} minutos después del arribo del conductor.`;
    }
  }

  return null;
}