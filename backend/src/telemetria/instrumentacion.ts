import "dotenv/config";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { metrics } from "@opentelemetry/api";
import type { Histogram } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HostMetrics } from "@opentelemetry/host-metrics";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace";
import type { SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace";
import type { Context, Span } from "@opentelemetry/api";
import { routeName } from "./registro.js";

// El panel de OpsBoard consulta esta serie. Prisma produce spans de consulta,
// pero no el histograma de cliente de BD que produce la instrumentacion de pg.
let queryDuration: Histogram | undefined;

class PrismaQueryMetrics implements SpanProcessor {
  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    if (span.name !== "prisma:engine:db_query") return;
    const seconds = span.duration[0] + span.duration[1] / 1e9;
    queryDuration?.record(seconds, { "db.system.name": "postgresql" });
  }

  forceFlush(): Promise<void> { return Promise.resolve(); }
  shutdown(): Promise<void> { return Promise.resolve(); }
}

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT && process.env.OTEL_SDK_DISABLED !== "true") {
  process.env.OTEL_SERVICE_NAME ||= "m6-grupo12";
  if (!/(^|,)\s*grupo=/.test(process.env.OTEL_RESOURCE_ATTRIBUTES ?? "")) {
    process.env.OTEL_RESOURCE_ATTRIBUTES = ["grupo=12", process.env.OTEL_RESOURCE_ATTRIBUTES].filter(Boolean).join(",");
  }

  const sdk = new NodeSDK({
    spanProcessors: [new PrismaQueryMetrics(), new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })],
    metricReaders: [new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 5000),
    })],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => request.url?.startsWith("/health") ?? false,
        startIncomingSpanHook: ({ url }) => {
          const path = URL.parse(url ?? "/", "http://localhost")?.pathname ?? "/{unmatched}";
          return { "url.path": routeName(path), "url.query": undefined };
        },
      }),
      new PrismaInstrumentation(),
      new UndiciInstrumentation(),
      new RuntimeNodeInstrumentation(),
    ],
  });
  sdk.start();
  queryDuration = metrics.getMeter("m6-viajes").createHistogram("db.client.operation.duration", {
    unit: "s",
    description: "Duracion de consultas PostgreSQL ejecutadas por Prisma",
    advice: { explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] },
  });
  new HostMetrics({ name: "m6-viajes" }).start();

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void sdk.shutdown().finally(() => process.exit(0)));
  }
}
