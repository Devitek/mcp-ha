// Leveled logging on stderr (shown in the add-on Log tab) plus a structured
// audit trail. The threshold comes from the add-on option `log_level`.

export const LOG_LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  notice: 35,
  warning: 40,
  error: 50,
  fatal: 60,
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;

let threshold: number = LOG_LEVELS.info;
let currentLevel: LogLevel = "info";

/** Accepts the HA-style level names, plus a couple of common aliases. */
export function setLogLevel(level: string): LogLevel {
  const normalized = level.trim().toLowerCase().replace(/^warn$/, "warning").replace(/^err$/, "error");
  if (normalized in LOG_LEVELS) {
    currentLevel = normalized as LogLevel;
    threshold = LOG_LEVELS[currentLevel];
  }
  return currentLevel;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function emit(level: LogLevel, msg: string): void {
  if (LOG_LEVELS[level] < threshold) return;
  console.error(`[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`);
}

export const log = {
  trace: (msg: string): void => emit("trace", msg),
  debug: (msg: string): void => emit("debug", msg),
  info: (msg: string): void => emit("info", msg),
  notice: (msg: string): void => emit("notice", msg),
  warning: (msg: string): void => emit("warning", msg),
  error: (msg: string): void => emit("error", msg),
  fatal: (msg: string): void => emit("fatal", msg),
};

/**
 * Audit trail for write attempts: one JSON line per attempt, allowed or
 * refused. Emitted regardless of the log level, this is a security record,
 * not debug output. Never put secrets in here.
 */
export function audit(entry: Record<string, unknown>): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), audit: true, ...entry }));
}
