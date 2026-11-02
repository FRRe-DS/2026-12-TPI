import { ApiError } from "./error.middleware.js";

/** Lee el header If-Match. Devuelve la versión pedida, o undefined si no vino o es `*`. */
export function parseIfMatch(raw: string | string[] | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = (Array.isArray(raw) ? raw[0] ?? "" : raw).trim();
  if (value === "*") return undefined;

  const match = /^"(\d+)"$/.exec(value);
  if (!match) {
    throw new ApiError(
      400,
      "VALIDATION",
      'El header If-Match debe ser un ETag entre comillas, por ejemplo "3".',
      { errors: [{ field: "If-Match", message: 'debe tener la forma "<versión>"' }] }
    );
  }
  return Number(match[1]);
}

/** Si vino If-Match y no coincide con la versión actual del viaje, responde 412. */
export function assertIfMatch(currentVersion: number, requested: number | undefined): void {
  if (requested !== undefined && requested !== currentVersion) {
    throw new ApiError(
      412,
      "PRECONDITION_FAILED",
      `El viaje está en la versión ${currentVersion}, pero If-Match pedía la ${requested}.`,
      { headers: { ETag: `"${currentVersion}"` } }
    );
  }
}