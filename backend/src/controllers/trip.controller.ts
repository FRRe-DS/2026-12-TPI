import http from "node:http";
import type { TripState } from "../../generated/prisma/client.js";
import type { AuthContext } from "../middlewares/auth.middleware.js";
import { ApiError, sendJsonResponse } from "../middlewares/error.middleware.js";
import type { TripService } from "../services/trip.service.js";
import { toTripResponse, toTripHistory } from "../mappers/trip.mapper.js";
import { CANCELLATION_REASONS, isCancellationReason } from "../domain/cancellation-rules.js";
import { parseIfMatch } from "../middlewares/preconditions.js";
import type { Trip } from "../../generated/prisma/client.js";
import {
  fingerprintOf,
  parseIdempotencyKey,
  type IdempotencyService,
} from "../services/idempotency.service.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATES: TripState[] = [
  "PENDING_ARRIVAL",
  "DRIVER_ARRIVED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
];

function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value);
}

/** Lee un parámetro `from`/`to` de la URL como fecha ISO 8601. */
function parseDateParam(url: URL, name: "from" | "to"): Date | undefined {
  const raw = url.searchParams.get(name);
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, "VALIDATION", `${name} debe ser una fecha ISO 8601 válida.`, {
      errors: [{ field: name, message: "debe ser una fecha ISO 8601 válida" }],
    });
  }
  return date;
}

/**
 * ETag fuerte basado en la versión del viaje: cambia en cada transición (RNF-08).
 * HTTP exige que el valor vaya entre comillas.
 */
function etagForVersion(version: number): string {
  return `"${version}"`;
}

/** `If-None-Match` puede traer varios ETags separados por coma, o `*`. */
function etagMatches(headerValue: string, etag: string): boolean {
  return headerValue
    .split(",")
    .map((v) => v.trim())
    .some((v) => v === "*" || v === etag || v === `W/${etag}`);
}

/** Tamaño máximo del cuerpo (RNF-12): 16 KB. */
const MAX_BODY_BYTES = 16 * 1024;

function payloadTooLarge(): ApiError {
  return new ApiError(
    413,
    "PAYLOAD_TOO_LARGE",
    `El cuerpo supera el máximo permitido de ${MAX_BODY_BYTES} bytes (16 KB).`
  );
}

async function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  // Rechazo rápido si el cliente ya declara un tamaño excesivo.
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    req.resume();
    throw payloadTooLarge();
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(payloadTooLarge());
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (tooLarge) return;
      const data = Buffer.concat(chunks).toString("utf-8");
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new ApiError(400, "VALIDATION", "El cuerpo de la petición no es un JSON válido."));
      }
    });
  });
}

/**
 * CAPA DE PRESENTACIÓN / CONTROLADORES HTTP (Controller Layer)
 * Valida el formato de entrada (DTOs, parámetros de ruta y query strings de `openapi.yaml`),
 * delega la operación al `TripService` y formatea la respuesta HTTP.
 */
export class TripController {
  constructor(
    private readonly tripService: TripService,
    private readonly idempotency: IdempotencyService
  ) {}

  async getHealth(_req: http.IncomingMessage, res: http.ServerResponse, correlationId: string) {
    const status = await this.tripService.getHealthStatus();
    sendJsonResponse(res, 200, status, correlationId);
  }

