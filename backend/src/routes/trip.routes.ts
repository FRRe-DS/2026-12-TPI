import http from "node:http";
import crypto from "node:crypto";
import { authenticateMiddleware } from "../middlewares/auth.middleware.js";
import { ApiError, handleErrorMiddleware, sendJsonResponse } from "../middlewares/error.middleware.js";
import { tripController, healthService } from "../config/services.js";
import { applyRateLimit } from "../middlewares/rate-limit.middleware.js";

/**
 * CAPA DE ENRUTAMIENTO (Router Layer)
 * Despacha las peticiones `/api/v1/*` definidas en `openapi.yaml` hacia el `TripController`.
 */
export async function handleApiV1Router(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<boolean> {
  const isContractPath =
    url.pathname === "/health" ||
    url.pathname === "/health/details" ||
    url.pathname === "/trips" ||
    url.pathname.startsWith("/trips/");

  if (!isContractPath) {
    return false;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Correlation-Id, X-Actor-Role, X-Actor-Id, If-None-Match, If-Match, Idempotency-Key",
      "Access-Control-Expose-Headers":
        "ETag, X-Correlation-Id, Retry-After, Location, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Idempotent-Replayed",
    });
    res.end();
    return true;
  }

  const correlationId =
    (req.headers["x-correlation-id"] as string | undefined) || crypto.randomUUID();
  const subPath = url.pathname;

  try {
    // 1. GET /api/v1/health (Público, sin requerir JWT)
    if (req.method === "GET" && subPath === "/health") {
      await tripController.getHealth(req, res, correlationId);
      return true;
    }

    // 1b. GET /health/details (Público): readiness y diagnóstico de dependencias (RNF-14)
    if (req.method === "GET" && subPath === "/health/details") {
      const { statusCode, report } = await healthService.getDetails();
      sendJsonResponse(res, statusCode, report, correlationId);
      return true;
    }

    // Middleware de Autenticación JWT (M1)
    const auth = authenticateMiddleware(req);
    applyRateLimit(auth, res);

    // 2. POST /trips
    if (req.method === "POST" && subPath === "/trips") {
      await tripController.createTrip(req, res, auth, correlationId);
      return true;
    }

    // 3. GET /api/v1/trips
    if (req.method === "GET" && subPath === "/trips") {
      await tripController.listTrips(url, res, auth, correlationId);
      return true;
    }

    // Rutas /api/v1/trips/{id}/*
    const tripMatch = subPath.match(/^\/trips\/([^/]+)(\/[a-z-]+)?$/);
    if (tripMatch) {
      const tripId = tripMatch[1]!;
      const action = tripMatch[2] || "";

      // 4. GET /api/v1/trips/{id}
      if (req.method === "GET" && action === "") {
        await tripController.getTripById(tripId, req, res, auth, correlationId);
        return true;
      }

      // 5. POST /api/v1/trips/{id}/arrived
      if (req.method === "POST" && action === "/arrived") {
        await tripController.markDriverArrived(tripId, req, res, auth, correlationId);
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

      // 10. POST /trips/{id}/client-rating (el cliente califica al conductor, RF-6.5)
      if (req.method === "POST" && action === "/client-rating") {
        await tripController.rateTrip(tripId, "CLIENT", req, res, auth, correlationId);
        return true;
      }

      // 11. POST /trips/{id}/driver-rating (el conductor califica al cliente, RF-6.5)
      if (req.method === "POST" && action === "/driver-rating") {
        await tripController.rateTrip(tripId, "DRIVER", req, res, auth, correlationId);
        return true;
      }
    }

    throw new ApiError(
      404,
      "ROUTE_NOT_FOUND",
      `Ruta OpenAPI no encontrada: ${req.method} ${url.pathname}`
    );
  } catch (err) {
    handleErrorMiddleware(err, res, correlationId, url.pathname);
    return true;
  }
}
