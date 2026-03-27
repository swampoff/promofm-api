import * as Sentry from "@sentry/node";

const SENTRY_DSN = process.env.SENTRY_DSN || "";

export function initSentry() {
  if (!SENTRY_DSN) {
    console.log("[Sentry] No SENTRY_DSN configured — error tracking disabled");
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || "production",
    release: "promofm-api@3.0.0-vps",
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    beforeSend(event) {
      const statusCode = event.extra?.statusCode;
      if (statusCode && typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
        return null;
      }
      return event;
    },
  });

  console.log("[Sentry] Initialized with environment:", process.env.NODE_ENV || "production");
}

export function captureError(error: Error, context?: Record<string, any>) {
  if (!SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    if (context) {
      scope.setExtras(context);
    }
    Sentry.captureException(error);
  });
}

/**
 * Hono error handler middleware — captures unhandled errors to Sentry
 */
export function sentryErrorHandler() {
  return async (c: any, next: any) => {
    try {
      await next();
    } catch (error: any) {
      const requestId = c.get("requestId") || "-";
      captureError(error, {
        requestId,
        method: c.req.method,
        path: c.req.path,
        userId: c.get("userId"),
      });
      throw error; // Re-throw for Hono error handler
    }
  };
}
