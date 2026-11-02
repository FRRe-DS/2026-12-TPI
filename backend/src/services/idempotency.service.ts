import crypto from "node:crypto";
import { ApiError } from "../middlewares/error.middleware.js";
import type { IdempotencyStore, StoredResponse } from "../repositories/idempotency.repository.js";

/** Cuánto se recuerda una clave (contrato: 24 horas). */
const TTL_MS = 24 * 60 * 60 * 1000;
/** Un pedido "en proceso" más viejo que esto se considera colgado y la clave se puede reservar de nuevo. */
const IN_PROGRESS_TIMEOUT_MS = 60_000;
/** Cada cuánto se borran de la tabla las claves vencidas. */
const CLEANUP_EVERY_MS = 60_000;

export interface IdempotentOutcome extends StoredResponse {
  replayed: boolean;
}

/** Lee el header Idempotency-Key (1 a 200 caracteres). */
export function parseIdempotencyKey(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = (Array.isArray(raw) ? raw[0] ?? "" : raw).trim();
  if (value.length < 1 || value.length > 200) {
    throw new ApiError(400, "VALIDATION", "El header Idempotency-Key debe tener entre 1 y 200 caracteres.", {
      errors: [{ field: "Idempotency-Key", message: "debe tener entre 1 y 200 caracteres" }],
    });
  }
  return value;
}

/** JSON con las claves ordenadas, para que el orden de los campos no cambie la huella. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const fields = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Huella del pedido: misma ruta y mismo cuerpo dan la misma huella. */
export function fingerprintOf(method: string, path: string, body: unknown): string {
  return crypto
    .createHash("sha256")
    .update(`${method} ${path}\n${stableStringify(body ?? {})}`)
    .digest("hex");
}

/**
 * Idempotency-Key (RNF-09): repetir la misma clave devuelve la respuesta original sin volver a aplicar la acción.
 */
export class IdempotencyService {
  private lastCleanup = 0;

  constructor(
    private readonly store: IdempotencyStore,
    private readonly now: () => number = Date.now
  ) {}

  async run(input: {
    key: string | undefined;
    actorId: string;
    fingerprint: string;
    execute: () => Promise<StoredResponse>;
  }): Promise<IdempotentOutcome> {
    const { key, actorId, fingerprint, execute } = input;

    // Sin clave: se ejecuta normalmente.
    if (key === undefined) {
      return { ...(await execute()), replayed: false };
    }

    this.cleanupSometimes();

    for (let attempt = 0; attempt < 3; attempt++) {
      const expiresAt = new Date(this.now() + TTL_MS);

      // 1) Primer pedido con esta clave: se reserva, se ejecuta y se guarda la respuesta.
      if (await this.store.tryClaim(actorId, key, fingerprint, expiresAt)) {
        let result: StoredResponse;
        try {
          result = await execute();
        } catch (err) {
          // Los errores no se guardan: la clave queda libre para reintentar.
          await this.store.release(actorId, key).catch(() => undefined);
          throw err;
        }
        try {
          await this.store.complete(actorId, key, result);
        } catch (err) {
          // La acción ya se aplicó; no se la hacemos fallar por no poder guardar la respuesta.
          console.error("[IDEMPOTENCY] no se pudo guardar la respuesta", err);
        }
        return { ...result, replayed: false };
      }

      // 2) La clave ya existía.
      const existing = await this.store.find(actorId, key);
      if (!existing) continue; // se borró justo ahora: se reintenta

      const nowMs = this.now();
      const expired = existing.expiresAt.getTime() <= nowMs;
      const stuck =
        existing.responseStatus === null && nowMs - existing.createdAt.getTime() > IN_PROGRESS_TIMEOUT_MS;
      if (expired || stuck) {
        await this.store.deleteById(existing.id);
        continue;
      }

      if (existing.fingerprint !== fingerprint) {
        throw new ApiError(
          422,
          "IDEMPOTENCY_KEY_REUSED",
          "La Idempotency-Key ya se usó con un pedido distinto (otra ruta u otro cuerpo)."
        );
      }

      if (existing.responseStatus === null) {
        throw new ApiError(
          409,
          "REQUEST_IN_PROGRESS",
          "Otro pedido con la misma Idempotency-Key todavía se está procesando."
        );
      }

      return {
        status: existing.responseStatus,
        body: existing.responseBody,
        etag: existing.responseEtag ?? "",
        replayed: true,
      };
    }

    throw new ApiError(409, "REQUEST_IN_PROGRESS", "No se pudo reservar la Idempotency-Key; reintentá en un momento.");
  }

  /** Borra las claves vencidas como mucho una vez por minuto. */
  private cleanupSometimes(): void {
    const nowMs = this.now();
    if (nowMs - this.lastCleanup < CLEANUP_EVERY_MS) return;
    this.lastCleanup = nowMs;
    this.store.deleteExpired(new Date(nowMs)).catch(() => undefined);
  }
}