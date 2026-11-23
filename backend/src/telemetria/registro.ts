import { context, logs, SeverityNumber, trace } from "@opentelemetry/api";
import { getRPCMetadata, RPCType } from "@opentelemetry/core";
import type { Span } from "@opentelemetry/api";
import type http from "node:http";

function routeName(path: string): string {
  const prefix = path.startsWith("/api/v1/") ? "/api/v1" : "";
  const rest = prefix ? path.slice(prefix.length) : path;
  if (/^\/trips\/[^/]+(?:\/(?:arrived|start|complete|cancel|history|client-rating|driver-rating))?$/.test(rest)) {
    return prefix + rest.replace(/^\/trips\/[^/]+/, "/trips/{id}");
  }
  if (["/", "/trips", "/api/data", "/api/seed", "/api/trips", "/api/transition", "/api/demo-tokens", "/docs", "/openapi.yaml"].includes(rest)) {
    return prefix + rest;
  }
  return prefix + "/{unmatched}";
}

export function registerRequestLog(req: http.IncomingMessage, res: http.ServerResponse, path: string): void {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_SDK_DISABLED === "true") return;
  if (path.startsWith("/health") || path === "/api/v1/health" || path === "/api/v1/health/details") return;
  const span = trace.getActiveSpan();
  const route = routeName(path);
  const rpc = getRPCMetadata(context.active());
  if (rpc?.type === RPCType.HTTP) rpc.route = route;
  span?.setAttribute("http.route", route);
  span?.updateName(`${req.method ?? "UNKNOWN"} ${route}`);

  res.once("finish", () => emitRequestLog(req.method ?? "UNKNOWN", route, res, span));
}

function emitRequestLog(method: string, route: string, res: http.ServerResponse, span?: Span): void {
  const correlationId = res.getHeader("X-Correlation-Id");
  const spanContext = span?.spanContext();
  const record = {
    momento: new Date().toISOString(),
    nivel: res.statusCode >= 500 ? "error" : "info",
    message: `${method} ${route} ${res.statusCode}`,
    http_request_method: method,
    http_route: route,
    http_response_status_code: res.statusCode,
    ...(typeof correlationId === "string" ? { idCorrelacion: correlationId } : {}),
    ...(spanContext ? { trace_id: spanContext.traceId, span_id: spanContext.spanId } : {}),
  };
  process.stdout.write(JSON.stringify(record) + "\n");

  const emit = () => logs.getLogger("m6-viajes").emit({
    severityNumber: res.statusCode >= 500 ? SeverityNumber.ERROR : SeverityNumber.INFO,
    severityText: res.statusCode >= 500 ? "ERROR" : "INFO",
    body: record.message,
    attributes: record,
  });
  if (span) context.with(trace.setSpan(context.active(), span), emit);
  else emit();
}
