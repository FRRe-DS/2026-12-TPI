import http from "node:http";
import crypto from "node:crypto";
import { prisma } from "../config/database.js";
import { authenticateMiddleware } from "../middlewares/auth.middleware.js";
import { ApiError, handleErrorMiddleware } from "../middlewares/error.middleware.js";
import { TripRepository } from "../repositories/trip.repository.js";
import { eventPublisher } from "../services/event-publisher.service.js";
import { TripService } from "../services/trip.service.js";
import { TripController } from "../controllers/trip.controller.js";

// Inyección de dependencias (Wiring de las capas: Repository -> Service -> Controller)
const tripRepository = new TripRepository(prisma);
const tripService = new TripService(tripRepository, eventPublisher);
const tripController = new TripController(tripService);

/**
 * CAPA DE ENRUTAMIENTO (Router Layer)
 * Despacha las peticiones `/api/v1/*` definidas en `openapi.yaml` hacia el `TripController`.
 */
export async function handleApiV1Router(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/v1")) {
    return false;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Correlation-Id, X-Actor-Role, X-Actor-Id",
    });
    res.end();
    return true;
  }

  const correlationId =
    (req.headers["x-correlation-id"] as string | undefined) || crypto.randomUUID();
  const subPath = url.pathname.slice("/api/v1".length) || "/";

  try {
    // 1. GET /api/v1/health (Público, sin requerir JWT)
    if (req.method === "GET" && subPath === "/health") {
      await tripController.getHealth(req, res, correlationId);
      return true;
    }

    // Middleware de Autenticación JWT (M1)
    const auth = authenticateMiddleware(req);

    // 2. POST /api/v1/trips (y alias /api/v1/viajes para compatibilidad con propuesta M5)
    if (req.method === "POST" && (subPath === "/trips" || subPath === "/viajes")) {
      await tripController.createTrip(req, res, auth, correlationId);
      return true;
    }

    // 3. GET /api/v1/trips
    if (req.method === "GET" && subPath === "/trips") {
      await tripController.listTrips(url, res, auth, correlationId);
      return true;
    }

    // Rutas /api/v1/trips/{id}/*
    const tripMatch = subPath.match(/^\/trips\/([^/]+)(\/[a-z]+)?$/);
    if (tripMatch) {
      const tripId = tripMatch[1]!;
      const action = tripMatch[2] || "";

      // 4. GET /api/v1/trips/{id}
      if (req.method === "GET" && action === "") {
        await tripController.getTripById(tripId, res, auth, correlationId);
        return true;
      }

      // 5. POST /api/v1/trips/{id}/arrived
      if (req.method === "POST" && action === "/arrived") {
        await tripController.markDriverArrived(tripId, res, auth, correlationId);
        return true;
      }

      // 6. POST /api/v1/trips/{id}/start
      if (req.method === "POST" && action === "/start") {
        await tripController.startTrip(tripId, req, res, auth, correlationId);
        return true;
      }

      // 7. POST /api/v1/trips/{id}/complete
      if (req.method === "POST" && action === "/complete") {
        await tripController.completeTrip(tripId, req, res, auth, correlationId);
        return true;
      }

      // 8. POST /api/v1/trips/{id}/cancel
      if (req.method === "POST" && action === "/cancel") {
        await tripController.cancelTrip(tripId, req, res, auth, correlationId);
        return true;
      }

      // 9. GET /api/v1/trips/{id}/history
      if (req.method === "GET" && action === "/history") {
        await tripController.getTripHistory(tripId, res, auth, correlationId);
        return true;
      }
    }

    throw new ApiError(
      404,
      "ENDPOINT_NOT_FOUND",
      `Ruta OpenAPI no encontrada: ${req.method} ${url.pathname}`
    );
  } catch (err) {
    handleErrorMiddleware(err, res, correlationId);
    return true;
  }
}
