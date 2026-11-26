import http from "node:http";

/** Catálogo cerrado de códigos del contrato (schema `Problem.code` en openapi.yaml). */
export type ErrorCode =
  | "VALIDATION"
  | "UNAUTHENTICATED"
  | "PAYLOAD_TOO_LARGE"
  | "FORBIDDEN"
  | "TRIP_NOT_FOUND"
  | "ROUTE_NOT_FOUND"
  | "INVALID_STATE_TRANSITION"
  | "CONCURRENCY_CONFLICT"
  | "REQUEST_ID_CONFLICT"
  | "REQUEST_IN_PROGRESS"
  | "PRECONDITION_FAILED"
  | "INVALID_VERIFICATION_CODE"
  | "REASON_NOT_ALLOWED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "TOO_MANY_REQUESTS"
  | "DEPENDENCY_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface FieldError {
  field: string;
  message: string;
}

/** Datos opcionales que el contrato permite agregar a un error. */
export interface ApiErrorOptions {
  currentState?: string;
  errors?: FieldError[];
  headers?: Record<string, string>;
}

/**
 * Error de aplicación que se traduce al schema `Problem` (RFC 9457) de openapi.yaml.
 */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly options: ApiErrorOptions = {}
  ) {
    super(message);
  }
}

const TITLES: Record<ErrorCode, string> = {
  VALIDATION: "Datos inválidos",
  UNAUTHENTICATED: "No autenticado",
  PAYLOAD_TOO_LARGE: "Cuerpo demasiado grande",
  FORBIDDEN: "Acción no permitida",
  TRIP_NOT_FOUND: "Viaje no encontrado",
  ROUTE_NOT_FOUND: "Ruta no encontrada",
  INVALID_STATE_TRANSITION: "Transición inválida",
  CONCURRENCY_CONFLICT: "Conflicto de concurrencia",
  REQUEST_ID_CONFLICT: "Conflicto de requestId",
  REQUEST_IN_PROGRESS: "Pedido en curso",
  PRECONDITION_FAILED: "Precondición fallida",
  INVALID_VERIFICATION_CODE: "Código de verificación inválido",
  REASON_NOT_ALLOWED: "Motivo no permitido",
  IDEMPOTENCY_KEY_REUSED: "Idempotency-Key reutilizada",
  TOO_MANY_REQUESTS: "Demasiados pedidos",
  DEPENDENCY_UNAVAILABLE: "Dependencia no disponible",
  INTERNAL_ERROR: "Error interno",
};

/** INVALID_STATE_TRANSITION -> https://movilidad.example/errors/invalid-state-transition */
function errorType(code: ErrorCode): string {
  return `https://movilidad.example/errors/${code.toLowerCase().replace(/_/g, "-")}`;
}

export function sendJsonResponse(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  correlationId?: string,
  extraHeaders?: Record<string, string>
): void {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Correlation-Id, X-Actor-Role, X-Actor-Id, If-None-Match, If-Match, Idempotency-Key",
    "Access-Control-Expose-Headers":
      "ETag, X-Correlation-Id, Retry-After, Location, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Idempotent-Replayed",
  };
  if (correlationId) {
    headers["X-Correlation-Id"] = correlationId;
  }
  if (extraHeaders) {
    Object.assign(headers, extraHeaders);
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

/**
 * Middleware centralizado de errores: responde siempre `application/problem+json`
 * con la forma del schema `Problem` del contrato.
 */
export function handleErrorMiddleware(
  err: unknown,
  res: http.ServerResponse,
  correlationId: string,
  instance?: string
): void {
  let apiError: ApiError;
  if (err instanceof ApiError) {
    apiError = err;
  } else {
    // Un error inesperado se registra en el log, pero no se expone su detalle al cliente (RNF-19).
    console.error("[INTERNAL_ERROR]", err);
    apiError = new ApiError(500, "INTERNAL_ERROR", "Error interno del servidor.");
  }

  const { statusCode, code, message, options } = apiError;
  const problem = {
    type: errorType(code),
    title: TITLES[code],
    status: statusCode,
    code,
    detail: message,
    message,
    timestamp: new Date().toISOString(),
    ...(instance ? { instance } : {}),
    correlationId,
    ...(options.currentState ? { currentState: options.currentState } : {}),
    ...(options.errors ? { errors: options.errors } : {}),
  };

  sendJsonResponse(res, statusCode, problem, correlationId, {
    "Content-Type": "application/problem+json; charset=utf-8",
    ...(options.headers ?? {}),
  });
}