import { describe, it, expect } from "vitest";
import {
  CANCELLATION_REASONS,
  ALLOWED_REASONS,
  checkCancellationReason,
  requiresRedispatch,
  type CancellationReasonValue,
} from "../src/domain/cancellation-rules.js";
import { TripStateMachine, TripState, ActorRole } from "../src/domain/trip-state-machine.js";

/**
 * RF-6.6 (Cancelacion por cliente): reglas de dominio, sin base de datos ni HTTP.
 * - Motivos del catalogo que puede usar el cliente.
 * - El cliente nunca provoca re-despacho (requiresRedispatch = false).
 * - Estados desde los que el cliente puede cancelar (maquina de estados, RF-6.1).
 * El comportamiento por HTTP (evento, historial, tiempo transcurrido) esta en
 * tests/integration/rf-6.6-cancelacion-cliente.test.ts.
 */

const MOTIVOS_CLIENTE: CancellationReasonValue[] = [
  "CHANGE_OF_PLANS",
  "EXCESSIVE_DELAY",
  "DRIVER_NO_SHOW",
  "OTHER",
];
const MOTIVOS_AJENOS = CANCELLATION_REASONS.filter((m) => !MOTIVOS_CLIENTE.includes(m));
const AHORA = new Date("2026-11-09T12:00:00.000Z");
const PLAZO_NO_SHOW_MIN = 5;

describe("RF-6.6: reglas de cancelacion del cliente (unitario)", () => {
  describe("catalogo de motivos del cliente", () => {
    it("el cliente tiene exactamente los 4 motivos del contrato", () => {
      expect([...ALLOWED_REASONS.CLIENT].sort()).toEqual([...MOTIVOS_CLIENTE].sort());
    });

    it.each(MOTIVOS_CLIENTE)("acepta %s, antes y despues del arribo", (motivo) => {
      expect(checkCancellationReason("CLIENT", motivo, null, AHORA, PLAZO_NO_SHOW_MIN)).toBeNull();
      const arribo = new Date(AHORA.getTime() - 60_000);
      expect(checkCancellationReason("CLIENT", motivo, arribo, AHORA, PLAZO_NO_SHOW_MIN)).toBeNull();
    });

    it.each(MOTIVOS_AJENOS)("rechaza %s porque no es un motivo del cliente", (motivo) => {
      const problema = checkCancellationReason("CLIENT", motivo, null, AHORA, PLAZO_NO_SHOW_MIN);
      expect(problema).not.toBeNull();
      expect(problema).toContain("CLIENT");
    });
  });

  describe("re-despacho", () => {
    it.each(MOTIVOS_CLIENTE)("cancelar con %s nunca pide re-despacho a M5", (motivo) => {
      expect(requiresRedispatch("CLIENT", motivo)).toBe(false);
    });
  });

  describe("estados desde los que puede cancelar (RF-6.1)", () => {
    it.each([TripState.PENDING_ARRIVAL, TripState.DRIVER_ARRIVED])(
      "puede cancelar desde %s",
      (desde) => {
        expect(
          TripStateMachine.canTransition({
            currentState: desde,
            targetState: TripState.CANCELLED,
            role: ActorRole.CLIENT,
          })
        ).toBe(true);
      }
    );

    it.each([TripState.IN_PROGRESS, TripState.COMPLETED, TripState.CANCELLED])(
      "no puede cancelar desde %s",
      (desde) => {
        expect(
          TripStateMachine.canTransition({
            currentState: desde,
            targetState: TripState.CANCELLED,
            role: ActorRole.CLIENT,
          })
        ).toBe(false);
      }
    );
  });
});
