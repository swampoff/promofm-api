import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from "prom-client";

// Create a dedicated registry
export const metricsRegistry = new Registry();

// Collect default Node.js metrics (CPU, memory, event loop, GC)
collectDefaultMetrics({ register: metricsRegistry, prefix: "promofm_" });

// ── Custom metrics ──

// HTTP request counter
export const httpRequestsTotal = new Counter({
  name: "promofm_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "path", "status_code"],
  registers: [metricsRegistry],
});

// HTTP request duration histogram (p50, p95, p99)
export const httpRequestDuration = new Histogram({
  name: "promofm_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "path", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

// Active connections gauge
export const activeConnections = new Gauge({
  name: "promofm_active_connections",
  help: "Number of active connections",
  registers: [metricsRegistry],
});

// Database query counter
export const dbQueriesTotal = new Counter({
  name: "promofm_db_queries_total",
  help: "Total database queries",
  labelNames: ["operation"],
  registers: [metricsRegistry],
});

// Auth events counter
export const authEventsTotal = new Counter({
  name: "promofm_auth_events_total",
  help: "Total authentication events",
  labelNames: ["event", "result"],
  registers: [metricsRegistry],
});

// Payment events counter
export const paymentEventsTotal = new Counter({
  name: "promofm_payment_events_total",
  help: "Total payment events",
  labelNames: ["gateway", "type", "status"],
  registers: [metricsRegistry],
});

/**
 * Hono middleware: track request metrics
 */
export function metricsMiddleware() {
  return async (c: any, next: any) => {
    activeConnections.inc();
    const start = Date.now();

    await next();

    const duration = (Date.now() - start) / 1000;
    const method = c.req.method;
    // Normalize path to avoid high cardinality (replace UUIDs, IDs)
    const rawPath = c.req.path;
    const path = rawPath
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
      .replace(/\/\d+/g, "/:num");
    const statusCode = String(c.res.status);

    httpRequestsTotal.inc({ method, path, status_code: statusCode });
    httpRequestDuration.observe({ method, path, status_code: statusCode }, duration);
    activeConnections.dec();
  };
}
