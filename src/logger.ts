/**
 * Minimal leveled logger. Writes structured, timestamped lines to stdout/stderr.
 * Kept dependency-free on purpose so it can be used from anywhere, including
 * very early during startup before config is validated.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Allow lowering verbosity via LOG_LEVEL, default to "info".
const envLevel = (process.env.LOG_LEVEL || "info").toLowerCase() as LogLevel;
const threshold = LEVEL_ORDER[envLevel] ?? LEVEL_ORDER.info;

function emit(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  const line =
    meta === undefined ? `${prefix} ${message}` : `${prefix} ${message} ${safeJson(meta)}`;
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

function safeJson(value: unknown): string {
  try {
    if (value instanceof Error) {
      return JSON.stringify({ name: value.name, message: value.message, stack: value.stack });
    }
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const logger = {
  debug: (message: string, meta?: unknown) => emit("debug", message, meta),
  info: (message: string, meta?: unknown) => emit("info", message, meta),
  warn: (message: string, meta?: unknown) => emit("warn", message, meta),
  error: (message: string, meta?: unknown) => emit("error", message, meta),
};
