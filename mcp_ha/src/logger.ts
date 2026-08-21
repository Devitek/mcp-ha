// Leveled logging on stderr (shown in the add-on Log tab) plus a structured
// audit trail. The threshold comes from the add-on option `log_level`.

import { appendFile, rename, stat } from "node:fs/promises";

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

// --- persistent audit sink (#91) ---
// stdout lines vanish on restart and drown in the regular log; a security
// journal deserves a file. Kept deliberately OUT of reach of MCP clients:
// no tool reads or clears it (an attacker would erase their traces), read
// it over SSH or the file editor add-on.

/** Per-file cap; one rotated sibling is kept, so disk use tops at ~2x. */
const AUDIT_MAX_BYTES = 1_000_000;

let auditPath: string | null = null;
let auditMaxBytes = AUDIT_MAX_BYTES;
/** Serializes writes so lines never interleave; keeps audit() non-blocking. */
let auditQueue: Promise<void> = Promise.resolve();
/** Tracked size of the current file; -1 = measure lazily on first write. */
let auditSize = -1;
let auditWarned = false;

/** Mirrors audit lines to a JSON-lines file with size rotation (#91). */
export function enableAuditFile(path: string, maxBytes: number = AUDIT_MAX_BYTES): void {
  auditPath = path;
  auditMaxBytes = maxBytes;
  auditSize = -1;
  auditWarned = false;
}

/** Test hooks: stop mirroring / wait for pending writes. */
export function disableAuditFile(): void {
  auditPath = null;
}
export function flushAudit(): Promise<void> {
  return auditQueue;
}

function appendAudit(line: string): void {
  if (!auditPath) return;
  const path = auditPath;
  auditQueue = auditQueue.then(async () => {
    try {
      if (auditSize < 0) auditSize = await stat(path).then((s) => s.size).catch(() => 0);
      const bytes = Buffer.byteLength(line) + 1;
      if (auditSize > 0 && auditSize + bytes > auditMaxBytes) {
        await rename(path, `${path}.1`); // replaces the previous .1
        auditSize = 0;
      }
      await appendFile(path, line + "\n");
      auditSize += bytes;
    } catch (e) {
      // Warn once, keep stdout as the source of truth, and keep trying:
      // /data may become writable again.
      if (!auditWarned) {
        auditWarned = true;
        log.warning(
          `Audit file ${path} is not writable (${e instanceof Error ? e.message : String(e)}); audit lines stay on stdout only.`
        );
      }
    }
  });
}

/**
 * Audit trail for write attempts: one JSON line per attempt, allowed or
 * refused. Emitted regardless of the log level, this is a security record,
 * not debug output. Never put secrets in here. Also mirrored to
 * /data/audit.log when running as an add-on (#91).
 */
export function audit(entry: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), audit: true, ...entry });
  console.error(line);
  appendAudit(line);
}
