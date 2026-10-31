import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "./config/database.js";
import { tripService } from "./config/services.js";
import { handleApiV1Router } from "./routes/trip.routes.js";
import { eventPublisher } from "./services/event-publisher.service.js";
import { createDemoJwt } from "./middlewares/auth.middleware.js";

// RNF-06: el puerto se configura por variable de entorno, con 3006 como valor por defecto.
const PORT = Number(process.env.PORT ?? 3006);

async function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  try {
    // 1. Rutas oficiales del contrato OpenAPI 3.0 (/api/v1/...) mediante Arquitectura en Capas
    const handledByOpenApi = await handleApiV1Router(req, res, url);
    if (handledByOpenApi) return;

    // 2. Servir el archivo openapi.yaml crudo y la interfaz Swagger UI (/docs)
    if (req.method === "GET" && url.pathname === "/openapi.yaml") {
      const yamlPath = path.resolve(process.cwd(), "..", "openapi.yaml");
      const content = fs.readFileSync(yamlPath, "utf-8");
      res.writeHead(200, {
        "Content-Type": "text/yaml; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(content);
    }

    if (req.method === "GET" && url.pathname === "/docs") {
      const swaggerPath = path.resolve(process.cwd(), "..", "frontend", "swagger.html");
      const swaggerContent = fs.readFileSync(swaggerPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(swaggerContent);
    }

    // 3. Endpoints de soporte para el Panel Visual
    if (req.method === "GET" && url.pathname === "/api/demo-tokens") {
      const lastTrip = await prisma.trip.findFirst({ orderBy: { createdAt: "desc" } });
      const clientId = lastTrip?.clientId || "c1111111-1111-4111-8111-111111111111";
      const driverId = lastTrip?.driverId || "d1111111-1111-4111-8111-111111111111";
      return sendJson(res, 200, {
        SYSTEM: createDemoJwt("m5-dispatch-service", "SYSTEM"),
        OPERATOR: createDemoJwt("op-00000000-0000-4000-8000-000000000001", "OPERATOR"),
        DRIVER: createDemoJwt(driverId, "DRIVER"),
        CLIENT: createDemoJwt(clientId, "CLIENT"),
        lastTripId: lastTrip?.id || null,
        driverId,
        clientId,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/data") {
      const trips = await prisma.trip.findMany({
        orderBy: { createdAt: "desc" },
        include: { events: { orderBy: { createdAt: "asc" } } },
      });
      const events = await prisma.tripEventHistory.findMany({
        orderBy: { createdAt: "desc" },
      });
      return sendJson(res, 200, {
        trips,
        events,
        domainEvents: eventPublisher.getPublishedEvents(),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/seed") {
      const count = await prisma.trip.count();
      const req1 = crypto.randomUUID();
      const req2 = crypto.randomUUID();
      const req3 = crypto.randomUUID();

      const client1 = "c1111111-1111-4111-8111-111111111111";
      const driver1 = "d1111111-1111-4111-8111-111111111111";
      const vehicle1 = "a1111111-1111-4111-8111-111111111111";

      await prisma.$transaction(async (tx) => {
        const t1 = await tx.trip.create({
          data: {
            requestId: req1,
            clientId: client1,
            driverId: driver1,
            vehicleId: vehicle1,
            vehicleType: "CAR",
            originLatitude: -27.4514,
            originLongitude: -58.9792,
            destinationLatitude: -27.4512,
            destinationLongitude: -58.9866,
            state: "COMPLETED",
            distanceKm: 1.8,
            durationMinutes: 7,
          },
        });
        await tx.tripEventHistory.createMany({
          data: [
            {
              tripId: t1.id,
              state: "PENDING_ARRIVAL",
              actorRole: "SYSTEM",
              metadata: { source: "M5_DISPATCH", requestId: req1 },
            },
            {
              tripId: t1.id,
              state: "DRIVER_ARRIVED",
              actorId: driver1,
              actorRole: "DRIVER",
            },
            {
              tripId: t1.id,
              state: "IN_PROGRESS",
              actorId: driver1,
              actorRole: "DRIVER",
              metadata: { qrVerifiedWithM8: true },
            },
            {
              tripId: t1.id,
              state: "COMPLETED",
              actorId: driver1,
              actorRole: "DRIVER",
              metadata: { distanceKm: 1.8, durationMinutes: 7 },
            },
          ],
        });

        const t2 = await tx.trip.create({
          data: {
            requestId: req2,
            clientId: "c2222222-2222-4222-8222-222222222222",
            driverId: "d2222222-2222-4222-8222-222222222222",
            vehicleId: "a2222222-2222-4222-8222-222222222222",
            vehicleType: "CAR",
            originLatitude: -27.4411,
            originLongitude: -58.9652,
            destinationLatitude: -27.4321,
            destinationLongitude: -58.9588,
            state: "PENDING_ARRIVAL",
          },
        });
        await tx.tripEventHistory.create({
          data: {
            tripId: t2.id,
            state: "PENDING_ARRIVAL",
            actorRole: "SYSTEM",
            metadata: { source: "M5_DISPATCH", requestId: req2 },
          },
        });
        eventPublisher.publish("TripCreated", t2.id, {
          requestId: req2,
          clientId: t2.clientId,
          driverId: t2.driverId,
          vehicleId: t2.vehicleId,
        });

        const client3 = "c3333333-3333-4333-8333-333333333333";
        const t3 = await tx.trip.create({
          data: {
            requestId: req3,
            clientId: client3,
            driverId: "d3333333-3333-4333-8333-333333333333",
            vehicleId: "a3333333-3333-4333-8333-333333333333",
            vehicleType: "CAR",
            originLatitude: -27.4605,
            originLongitude: -58.9831,
            destinationLatitude: -27.4712,
            destinationLongitude: -58.9915,
            state: "CANCELLED",
            cancelledBy: "CLIENT",
          },
        });
        await tx.tripEventHistory.createMany({
          data: [
            {
              tripId: t3.id,
              state: "PENDING_ARRIVAL",
              actorRole: "SYSTEM",
              metadata: { source: "M5_DISPATCH", requestId: req3 },
            },
            {
              tripId: t3.id,
              state: "CANCELLED",
              actorId: client3,
              actorRole: "CLIENT",
              reason: "Demora excesiva del conductor asignado",
            },
          ],
        });
      });

      return sendJson(res, 201, { message: "Datos de prueba insertados correctamente", previousCount: count });
    }

    if (req.method === "POST" && url.pathname === "/api/trips") {
      const body = await parseBody(req);
      const requestId = body.requestId || crypto.randomUUID();
      const clientId = body.clientId || crypto.randomUUID();
      const driverId = body.driverId || crypto.randomUUID();
      const vehicleId = body.vehicleId || crypto.randomUUID();
      const originLatitude = Number(body.originLatitude ?? -27.4514);
      const originLongitude = Number(body.originLongitude ?? -58.9792);
      const destinationLatitude = Number(body.destinationLatitude ?? -27.4512);
      const destinationLongitude = Number(body.destinationLongitude ?? -58.9866);

      const existing = await prisma.trip.findUnique({ where: { requestId } });
      if (existing) {
        const samePayload =
          existing.clientId === clientId &&
          existing.driverId === driverId &&
          existing.vehicleId === vehicleId &&
          existing.originLatitude === originLatitude &&
          existing.originLongitude === originLongitude &&
          existing.destinationLatitude === destinationLatitude &&
          existing.destinationLongitude === destinationLongitude;

        if (samePayload) {
          return sendJson(res, 200, {
            idempotentReplay: true,
            message: "Idempotencia (200 OK): Ya existía un viaje con este requestId y mismos datos. No se duplicó.",
            trip: existing,
          });
        } else {
          return sendJson(res, 409, {
            error: "CONFLICT_REQUEST_ID",
            message: "Conflicto (409): El requestId ya existe en la BD pero con datos diferentes.",
          });
        }
      }

      const created = await prisma.$transaction(async (tx) => {
        const trip = await tx.trip.create({
          data: {
            requestId,
            clientId,
            driverId,
            vehicleId,
            vehicleType: "CAR",
            originLatitude,
            originLongitude,
            destinationLatitude,
            destinationLongitude,
            state: "PENDING_ARRIVAL",
          },
        });
        await tx.tripEventHistory.create({
          data: {
            tripId: trip.id,
            state: "PENDING_ARRIVAL",
            actorRole: "SYSTEM",
            metadata: { source: "M5_DISPATCH", requestId },
          },
        });
        return trip;
      });

      eventPublisher.publish("TripCreated", created.id, {
        requestId,
        clientId,
        driverId,
        vehicleId,
      });

      return sendJson(res, 201, { idempotentReplay: false, trip: created });
    }

    if (req.method === "POST" && url.pathname === "/api/transition") {
      const body = await parseBody(req);
      const { tripId, targetState, reason, distanceKm } = body;

      if (typeof tripId !== "string" || typeof targetState !== "string") {
        return sendJson(res, 400, {
          error: "INVALID_TRANSITION",
          message: "Se requieren tripId y targetState.",
        });
      }

      const trip = await prisma.trip.findUnique({ where: { id: tripId } });
      if (!trip) return sendJson(res, 404, { error: "Viaje no encontrado" });

      // El panel delega en el service: así cumple las mismas reglas que la API
      // (RF-6.1, RF-6.8, RNF-08) y emite los mismos eventos (RNF-03).
      const correlationId = crypto.randomUUID();
      const driverAuth = { sub: trip.driverId, role: "DRIVER" as const };

      try {
        if (targetState === "DRIVER_ARRIVED") {
          await tripService.markDriverArrived(tripId, driverAuth, correlationId);
        } else if (targetState === "IN_PROGRESS") {
          // Token distinto en cada intento: el service los trata como de un solo uso (RF-6.4).
          await tripService.startTrip(
            tripId,
            `panel-${crypto.randomUUID()}`,
            driverAuth,
            correlationId
          );
        } else if (targetState === "COMPLETED") {
          await tripService.completeTrip(
            tripId,
            { distanceKm: Number(distanceKm ?? 3.4) },
            driverAuth,
            correlationId
          );
        } else if (targetState === "CANCELLED") {
          const cancelledBy = body.cancelledBy === "DRIVER" ? "DRIVER" : "CLIENT";
          await tripService.cancelTrip(
            tripId,
            typeof reason === "string" && reason.trim()
              ? reason.trim()
              : "Cancelado desde el panel",
            {
              sub: cancelledBy === "CLIENT" ? trip.clientId : trip.driverId,
              role: cancelledBy,
            },
            correlationId
          );
        } else {
          return sendJson(res, 400, {
            error: "INVALID_TRANSITION",
            message: `El panel no puede llevar un viaje a ${targetState}.`,
          });
        }
      } catch (err: any) {
        const status = typeof err?.statusCode === "number" ? err.statusCode : 500;
        return sendJson(res, status, {
          error: err?.code ?? "ERROR",
          message: err?.message ?? "Error interno.",
        });
      }

      const updated = await prisma.trip.findUnique({ where: { id: tripId } });
      return sendJson(res, 200, { trip: updated });
    }

    if (req.method === "GET" && url.pathname === "/") {
      const htmlPath = path.resolve(process.cwd(), "..", "frontend", "index.html");
      const htmlContent = fs.readFileSync(htmlPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(htmlContent);
    }

    sendJson(res, 404, { error: "Ruta no encontrada" });
  } catch (err: any) {
    sendJson(res, 500, { error: err?.message || "Error interno" });
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 Servidor M6 corriendo en:`);
  console.log(`   👉 Panel Visual de Persistencia: http://localhost:${PORT}`);
  console.log(`   👉 Swagger UI (OpenAPI /api/v1): http://localhost:${PORT}/docs`);
  console.log(`   👉 Health Check:                 http://localhost:${PORT}/health\n`);
});