  async createTrip(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: AuthContext,
    correlationId: string
  ) {
    const body = await parseJsonBody(req);

    // Solo el contrato (CreateTripRequest, camelCase). Los campos sobrantes se ignoran.
    const {
      requestId,
      clientId,
      driverId,
      vehicleId,
      vehicleType,
      originLatitude,
      originLongitude,
      destinationLatitude,
      destinationLongitude,
    } = body ?? {};
    const reservationId = body?.reservationId ?? null;
    const originAddress = body?.originAddress ?? null;
    const destinationAddress = body?.destinationAddress ?? null;

    if (
      !isValidUuid(requestId) ||
      !isValidUuid(clientId) ||
      !isValidUuid(driverId) ||
      !isValidUuid(vehicleId)
    ) {
      throw new ApiError(
        400,
        "VALIDATION",
        "Los campos requestId, clientId, driverId y vehicleId son obligatorios y deben tener formato UUID válido."
      );
    }

    if (
      typeof originLatitude !== "number" ||
      originLatitude < -90 ||
      originLatitude > 90 ||
      typeof destinationLatitude !== "number" ||
      destinationLatitude < -90 ||
      destinationLatitude > 90 ||
      typeof originLongitude !== "number" ||
      originLongitude < -180 ||
      originLongitude > 180 ||
      typeof destinationLongitude !== "number" ||
      destinationLongitude < -180 ||
      destinationLongitude > 180
    ) {
      throw new ApiError(
        400,
        "VALIDATION",
        "Las coordenadas de origen y destino son obligatorias y deben estar en rango válido (lat: -90..90, lng: -180..180)."
      );
    }

    if (vehicleType !== "CAR" && vehicleType !== "MOTORCYCLE") {
      throw new ApiError(400, "VALIDATION", "El campo vehicleType es obligatorio y debe ser CAR o MOTORCYCLE.");
    }

    if (reservationId !== null && !isValidUuid(reservationId)) {
      throw new ApiError(400, "VALIDATION", "reservationId debe ser un UUID válido o null.");
    }

    if (originAddress !== null && (typeof originAddress !== "string" || originAddress.length > 300)) {
      throw new ApiError(400, "VALIDATION", "originAddress debe ser texto de hasta 300 caracteres o null.");
    }

    if (destinationAddress !== null && (typeof destinationAddress !== "string" || destinationAddress.length > 300)) {
      throw new ApiError(400, "VALIDATION", "destinationAddress debe ser texto de hasta 300 caracteres o null.");
    }

    const result = await this.tripService.createTrip(
      {
        requestId,
        clientId,
        driverId,
        vehicleId,
        vehicleType,
        reservationId,
        originAddress,
        destinationAddress,
        originLatitude,
        originLongitude,
        destinationLatitude,
        destinationLongitude,
      },
      auth,
      correlationId
    );

    sendJsonResponse(res, result.statusCode, toTripResponse(result.trip), correlationId, {
      ETag: etagForVersion(result.trip.version),
      ...(result.statusCode === 201 ? { Location: `/trips/${result.trip.id}` } : {}),
    });
  }

  async listTrips(
    url: URL,
    res: http.ServerResponse,
    auth: AuthContext,
    correlationId: string
  ) {
    const clientIdParam = url.searchParams.get("clientId") ?? undefined;
    const driverIdParam = url.searchParams.get("driverId") ?? undefined;
    const stateParam = url.searchParams.get("state") ?? undefined;
    const pageParam = url.searchParams.get("page") ?? "1";
    const pageSizeParam = url.searchParams.get("pageSize") ?? "20";

    if (clientIdParam && !isValidUuid(clientIdParam)) {
      throw new ApiError(400, "VALIDATION", "El parámetro clientId debe ser un UUID válido.");
    }
    if (driverIdParam && !isValidUuid(driverIdParam)) {
      throw new ApiError(400, "VALIDATION", "El parámetro driverId debe ser un UUID válido.");
    }

    // `state` admite varios valores separados por coma: ?state=COMPLETED,CANCELLED
    let states: TripState[] | undefined;
    if (stateParam) {
      const requested = stateParam.split(",").map((s) => s.trim());
      const invalid = requested.filter((s) => !VALID_STATES.includes(s as TripState));
      if (invalid.length > 0) {
        throw new ApiError(
          400,
          "VALIDATION",
          `El parámetro state tiene valores inválidos: ${invalid.join(", ")}. Valores permitidos: ${VALID_STATES.join(", ")}.`,
          { errors: [{ field: "state", message: `valores permitidos: ${VALID_STATES.join(", ")}` }] }
        );
      }
      states = requested as TripState[];
    }

    const from = parseDateParam(url, "from");
    const to = parseDateParam(url, "to");

    const page = Number(pageParam);
    const pageSize = Number(pageSizeParam);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new ApiError(
        400,
        "VALIDATION",
        "Los parámetros de paginación deben cumplir page >= 1 y 1 <= pageSize <= 100."
      );
    }

