import { describe, it, expect } from 'vitest';
import {
  TripStateMachine,
  TripState,
  ActorRole,
  TransitionContext,
  InvalidStateTransitionError,
  UnauthorizedRoleTransitionError,
} from '../src/domain/trip-state-machine.js';

describe('TripStateMachine - Pruebas Unitarias (RF-6.1)', () => {
  describe('Requerimientos Funcionales Específicos', () => {
    // 1. Test que permita chofer marcar llegada desde PENDING_ARRIVAL
    it('debe permitir que el chofer marque llegada desde PENDING_ARRIVAL', () => {
      // Arrange (Organizar)
      const stateMachine = new TripStateMachine();
      const context: TransitionContext = {
        currentState: TripState.PENDING_ARRIVAL,
        targetState: TripState.DRIVER_ARRIVED,
        role: ActorRole.DRIVER,
      };

      // Act (Actuar)
      const isValid = stateMachine.validate(context);

      // Assert (Afirmar)
      expect(isValid).toBe(true);
    });

    // 2. Test que rechace que el cliente inicie el viaje
    it('debe rechazar que el cliente inicie el viaje', () => {
      // Arrange (Organizar)
      const stateMachine = new TripStateMachine();
      const context: TransitionContext = {
        currentState: TripState.DRIVER_ARRIVED,
        targetState: TripState.IN_PROGRESS,
        role: ActorRole.CLIENT,
      };

      // Act & Assert (Actuar y Afirmar)
      expect(() => stateMachine.validate(context)).toThrow(
        UnauthorizedRoleTransitionError
      );
      expect(() => stateMachine.validate(context)).toThrow(
        /no está autorizado/i
      );
    });

    // 3. Test que rechace transiciones ilegales (ej: saltar a COMPLETED)
    it('debe rechazar transiciones ilegales (ej: saltar a COMPLETED desde PENDING_ARRIVAL)', () => {
      // Arrange (Organizar)
      const stateMachine = new TripStateMachine();
      const context: TransitionContext = {
        currentState: TripState.PENDING_ARRIVAL,
        targetState: TripState.COMPLETED,
        role: ActorRole.DRIVER,
      };

      // Act & Assert (Actuar y Afirmar)
      expect(() => stateMachine.validate(context)).toThrow(
        InvalidStateTransitionError
      );
      expect(() => stateMachine.validate(context)).toThrow(
        /transición ilegal no permitida/i
      );
    });

    // 4. Test que impida cancelar un viaje ya COMPLETED
    it('debe impedir cancelar un viaje ya COMPLETED', () => {
      // Arrange (Organizar)
      const stateMachine = new TripStateMachine();
      const contextClient: TransitionContext = {
        currentState: TripState.COMPLETED,
        targetState: TripState.CANCELLED_BY_CLIENT,
        role: ActorRole.CLIENT,
      };
      const contextDriver: TransitionContext = {
        currentState: TripState.COMPLETED,
        targetState: TripState.CANCELLED_BY_DRIVER,
        role: ActorRole.DRIVER,
      };

      // Act & Assert (Actuar y Afirmar)
      expect(() => stateMachine.validate(contextClient)).toThrow(
        InvalidStateTransitionError
      );
      expect(() => stateMachine.validate(contextClient)).toThrow(
        /estado terminal 'COMPLETED'/i
      );

      expect(() => stateMachine.validate(contextDriver)).toThrow(
        InvalidStateTransitionError
      );
      expect(() => stateMachine.validate(contextDriver)).toThrow(
        /estado terminal 'COMPLETED'/i
      );
    });
  });

  describe('Ciclo de Vida Completo y Casos de Borde', () => {
    it('debe permitir la secuencia completa de viaje exitoso: PENDING_ARRIVAL -> DRIVER_ARRIVED -> IN_PROGRESS -> COMPLETED', () => {
      // Arrange
      const step1: TransitionContext = {
        currentState: TripState.PENDING_ARRIVAL,
        targetState: TripState.DRIVER_ARRIVED,
        role: ActorRole.DRIVER,
      };
      const step2: TransitionContext = {
        currentState: TripState.DRIVER_ARRIVED,
        targetState: TripState.IN_PROGRESS,
        role: ActorRole.DRIVER,
      };
      const step3: TransitionContext = {
        currentState: TripState.IN_PROGRESS,
        targetState: TripState.COMPLETED,
        role: ActorRole.DRIVER,
      };

      // Act & Assert
      expect(TripStateMachine.validate(step1)).toBe(true);
      expect(TripStateMachine.validate(step2)).toBe(true);
      expect(TripStateMachine.validate(step3)).toBe(true);
    });

    it('debe permitir cancelaciones válidas por cliente y conductor en PENDING_ARRIVAL y DRIVER_ARRIVED', () => {
      // Arrange
      const cancelByClientPending: TransitionContext = {
        currentState: TripState.PENDING_ARRIVAL,
        targetState: TripState.CANCELLED_BY_CLIENT,
        role: ActorRole.CLIENT,
      };
      const cancelByDriverPending: TransitionContext = {
        currentState: TripState.PENDING_ARRIVAL,
        targetState: TripState.CANCELLED_BY_DRIVER,
        role: ActorRole.DRIVER,
      };
      const cancelByClientArrived: TransitionContext = {
        currentState: TripState.DRIVER_ARRIVED,
        targetState: TripState.CANCELLED_BY_CLIENT,
        role: ActorRole.CLIENT,
      };
      const cancelByDriverArrived: TransitionContext = {
        currentState: TripState.DRIVER_ARRIVED,
        targetState: TripState.CANCELLED_BY_DRIVER,
        role: ActorRole.DRIVER,
      };

      // Act & Assert
      expect(TripStateMachine.validate(cancelByClientPending)).toBe(true);
      expect(TripStateMachine.validate(cancelByDriverPending)).toBe(true);
      expect(TripStateMachine.validate(cancelByClientArrived)).toBe(true);
      expect(TripStateMachine.validate(cancelByDriverArrived)).toBe(true);
    });

    it('debe rechazar la cancelación de un viaje en estado IN_PROGRESS', () => {
      // Arrange
      const cancelClientInProgress: TransitionContext = {
        currentState: TripState.IN_PROGRESS,
        targetState: TripState.CANCELLED_BY_CLIENT,
        role: ActorRole.CLIENT,
      };
      const cancelDriverInProgress: TransitionContext = {
        currentState: TripState.IN_PROGRESS,
        targetState: TripState.CANCELLED_BY_DRIVER,
        role: ActorRole.DRIVER,
      };

      // Act & Assert
      expect(() => TripStateMachine.validate(cancelClientInProgress)).toThrow(
        InvalidStateTransitionError
      );
      expect(() => TripStateMachine.validate(cancelDriverInProgress)).toThrow(
        InvalidStateTransitionError
      );
    });

    it('debe rechazar cualquier transición desde estados terminales CANCELLED', () => {
      // Arrange
      const fromCancelledClient: TransitionContext = {
        currentState: TripState.CANCELLED_BY_CLIENT,
        targetState: TripState.IN_PROGRESS,
        role: ActorRole.DRIVER,
      };
      const fromCancelledDriver: TransitionContext = {
        currentState: TripState.CANCELLED_BY_DRIVER,
        targetState: TripState.PENDING_ARRIVAL,
        role: ActorRole.DRIVER,
      };

      // Act & Assert
      expect(() => TripStateMachine.validate(fromCancelledClient)).toThrow(
        /estado terminal/i
      );
      expect(() => TripStateMachine.validate(fromCancelledDriver)).toThrow(
        /estado terminal/i
      );
    });

    it('debe rechazar transiciones redundantes hacia el mismo estado', () => {
      // Arrange
      const sameState: TransitionContext = {
        currentState: TripState.PENDING_ARRIVAL,
        targetState: TripState.PENDING_ARRIVAL,
        role: ActorRole.DRIVER,
      };

      // Act & Assert
      expect(() => TripStateMachine.validate(sameState)).toThrow(
        /transición redundante/i
      );
    });

    it('debe verificar canTransition() retornando boolean sin arrojar excepciones', () => {
      // Arrange
      const validContext: TransitionContext = {
        currentState: TripState.PENDING_ARRIVAL,
        targetState: TripState.DRIVER_ARRIVED,
        role: ActorRole.DRIVER,
      };
      const invalidContext: TransitionContext = {
        currentState: TripState.PENDING_ARRIVAL,
        targetState: TripState.COMPLETED,
        role: ActorRole.DRIVER,
      };

      // Act
      const canValid = TripStateMachine.canTransition(validContext);
      const canInvalid = TripStateMachine.canTransition(invalidContext);

      // Assert
      expect(canValid).toBe(true);
      expect(canInvalid).toBe(false);
    });
  });
});
