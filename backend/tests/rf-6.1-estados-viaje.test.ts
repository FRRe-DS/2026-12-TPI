import { describe, it, expect } from "vitest";
import { TripState as PrismaTripState } from "../generated/prisma/client.js";
import {
  TripStateMachine,
  TripState,
  ActorRole,
  VALID_TRANSITIONS,
  InvalidStateTransitionError,
  UnauthorizedRoleTransitionError,
} from "../src/domain/trip-state-machine.js";

/**
 * RF-6.1 (Estados del viaje): estados validos y transiciones controladas.
 *
 * La tabla PERMITIDAS esta escrita a mano a proposito, aparte de VALID_TRANSITIONS:
 * si alguien cambia la matriz del dominio por accidente, este test se rompe.
 */

const ESTADOS = Object.values(TripState);
const ROLES = Object.values(ActorRole);

const PERMITIDAS: ReadonlyArray<{ from: TripState; to: TripState; roles: ActorRole[] }> = [
  { from: TripState.PENDING_ARRIVAL, to: TripState.DRIVER_ARRIVED, roles: [ActorRole.DRIVER] },
  {
    from: TripState.PENDING_ARRIVAL,
    to: TripState.CANCELLED,
    roles: [ActorRole.CLIENT, ActorRole.DRIVER, ActorRole.OPERATOR],
  },
  { from: TripState.DRIVER_ARRIVED, to: TripState.IN_PROGRESS, roles: [ActorRole.DRIVER] },
  {
    from: TripState.DRIVER_ARRIVED,
    to: TripState.CANCELLED,
    roles: [ActorRole.CLIENT, ActorRole.DRIVER, ActorRole.OPERATOR],
  },
  { from: TripState.IN_PROGRESS, to: TripState.COMPLETED, roles: [ActorRole.DRIVER] },
  { from: TripState.IN_PROGRESS, to: TripState.CANCELLED, roles: [ActorRole.OPERATOR] },
];

type Resultado = "permitida" | "sin-permiso" | "ilegal";

/** Las 100 combinaciones (estado origen, estado destino, rol) con el resultado esperado. */
const COMBINACIONES = ESTADOS.flatMap((from) =>
  ESTADOS.flatMap((to) =>
    ROLES.map((role) => {
      const regla = PERMITIDAS.find((r) => r.from === from && r.to === to);
      let resultado: Resultado = "ilegal"; // no existe la transicion, o sale de un estado terminal
      if (regla) {
        resultado = regla.roles.includes(role) ? "permitida" : "sin-permiso";
      }
      return { from, to, role, resultado };
    })
  )
);

const permitidas = COMBINACIONES.filter((c) => c.resultado === "permitida");
const sinPermiso = COMBINACIONES.filter((c) => c.resultado === "sin-permiso");
const ilegales = COMBINACIONES.filter((c) => c.resultado === "ilegal");

/** Ejecuta validate y devuelve el error que tiro (o null si la transicion es valida). */
function errorDe(from: TripState, to: TripState, role: ActorRole): unknown {
  try {
    TripStateMachine.validate({ currentState: from, targetState: to, role });
    return null;
  } catch (err) {
    return err;
  }
}

