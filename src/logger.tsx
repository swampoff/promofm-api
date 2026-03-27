import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  transport: isDev ? { target: "pino-pretty", options: { colorize: true } } : undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: "promofm-api",
    version: "3.0.0-vps",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redact sensitive fields
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "password",
      "password_hash",
      "token",
      "secret",
    ],
    censor: "[REDACTED]",
  },
});

// Child logger for specific modules
export function createLogger(module: string) {
  return logger.child({ module });
}
