import http from "node:http";
import type { TripState } from "../../generated/prisma/client.js";
import type { AuthContext } from "../middlewares/auth.middleware.js";
import { ApiError, sendJsonResponse } from "../middlewares/error.middleware.js";
import type { TripService } from "../services/trip.service.js";
import { toTripResponse } from "../mappers/trip.mapper.js";

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

async function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new ApiError(400, "INVALID_JSON", "El cuerpo de la petición no es un JSON válido."));
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
  constructor(private readonly tripService: TripService) {}

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

    // Soporta tanto el contrato estándar M6 (camelCase) como la propuesta de M5 (snake_case en español)
    const isSpanishPayload = Boolean(body?.solicitud_id && !body?.requestId);
    const requestId = body?.requestId ?? body?.solicitud_id;
    const clientId = body?.clientId ?? body?.cliente_id;
    const driverId = body?.driverId ?? body?.conductor_id;
    const vehicleId = body?.vehicleId ?? body?.vehiculo_id;
    const originLatitude = body?.originLatitude ?? body?.origen_latitud;
    const originLongitude = body?.originLongitude ?? body?.origen_longitud;
    const destinationLatitude = body?.destinationLatitude ?? body?.destino_latitud;
    const destinationLongitude = body?.destinationLongitude ?? body?.destino_longitud;
    const vehicleType = body?.vehicleType;
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
        "INVALID_UUID_FIELDS",
        "Los campos requestId (o solicitud_id), clientId (o cliente_id), driverId (o conductor_id) y vehicleId (o vehiculo_id) son obligatorios y deben tener formato UUID válido."
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
        "INVALID_COORDINATES",
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

    const responseBody = isSpanishPayload
      ? {
          ...result.trip,
          viaje_id: result.trip.id,
          solicitud_id: result.trip.requestId,
          estado: "CREADO",
        }
      : toTripResponse(result.trip);

    sendJsonResponse(res, result.statusCode, responseBody, correlationId);
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
      throw new ApiError(400, "INVALID_CLIENT_ID", "El parámetro clientId debe ser un UUID válido.");
    }
    if (driverIdParam && !isValidUuid(driverIdParam)) {
      throw new ApiError(400, "INVALID_DRIVER_ID", "El parámetro driverId debe ser un UUID válido.");
    }
    if (stateParam && !VALID_STATES.includes(stateParam as TripState)) {
      throw new ApiError(400, "INVALID_STATE", `El parámetro state debe ser uno de: ${VALID_STATES.join(", ")}.`);
    }

    const page = Number(pageParam);
    const pageSize = Number(pageSizeParam);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new ApiError(
        400,
        "INVALID_PAGINATION",
        "Los parámetros de paginación deben cumplir page >= 1 y 1 <= pageSize <= 100."
      );
    }

    const pageResult = await this.tripService.listTrips(
      {
        clientId: clientIdParam,
        driverId: driverIdParam,
        state: stateParam as TripState | undefined,
        page,
        pageSize,
      },
      auth
    );

    sendJsonResponse(res, 200, pageResult, correlationId);
  }

  async getTripById(
    tripId: string,
    res: http.ServerResponse,
    auth: AuthContext,
    correlationId: string
  ) {
    if (!isValidUuid(tripId)) {
      throw new ApiError(400, "INVALID_TRIP_ID", "El identificador del viaje (id) debe tener formato UUID válido.");
    }

    const trip = await this.tripService.getTripById(tripId, auth);
    sendJsonResponse(res, 200, toTripResponse(trip), correlationId);
  }

  async markDriverArrived(
    tripId: string,
    res: http.ServerResponse,
    auth: AuthContext,
    correlationId: string
  ) {
    if (!isValidUuid(tripId)) {
      throw new ApiError(400, "INVALID_TRIP_ID", "El identificador del viaje (id) debe tener formato UUID válido.");
    }

    const updated = await this.tripService.markDriverArrived(tripId, auth, correlationId);
    sendJsonResponse(res, 200, toTripResponse(updated), correlationId);
  }

  async startTrip(
    tripId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: AuthContext,
    correlationId: string
  ) {
    if (!isValidUuid(tripId)) {
      throw new ApiError(400, "INVALID_TRIP_ID", "El identificador del viaje (id) debe tener formato UUID válido.");
    }

    const body = await parseJsonBody(req);
    const verificationToken = body?.verificationToken;

    if (typeof verificationToken !== "string" || verificationToken.trim().length === 0) {
      throw new ApiError(
        400,
        "MISSING_VERIFICATION_TOKEN",
        "El campo verificationToken (código QR / token de un solo uso) es obligatorio."
      );
    }

    const updated = await this.tripService.startTrip(
      tripId,
      verificationToken.trim(),
      auth,
      correlationId
    );
    sendJsonResponse(res, 200, toTripResponse(updated), correlationId);
  }

  async completeTrip(
    tripId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: AuthContext,
    correlationId: string
  ) {
    if (!isValidUuid(tripId)) {
      throw new ApiError(400, "INVALID_TRIP_ID", "El identificador del viaje (id) debe tener formato UUID válido.");
    }

    const body = await parseJsonBody(req);
    const { distanceKm, finalLatitude, finalLongitude } = body;

    if (typeof distanceKm !== "number" || !Number.isFinite(distanceKm) || distanceKm < 0.1) {
      throw new ApiError(
        400,
        "INVALID_COMPLETION_METRICS",
        "Datos inválidos: se requiere distanceKm (número mayor o igual a 0.1)."
      );
    }

    if (
      finalLatitude !== undefined &&
      (typeof finalLatitude !== "number" || finalLatitude < -90 || finalLatitude > 90)
    ) {
      throw new ApiError(400, "INVALID_COMPLETION_METRICS", "finalLatitude debe ser un número entre -90 y 90.");
    }

    if (
      finalLongitude !== undefined &&
      (typeof finalLongitude !== "number" || finalLongitude < -180 || finalLongitude > 180)
    ) {
      throw new ApiError(400, "INVALID_COMPLETION_METRICS", "finalLongitude debe ser un número entre -180 y 180.");
    }

    const updated = await this.tripService.completeTrip(
      tripId,
      { distanceKm, finalLatitude, finalLongitude },
      auth,
      correlationId
    );
    sendJsonResponse(res, 200, toTripResponse(updated), correlationId);
  }

  async cancelTrip(
    tripId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: AuthContext,
    correlationId: string
  ) {
    if (!isValidUuid(tripId)) {
      throw new ApiError(400, "INVALID_TRIP_ID", "El identificador del viaje (id) debe tener formato UUID válido.");
    }

    const body = await parseJsonBody(req);
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";

    if (reason.length < 3 || reason.length > 255) {
      throw new ApiError(
        400,
        "INVALID_CANCEL_REASON",
        "El motivo de cancelación (reason) es obligatorio y debe tener entre 3 y 255 caracteres."
      );
    }

    const updated = await this.tripService.cancelTrip(tripId, reason, auth, correlationId);
    sendJsonResponse(res, 200, toTripResponse(updated), correlationId);
  }

  async getTripHistory(
    tripId: string,
    res: http.ServerResponse,
    auth: AuthContext,
    correlationId: string
  ) {
    if (!isValidUuid(tripId)) {
      throw new ApiError(400, "INVALID_TRIP_ID", "El identificador del viaje (id) debe tener formato UUID válido.");
    }

    const history = await this.tripService.getTripHistory(tripId, auth);
    sendJsonResponse(res, 200, history, correlationId);
  }
}
