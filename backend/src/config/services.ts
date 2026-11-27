import { prisma } from "./database.js";
import { loadMessagingConfig } from "./messaging.js";
import { OutboxRepository } from "../repositories/outbox.repository.js";
import { RabbitMqPublisher } from "../services/rabbitmq-publisher.service.js";
import { OutboxDispatcher } from "../services/outbox-dispatcher.service.js";
import { TripRepository } from "../repositories/trip.repository.js";
import { IdempotencyRepository } from "../repositories/idempotency.repository.js";
import { eventPublisher } from "../services/event-publisher.service.js";
import { m8QrValidator } from "../services/m8-qr-validator.service.js";
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
export const tripService = new TripService(tripRepository, eventPublisher, m8QrValidator);
export const idempotencyService = new IdempotencyService(new IdempotencyRepository(prisma));
export const healthService = new HealthService(() => tripRepository.checkDatabaseHealth());
export const tripController = new TripController(tripService, idempotencyService);

/** Envío de eventos a RabbitMQ (RNF-10). Es null si no hay RABBITMQ_URL; lo arranca el servidor. */
const messagingConfig = loadMessagingConfig();
export const outboxDispatcher = messagingConfig
  ? new OutboxDispatcher(new OutboxRepository(prisma), new RabbitMqPublisher(messagingConfig))
  : null;