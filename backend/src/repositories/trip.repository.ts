import { PrismaClient, TripState, ActorRole, VehicleType, CancellationReason, TripAction } from "../../generated/prisma/client.js";

export interface CreateTripRepoInput {
  requestId: string;
  clientId: string;
  driverId: string;
  vehicleId: string;
  vehicleType: VehicleType;
  reservationId?: string | null;
  originAddress?: string | null;
  destinationAddress?: string | null;
  originLatitude: number;
  originLongitude: number;
  destinationLatitude: number;
  destinationLongitude: number;
}

export interface ListTripsFilter {
  clientId?: string;
  driverId?: string;
  states?: TripState[];
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

export interface TransitionTripRepoInput {
  tripId: string;
  expectedFromState?: TripState;
  targetState: TripState;
  action: TripAction;
  actorId: string;
  actorRole: ActorRole;
  reason?: string | null;
  distanceKm?: number;
  durationMinutes?: number;
  durationSeconds?: number;
  finalLatitude?: number;
  finalLongitude?: number;
  completedAt?: Date;
  cancelledBy?: ActorRole;
  cancellationReason?: CancellationReason;
  cancellationDetail?: string;
  cancelledFromState?: TripState;
  requiresRedispatch?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * CAPA DE ACCESO A DATOS (Repository Layer)
 * Encapsula absolutamente todas las operaciones de persistencia y transacciones ACID contra PostgreSQL.
 */
export class TripRepository {
  constructor(private readonly db: PrismaClient) {}

  async checkDatabaseHealth(): Promise<boolean> {
    await this.db.$queryRaw`SELECT 1`;
    return true;
  }

  async findById(id: string) {
    return this.db.trip.findUnique({ where: { id } });
  }

  async findByRequestId(requestId: string) {
    return this.db.trip.findUnique({ where: { requestId } });
  }

  /**
   * Crea el viaje en `trips` y su primer registro en `trip_event_history` en una única transacción ACID.
   */
  async createTripWithInitialEvent(input: CreateTripRepoInput, actorId: string) {
    return this.db.$transaction(async (tx) => {
      const trip = await tx.trip.create({
        data: {
          requestId: input.requestId,
          clientId: input.clientId,
          driverId: input.driverId,
          vehicleId: input.vehicleId,
          vehicleType: input.vehicleType,
          reservationId: input.reservationId ?? null,
          originAddress: input.originAddress ?? null,
          destinationAddress: input.destinationAddress ?? null,
          originLatitude: input.originLatitude,
          originLongitude: input.originLongitude,
          destinationLatitude: input.destinationLatitude,
          destinationLongitude: input.destinationLongitude,
          state: "PENDING_ARRIVAL",
        },
      });

      await tx.tripEventHistory.create({
        data: {
          tripId: trip.id,
          sequence: trip.version,
          action: "CREATE",
          state: "PENDING_ARRIVAL",
          actorId,
          actorRole: "SYSTEM",
          metadata: { source: "M5_DISPATCH", requestId: input.requestId },
        },
      });

      return trip;
    });
  }

  /**
  * Lista viajes paginados devolviendo exclusivamente las columnas de `TripSummary` (sin coordenadas, RF-4.7).
  */
  async findSummariesPaginated(filter: ListTripsFilter) {
    const where: Record<string, unknown> = {};
    if (filter.clientId) where.clientId = filter.clientId;
    if (filter.driverId) where.driverId = filter.driverId;
    if (filter.states && filter.states.length > 0) where.state = { in: filter.states };
    if (filter.from || filter.to) {
      where.createdAt = {
        ...(filter.from ? { gte: filter.from } : {}), // from: inclusive
        ...(filter.to ? { lt: filter.to } : {}), // to: exclusivo
      };
    }

    const [total, items] = await Promise.all([
      this.db.trip.count({ where }),
      this.db.trip.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
        select: {
          id: true,
          state: true,
          vehicleType: true,
          clientId: true,
          driverId: true,
          originAddress: true,
          destinationAddress: true,
          distanceKm: true,
          durationMinutes: true,
          createdAt: true,
          completedAt: true,
        },
      }),
    ]);

    return {
      items,
      page: filter.page,
      pageSize: filter.pageSize,
      total,
    };
  }

  /**
   * Aplica una transición de estado en `trips` e inserta una fila inmutable en `trip_event_history`
   * de forma atómica y con control de concurrencia (RNF-08 / RF-6.8).
   */
    async transitionStateAtomic(input: TransitionTripRepoInput) {
    const now = new Date();
    const completedAt = input.completedAt ?? now; 

    let milestone: {
      arrivedAt?: Date;
      startedAt?: Date;
      completedAt?: Date;
      cancelledAt?: Date;
    } = {};

    if (input.targetState === "DRIVER_ARRIVED") milestone = { arrivedAt: now };
    else if (input.targetState === "IN_PROGRESS") milestone = { startedAt: now };
    else if (input.targetState === "COMPLETED") milestone = { completedAt };
    else if (input.targetState.startsWith("CANCELLED")) milestone = { cancelledAt: now };

    const data = {
      state: input.targetState,
      version: { increment: 1 },
      ...milestone,
      ...(input.distanceKm !== undefined ? { distanceKm: input.distanceKm } : {}),
      ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
      ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
      ...(input.cancelledBy !== undefined ? { cancelledBy: input.cancelledBy } : {}),
      ...(input.cancellationReason !== undefined ? { cancellationReason: input.cancellationReason } : {}),
      ...(input.cancellationDetail !== undefined ? { cancellationDetail: input.cancellationDetail } : {}),
      ...(input.cancelledFromState !== undefined ? { cancelledFromState: input.cancelledFromState } : {}),
      ...(input.requiresRedispatch !== undefined ? { requiresRedispatch: input.requiresRedispatch } : {}),
      ...(input.finalLatitude !== undefined ? { finalLatitude: input.finalLatitude } : {}),
      ...(input.finalLongitude !== undefined ? { finalLongitude: input.finalLongitude } : {}),
    };

    return this.db.$transaction(async (tx) => {
      if (input.expectedFromState) {
        const result = await tx.trip.updateMany({
          where: { id: input.tripId, state: input.expectedFromState },
          data,
        });

        if (result.count === 0) {
          return null;
        }
      } else {
        await tx.trip.update({
          where: { id: input.tripId },
          data,
        });
      }

      const updated = await tx.trip.findUniqueOrThrow({ where: { id: input.tripId } });

      // sequence = versión del viaje luego de la transición (1 al crear, +1 por cada cambio)
      await tx.tripEventHistory.create({
        data: {
          tripId: input.tripId,
          sequence: updated.version,
          fromState: input.expectedFromState ?? null,
          state: input.targetState,
          action: input.action,
          actorId: input.actorId,
          actorRole: input.actorRole,
          reason: input.reason ?? null,
          detail: input.cancellationDetail ?? null,
          ...(input.metadata ? { metadata: input.metadata as any } : {}),
        },
      });

      return updated;
    });
  }

  /**
   * Obtiene el historial inmutable de eventos de un viaje ordenado cronológicamente (RF-6.8).
   */
  async findEventHistoryByTripId(tripId: string) {
    return this.db.tripEventHistory.findMany({
      where: { tripId },
      orderBy: { sequence: "asc" },
    });
  }
}
