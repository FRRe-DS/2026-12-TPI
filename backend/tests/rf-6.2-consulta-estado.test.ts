import { describe, it, expect, vi, beforeEach } from "vitest";
import { TripService } from "../src/services/trip.service.js";
import type { TripRepository } from "../src/repositories/trip.repository.js";
import type { EventPublisherService } from "../src/services/event-publisher.service.js";
import type { AuthContext } from "../src/middlewares/auth.middleware.js";
import { ApiError } from "../src/middlewares/error.middleware.js";

/**
 * RF-6.2 (Consulta de estado): unitario de la capa de servicio.
 *
 * Se mockea el repositorio para probar SOLO la regla de acceso: quien puede ver
 * el viaje y quien recibe 404. La base real se ejercita en el test de integracion.
 */

const TRIP_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const DRIVER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ID = "99999999-9999-4999-8999-999999999999";

const UN_TRIP = {
  id: TRIP_ID,
  clientId: CLIENT_ID,
  driverId: DRIVER_ID,
  state: "IN_PROGRESS",
  version: 3,
};

function auth(role: AuthContext["role"], sub: string): AuthContext {
  return { role, sub };
}

describe("RF-6.2: consulta de estado del viaje (unitario)", () => {
  let findById: ReturnType<typeof vi.fn>;
  let service: TripService;

  beforeEach(() => {
    findById = vi.fn();
    const repository = { findById } as unknown as TripRepository;
    const publisher = { publish: vi.fn() } as unknown as EventPublisherService;
    service = new TripService(repository, publisher);
  });

  describe("roles autorizados", () => {
    it("el CLIENT titular obtiene el viaje", async () => {
      findById.mockResolvedValue(UN_TRIP);

      const result = await service.getTripById(TRIP_ID, auth("CLIENT", CLIENT_ID));

      expect(result).toBe(UN_TRIP);
      expect(findById).toHaveBeenCalledWith(TRIP_ID);
    });

    it("el DRIVER asignado obtiene el viaje", async () => {
      findById.mockResolvedValue(UN_TRIP);

      const result = await service.getTripById(TRIP_ID, auth("DRIVER", DRIVER_ID));

      expect(result).toBe(UN_TRIP);
    });

    it("un OPERATOR obtiene cualquier viaje", async () => {
      findById.mockResolvedValue(UN_TRIP);

      const result = await service.getTripById(TRIP_ID, auth("OPERATOR", OTHER_ID));

      expect(result).toBe(UN_TRIP);
    });

    it("el servicio SYSTEM (M5, M2, M4) obtiene el viaje", async () => {
      findById.mockResolvedValue(UN_TRIP);

      const result = await service.getTripById(TRIP_ID, auth("SYSTEM", OTHER_ID));

      expect(result).toBe(UN_TRIP);
    });
  });

  describe("roles no autorizados: 404 para no revelar que el viaje existe (RNF-19)", () => {
    it("un CLIENT ajeno recibe 404 TRIP_NOT_FOUND", async () => {
      findById.mockResolvedValue(UN_TRIP);

      const promise = service.getTripById(TRIP_ID, auth("CLIENT", OTHER_ID));

      await expect(promise).rejects.toMatchObject({
        statusCode: 404,
        code: "TRIP_NOT_FOUND",
      });
      await expect(promise).rejects.toBeInstanceOf(ApiError);
    });

    it("un DRIVER que no es el asignado recibe 404 TRIP_NOT_FOUND", async () => {
      findById.mockResolvedValue(UN_TRIP);

      const promise = service.getTripById(TRIP_ID, auth("DRIVER", OTHER_ID));

      await expect(promise).rejects.toMatchObject({
        statusCode: 404,
        code: "TRIP_NOT_FOUND",
      });
      await expect(promise).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe("viaje inexistente", () => {
    it("responde 404 TRIP_NOT_FOUND aunque el rol sea OPERATOR", async () => {
      findById.mockResolvedValue(null);

      await expect(
        service.getTripById(TRIP_ID, auth("OPERATOR", OTHER_ID))
      ).rejects.toMatchObject({
        statusCode: 404,
        code: "TRIP_NOT_FOUND",
      });
    });
  });
});