    const pageResult = await this.tripService.listTrips(
      {
        clientId: clientIdParam,
        driverId: driverIdParam,
        states,
        from,
        to,
        page,
        pageSize,
      },
      auth
    );

    sendJsonResponse(res, 200, pageResult, correlationId);
  }

  async getTripById(
    tripId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: AuthContext,
    correlationId: string
  ) {
    if (!isValidUuid(tripId)) {
      throw new ApiError(400, "VALIDATION", "El identificador del viaje (id) debe tener formato UUID válido.");
    }

    const trip = await this.tripService.getTripById(tripId, auth);
    const etag = etagForVersion(trip.version);
    const ifNoneMatch = req.headers["if-none-match"];

    // GET condicional (RFC 9110): si el cliente ya tiene esta versión, no se le manda el cuerpo.
    if (typeof ifNoneMatch === "string" && etagMatches(ifNoneMatch, etag)) {
      res.writeHead(304, {
        ETag: etag,
        ...(correlationId ? { "X-Correlation-Id": correlationId } : {}),
      });
      res.end();
      return;
    }

    sendJsonResponse(res, 200, toTripResponse(trip), correlationId, { ETag: etag });
  }

  /**
   * Ejecuta una acción sobre el viaje y responde 200 con el viaje actualizado.
   * Si viene `Idempotency-Key`, un reintento devuelve la respuesta guardada (con `Idempotent-Replayed: true`).
   */
  private async respondWithTrip(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: AuthContext,
    correlationId: string,
    request: { path: string; body?: unknown },
    execute: () => Promise<Trip>
  ) {
    const outcome = await this.idempotency.run({
      key: parseIdempotencyKey(req.headers["idempotency-key"]),
      actorId: auth.sub,
      fingerprint: fingerprintOf("POST", request.path, request.body),
      execute: async () => {
        const trip = await execute();
        return { status: 200, body: toTripResponse(trip), etag: etagForVersion(trip.version) };
      },
    });

    sendJsonResponse(res, outcome.status, outcome.body, correlationId, {
      ETag: outcome.etag,
      ...(outcome.replayed ? { "Idempotent-Replayed": "true" } : {}),
    });
  }

  async markDriverArrived(
    tripId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: AuthContext,
    correlationId: string
  ) {
    if (!isValidUuid(tripId)) {
      throw new ApiError(400, "VALIDATION", "El identificador del viaje (id) debe tener formato UUID válido.");
    }
    const ifMatch = parseIfMatch(req.headers["if-match"]);

    await this.respondWithTrip(
      req,
      res,
      auth,
      correlationId,
      { path: `/trips/${tripId.toLowerCase()}/arrived` },
      () => this.tripService.markDriverArrived(tripId, auth, correlationId, ifMatch)
    );
  }

  async startTrip(
    tripId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: AuthContext,
    correlationId: string
  ) {
    if (!isValidUuid(tripId)) {
      throw new ApiError(400, "VALIDATION", "El identificador del viaje (id) debe tener formato UUID válido.");
    }
    const ifMatch = parseIfMatch(req.headers["if-match"]);

    const body = await parseJsonBody(req);
    const verificationToken = body?.verificationToken;

    if (typeof verificationToken !== "string" || verificationToken.trim().length === 0) {
      throw new ApiError(
        400,
        "VALIDATION",
        "El campo verificationToken (código QR / token de un solo uso) es obligatorio."
      );
    }

    await this.respondWithTrip(
      req,
      res,
      auth,
      correlationId,
      { path: `/trips/${tripId.toLowerCase()}/start`, body },
      () => this.tripService.startTrip(tripId, verificationToken.trim(), auth, correlationId, ifMatch)
    );
  }

  async completeTrip(
    tripId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: AuthContext,
    correlationId: string
  ) {
    if (!isValidUuid(tripId)) {
      throw new ApiError(400, "VALIDATION", "El identificador del viaje (id) debe tener formato UUID válido.");
    }
    const ifMatch = parseIfMatch(req.headers["if-match"]);

    const body = await parseJsonBody(req);
    const { distanceKm, finalLatitude, finalLongitude } = body;

    if (typeof distanceKm !== "number" || !Number.isFinite(distanceKm) || distanceKm < 0.1) {
      throw new ApiError(
        400,
        "VALIDATION",
        "Datos inválidos: se requiere distanceKm (número mayor o igual a 0.1).",
        { errors: [{ field: "distanceKm", message: "debe ser mayor o igual a 0.1" }] }
      );
    }

    if (
      finalLatitude !== undefined &&
      (typeof finalLatitude !== "number" || finalLatitude < -90 || finalLatitude > 90)
    ) {
      throw new ApiError(400, "VALIDATION", "finalLatitude debe ser un número entre -90 y 90.");
    }

    if (
      finalLongitude !== undefined &&
      (typeof finalLongitude !== "number" || finalLongitude < -180 || finalLongitude > 180)
    ) {
      throw new ApiError(400, "VALIDATION", "finalLongitude debe ser un número entre -180 y 180.");
    }

    await this.respondWithTrip(
      req,
      res,
      auth,
      correlationId,
      { path: `/trips/${tripId.toLowerCase()}/complete`, body },
      () =>
        this.tripService.completeTrip(
          tripId,
          { distanceKm, finalLatitude, finalLongitude },
          auth,
          correlationId,
          ifMatch
        )
    );
  }

  async cancelTrip(
    tripId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: AuthContext,
    correlationId: string
  ) {
    if (!isValidUuid(tripId)) {
      throw new ApiError(400, "VALIDATION", "El identificador del viaje (id) debe tener formato UUID válido.");
    }
    const ifMatch = parseIfMatch(req.headers["if-match"]);

    const body = await parseJsonBody(req);
    const { reason, detail } = body ?? {};

    if (!isCancellationReason(reason)) {
      throw new ApiError(
        400,
        "VALIDATION",
        `El campo reason es obligatorio y debe ser uno de: ${CANCELLATION_REASONS.join(", ")}.`,
        { errors: [{ field: "reason", message: `valores permitidos: ${CANCELLATION_REASONS.join(", ")}` }] }
      );
    }

    if (detail !== undefined && (typeof detail !== "string" || detail.length > 500)) {
      throw new ApiError(400, "VALIDATION", "detail debe ser un texto de hasta 500 caracteres.", {
        errors: [{ field: "detail", message: "debe ser un texto de hasta 500 caracteres" }],
      });
    }

    await this.respondWithTrip(
      req,
      res,
      auth,
      correlationId,
      { path: `/trips/${tripId.toLowerCase()}/cancel`, body },
      () => this.tripService.cancelTrip(tripId, { reason, detail }, auth, correlationId, ifMatch)
    );
  }

  async getTripHistory(
    tripId: string,
    res: http.ServerResponse,
    auth: AuthContext,
    correlationId: string
  ) {
    if (!isValidUuid(tripId)) {
      throw new ApiError(400, "VALIDATION", "El identificador del viaje (id) debe tener formato UUID válido.");
    }

    const history = await this.tripService.getTripHistory(tripId, auth);
        sendJsonResponse(res, 200, toTripHistory(tripId, history), correlationId);
  }
}
