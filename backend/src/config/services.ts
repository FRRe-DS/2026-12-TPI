import { prisma } from "./database.js";
import { TripRepository } from "../repositories/trip.repository.js";
import { eventPublisher } from "../services/event-publisher.service.js";
import { TripService } from "../services/trip.service.js";
import { TripController } from "../controllers/trip.controller.js";

/**
 * Wiring de dependencias en un solo lugar: Repository -> Service -> Controller.
 * Se instancia una única vez para que el estado en memoria del service
 * (tokens de verificación ya usados, RNF-09) sea compartido por todas las rutas.
 */
export const tripRepository = new TripRepository(prisma);
export const tripService = new TripService(tripRepository, eventPublisher);
export const tripController = new TripController(tripService);