describe("RF-6.1 Estados del viaje (unitario)", () => {
  describe("estados del contrato", () => {
    it("los estados son exactamente los de openapi.yaml", () => {
      expect(ESTADOS).toEqual([
        "PENDING_ARRIVAL",
        "DRIVER_ARRIVED",
        "IN_PROGRESS",
        "COMPLETED",
        "CANCELLED",
      ]);
    });

    it("los estados del dominio coinciden con el enum TripState de Prisma (la base)", () => {
      expect(Object.values(PrismaTripState).sort()).toEqual([...ESTADOS].sort());
    });

    it("COMPLETED y CANCELLED son terminales; los otros no", () => {
      expect(TripStateMachine.isTerminalState(TripState.COMPLETED)).toBe(true);
      expect(TripStateMachine.isTerminalState(TripState.CANCELLED)).toBe(true);
      expect(TripStateMachine.isTerminalState(TripState.PENDING_ARRIVAL)).toBe(false);
      expect(TripStateMachine.isTerminalState(TripState.DRIVER_ARRIVED)).toBe(false);
      expect(TripStateMachine.isTerminalState(TripState.IN_PROGRESS)).toBe(false);
    });
  });

  describe("matriz completa: estado origen x estado destino x rol", () => {
    it("la tabla de prueba tiene el tamano esperado (10 permitidas, 14 sin permiso, 76 ilegales)", () => {
      expect(COMBINACIONES).toHaveLength(100);
      expect(permitidas).toHaveLength(10);
      expect(sinPermiso).toHaveLength(14);
      expect(ilegales).toHaveLength(76);
    });

    it.each(permitidas)("$from -> $to como $role: permitida", ({ from, to, role }) => {
      expect(errorDe(from, to, role)).toBeNull();
      expect(TripStateMachine.canTransition({ currentState: from, targetState: to, role })).toBe(true);
    });

    it.each(sinPermiso)(
      "$from -> $to como $role: rechazada por rol (UnauthorizedRoleTransitionError)",
      ({ from, to, role }) => {
        expect(errorDe(from, to, role)).toBeInstanceOf(UnauthorizedRoleTransitionError);
        expect(TripStateMachine.canTransition({ currentState: from, targetState: to, role })).toBe(false);
      }
    );

    it.each(ilegales)(
      "$from -> $to como $role: ilegal (InvalidStateTransitionError, no es de rol)",
      ({ from, to, role }) => {
        const err = errorDe(from, to, role);
        expect(err).toBeInstanceOf(InvalidStateTransitionError);
        expect(err).not.toBeInstanceOf(UnauthorizedRoleTransitionError);
        expect(TripStateMachine.canTransition({ currentState: from, targetState: to, role })).toBe(false);
      }
    );
  });

  describe("estados terminales", () => {
    it.each([TripState.COMPLETED, TripState.CANCELLED])(
      "desde %s no se puede ir a ningun estado, con ningun rol, y el mensaje lo explica",
      (terminal) => {
        for (const to of ESTADOS) {
          for (const role of ROLES) {
            expect(() =>
              TripStateMachine.validate({ currentState: terminal, targetState: to, role })
            ).toThrow(/estado terminal/);
          }
        }
      }
    );
  });

  describe("rol SYSTEM", () => {
    it("SYSTEM no puede ejecutar ninguna transicion (solo crea viajes, via M5)", () => {
      for (const regla of VALID_TRANSITIONS) {
        expect(
          TripStateMachine.canTransition({
            currentState: regla.from,
            targetState: regla.to,
            role: ActorRole.SYSTEM,
          })
        ).toBe(false);
      }
    });
  });

  describe("transiciones disponibles desde cada estado", () => {
    it.each([
      { from: TripState.PENDING_ARRIVAL, destinos: ["CANCELLED", "DRIVER_ARRIVED"] },
      { from: TripState.DRIVER_ARRIVED, destinos: ["CANCELLED", "IN_PROGRESS"] },
      { from: TripState.IN_PROGRESS, destinos: ["CANCELLED", "COMPLETED"] },
      { from: TripState.COMPLETED, destinos: [] as string[] },
      { from: TripState.CANCELLED, destinos: [] as string[] },
    ])("desde $from se puede ir a: $destinos", ({ from, destinos }) => {
      const reales = TripStateMachine.getAllowedTransitions(from)
        .map((r) => r.to as string)
        .sort();
      expect(reales).toEqual(destinos);
    });
  });

  describe("coherencia de la matriz del dominio", () => {
    it("tiene 6 transiciones, sin pares repetidos y ninguna sale de un estado terminal", () => {
      const pares = VALID_TRANSITIONS.map((r) => `${r.from}>${r.to}`);
      expect(VALID_TRANSITIONS).toHaveLength(6);
      expect(new Set(pares).size).toBe(pares.length);
      expect(VALID_TRANSITIONS.filter((r) => TripStateMachine.isTerminalState(r.from))).toEqual([]);
    });

    it("la matriz del dominio coincide con la tabla escrita a mano en este test", () => {
      const delDominio = VALID_TRANSITIONS.map((r) => ({
        from: r.from,
        to: r.to,
        roles: [...r.allowedRoles].sort(),
      }));
      const escritaAMano = PERMITIDAS.map((r) => ({ ...r, roles: [...r.roles].sort() }));
      expect(delDominio).toEqual(escritaAMano);
    });
  });

  describe("rol del actor", () => {
    it("sin rol, validate lanza UnauthorizedRoleTransitionError y canTransition da false", () => {
      const ctx = {
        currentState: TripState.PENDING_ARRIVAL,
        targetState: TripState.DRIVER_ARRIVED,
      };
      expect(() => TripStateMachine.validate(ctx)).toThrow(UnauthorizedRoleTransitionError);
      expect(() => TripStateMachine.validate(ctx)).toThrow(/rol del actor/);
      expect(TripStateMachine.canTransition(ctx)).toBe(false);
    });

    it("acepta el rol tambien con el nombre actorRole", () => {
      expect(
        TripStateMachine.validate({
          currentState: TripState.DRIVER_ARRIVED,
          targetState: TripState.IN_PROGRESS,
          actorRole: ActorRole.DRIVER,
        })
      ).toBe(true);
    });
  });

  describe("errores de dominio", () => {
    it("UnauthorizedRoleTransitionError es un InvalidStateTransitionError (el service chequea primero el de rol)", () => {
      const err = new UnauthorizedRoleTransitionError("x");
      expect(err).toBeInstanceOf(InvalidStateTransitionError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("UnauthorizedRoleTransitionError");
      expect(new InvalidStateTransitionError("x").name).toBe("InvalidStateTransitionError");
    });
  });
});