/**
 * Módulo M6: Viajes y Ciclo de Vida
 * Máquina de Estados del Viaje (RF-6.1)
 *
 * Implementación de la lógica de dominio y matriz de transiciones desacoplada de la persistencia.
 */

export enum TripState {
  PENDING_ARRIVAL = 'PENDING_ARRIVAL',
  DRIVER_ARRIVED = 'DRIVER_ARRIVED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export type TripStateType = `${TripState}`;

export enum ActorRole {
  CLIENT = 'CLIENT',
  DRIVER = 'DRIVER',
  OPERATOR = 'OPERATOR',
  SYSTEM = 'SYSTEM',
}

export type ActorRoleType = `${ActorRole}`;

/**
 * Representa una regla de transición en la máquina de estados.
 */
export interface StateTransitionRule {
  readonly from: TripState;
  readonly to: TripState;
  readonly allowedRoles: readonly ActorRole[];
  readonly description: string;
}

/**
 * Matriz de transiciones válidas según RF-6.1
 */
export const VALID_TRANSITIONS: readonly StateTransitionRule[] = [
  {
    from: TripState.PENDING_ARRIVAL,
    to: TripState.DRIVER_ARRIVED,
    allowedRoles: [ActorRole.DRIVER],
    description: 'El conductor notifica su llegada al punto de retiro (RF-6.3)',
  },
  {
    from: TripState.PENDING_ARRIVAL,
    to: TripState.CANCELLED,
    allowedRoles: [ActorRole.CLIENT, ActorRole.DRIVER],
    description: 'El cliente o el conductor cancela antes del arribo (RF-6.6 / RF-6.7)',
  },
  {
    from: TripState.DRIVER_ARRIVED,
    to: TripState.IN_PROGRESS,
    allowedRoles: [ActorRole.DRIVER],
    description: 'El conductor inicia el viaje tras validar QR / token en M8 (RF-6.4)',
  },

  {
    from: TripState.DRIVER_ARRIVED,
    to: TripState.CANCELLED,
    allowedRoles: [ActorRole.CLIENT, ActorRole.DRIVER],
    description: 'El cliente o el conductor cancela mientras el conductor espera (RF-6.6 / RF-6.7)',
  },

  {
    from: TripState.IN_PROGRESS,
    to: TripState.COMPLETED,
    allowedRoles: [ActorRole.DRIVER],
    description: 'El conductor finaliza el viaje registrando métricas de distancia y tiempo (RF-6.5)',
  },

  {
    from: TripState.IN_PROGRESS,
    to: TripState.CANCELLED,
    allowedRoles: [ActorRole.CLIENT, ActorRole.DRIVER],
    description: 'Cancelación durante el viaje: el cliente se baja o el conductor no puede continuar (RF-6.6 / RF-6.7)',
  },
] as const;

/**
 * Estados terminales del viaje (inmutables, no admiten transiciones salientes).
 */
export const TERMINAL_STATES: readonly TripState[] = [
  TripState.COMPLETED,
  TripState.CANCELLED,
] as const;

/**
 * Contexto de transición recibido por la máquina de estados.
 */
export interface TransitionContext {
  currentState: TripState | TripStateType;
  targetState: TripState | TripStateType;
  role?: ActorRole | ActorRoleType;
  actorRole?: ActorRole | ActorRoleType;
  actorId?: string;
  tripId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Excepción base para transiciones inválidas en el ciclo de vida del viaje.
 */
export class InvalidStateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateTransitionError';
    Object.setPrototypeOf(this, InvalidStateTransitionError.prototype);
  }
}

/**
 * Excepción lanzada cuando el actor no tiene autorización para ejecutar la transición.
 */
export class UnauthorizedRoleTransitionError extends InvalidStateTransitionError {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedRoleTransitionError';
    Object.setPrototypeOf(this, UnauthorizedRoleTransitionError.prototype);
  }
}

/**
 * Máquina de Estados para la gestión del ciclo de vida del viaje (RF-6.1).
 * Totalmente desacoplada de la base de datos y de frameworks externos.
 */
export class TripStateMachine {
  /**
   * Valida una transición de estado de forma estática.
   * Lanza InvalidStateTransitionError o UnauthorizedRoleTransitionError si la transición no es válida.
   * Retorna true si la transición es permitida.
   */
  public static validate(context: TransitionContext): boolean {
    const { currentState, targetState } = context;
    const role = (context.role ?? context.actorRole) as ActorRole | undefined;

    if (!role) {
      throw new UnauthorizedRoleTransitionError(
        'Se requiere especificar el rol del actor (role o actorRole) para validar la transición.'
      );
    }

    // 1. Verificar si el estado actual es terminal
    if (TripStateMachine.isTerminalState(currentState as TripState)) {
      throw new InvalidStateTransitionError(
        `No se permite realizar transiciones desde el estado terminal '${currentState}'. El viaje ya se encuentra finalizado o cancelado y es inmutable.`
      );
    }

    // 2. Verificar transición idempotente o redundante hacia el mismo estado
    if (currentState === targetState) {
      throw new InvalidStateTransitionError(
        `Transición redundante: el viaje ya se encuentra en el estado '${currentState}'.`
      );
    }

    // 3. Buscar si la transición existe en la matriz de transiciones válidas según RF-6.1
    const transitionRule = VALID_TRANSITIONS.find(
      (rule) => rule.from === currentState && rule.to === targetState
    );

    if (!transitionRule) {
      throw new InvalidStateTransitionError(
        `Transición ilegal no permitida: no se puede transicionar desde '${currentState}' hacia '${targetState}'.`
      );
    }

    // 4. Validar permisos del rol ejecutor
    if (!transitionRule.allowedRoles.includes(role as ActorRole)) {
      throw new UnauthorizedRoleTransitionError(
        `El rol '${role}' no está autorizado para realizar la transición de '${currentState}' a '${targetState}'. Roles autorizados: [${transitionRule.allowedRoles.join(
          ', '
        )}].`
      );
    }

    return true;
  }

  /**
   * Método de instancia para validar transiciones delegando en la lógica de dominio.
   */
  public validate(context: TransitionContext): boolean {
    return TripStateMachine.validate(context);
  }

  /**
   * Verifica si una transición es válida retornando un booleano sin lanzar excepciones.
   */
  public static canTransition(context: TransitionContext): boolean {
    try {
      return TripStateMachine.validate(context);
    } catch {
      return false;
    }
  }

  /**
   * Método de instancia para verificar si una transición es válida.
   */
  public canTransition(context: TransitionContext): boolean {
    return TripStateMachine.canTransition(context);
  }

  /**
   * Determina si un estado es terminal e inmutable.
   */
  public static isTerminalState(state: TripState | TripStateType): boolean {
    return TERMINAL_STATES.includes(state as TripState);
  }

  /**
   * Obtiene la lista de transiciones válidas a partir de un estado dado.
   */
  public static getAllowedTransitions(fromState: TripState | TripStateType): readonly StateTransitionRule[] {
    return VALID_TRANSITIONS.filter((rule) => rule.from === fromState);
  }
}
