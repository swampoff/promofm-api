import { createLogger } from "./logger.tsx";

const log = createLogger("http");

// Generate short request ID (no uuid dependency needed)
function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Hono middleware: assigns X-Request-Id to each request,
 * logs request start/end with duration and status.
 */
export function requestIdMiddleware() {
  return async (c: any, next: any) => {
    const requestId = c.req.header("x-request-id") || generateRequestId();
    c.set("requestId", requestId);
    c.res.headers.set("X-Request-Id", requestId);

    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;
    const userId = c.get("userId") || "-";

    log.info({ requestId, method, path, userId }, "req_start");

    await next();

    const duration = Date.now() - start;
    const status = c.res.status;

    log.info({ requestId, method, path, status, duration, userId }, "req_end");
  };
}
