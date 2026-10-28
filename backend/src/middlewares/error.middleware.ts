import http from "node:http";

/**
 * Excepción de dominio/aplicación que se traduce al esquema `ErrorResponse` de OpenAPI.
 */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function sendJsonResponse(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  correlationId?: string
): void {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Correlation-Id, X-Actor-Role, X-Actor-Id",
  };
  if (correlationId) {
    headers["X-Correlation-Id"] = correlationId;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

/**
 * Middleware centralizado de manejo de errores conforme a `ErrorResponse` en `openapi.yaml`.
 */
export function handleErrorMiddleware(
  err: unknown,
  res: http.ServerResponse,
  correlationId: string
): void {
  if (err instanceof ApiError) {
    sendJsonResponse(
      res,
      err.statusCode,
      {
        code: err.code,
        message: err.message,
        correlationId,
        timestamp: new Date().toISOString(),
      },
      correlationId
    );
    return;
  }

  const message = err instanceof Error ? err.message : "Error interno del servidor.";
  sendJsonResponse(
    res,
    500,
    {
      code: "INTERNAL_SERVER_ERROR",
      message,
      correlationId,
      timestamp: new Date().toISOString(),
    },
    correlationId
  );
}
