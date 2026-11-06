import { prisma } from "./database.js";
import { TripRepository } from "../repositories/trip.repository.js";
import { IdempotencyRepository } from "../repositories/idempotency.repository.js";
import { eventPublisher } from "../services/event-publisher.service.js";
import { TripService } from "../services/trip.service.js";
import { IdempotencyService } from "../services/idempotency.service.js";
import { HealthService } from "../services/health.service.js";
import { TripController } from "../controllers/trip.controller.js";

/**
 * Wiring de dependencias en un solo lugar: Repository -> Service -> Controller.
 * Se instancia una única vez para que el estado en memoria del service
 * (tokens de verificación ya usados, RNF-09) sea compartido por todas las rutas.
 */
export const tripRepository = new TripRepository(prisma);
export const tripService = new TripService(tripRepository, eventPublisher);
export const idempotencyService = new IdempotencyService(new IdempotencyRepository(prisma));
export const healthService = new HealthService(() => tripRepository.checkDatabaseHealth());
export const tripController = new TripController(tripService, idempotencyService);