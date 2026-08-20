import { log } from "../logger.js";

/** Size cap for a tool response: the LLM context window is precious. */
export const MAX_RESPONSE_BYTES = 15_000;

export interface ListEnvelope<T> {
  items: T[];
  returned: number;
  total: number;
  has_more: boolean;
  next_offset?: number;
  note?: string;
}

/** Standard envelope for every list: pagination + counters. */
export function listEnvelope<T>(all: T[], limit = 50, offset = 0, note?: string): ListEnvelope<T> {
  const l = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const o = Math.max(Math.trunc(offset), 0);
  const items = all.slice(o, o + l);
  const consumed = o + items.length;
  return {
    items,
    returned: items.length,
    total: all.length,
    has_more: consumed < all.length,
    ...(consumed < all.length ? { next_offset: consumed } : {}),
    ...(note ? { note } : {}),
  };
}

/** Truncates a string while flagging the cut, never splitting a surrogate pair. */
export function trunc(s: unknown, max: number): string {
  const str = typeof s === "string" ? s : JSON.stringify(s) ?? "";
  if (str.length <= max) return str;
  let sliced = str.slice(0, max);
  const lastCode = sliced.charCodeAt(sliced.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) sliced = sliced.slice(0, -1);
  return `${sliced}… (truncated, ${str.length} chars)`;
}

export interface ToolResult {
  // Index signature required for assignability to the SDK CallToolResult.
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Serializes the result as compact JSON, capped at MAX_RESPONSE_BYTES (real bytes, audit B14). */
export function jsonResult(data: unknown): ToolResult {
  let text = JSON.stringify(data);
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    text = JSON.stringify({
      truncated: true,
      note: "Response too large, truncated. Refine with filters (domain, area, search, limit, shorter time window).",
      preview: trunc(text, MAX_RESPONSE_BYTES),
    });
  }
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Wraps a tool handler: clean errors, never a stack trace to the client. */
export function safe<A>(name: string, fn: (args: A) => Promise<unknown>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    log.debug(`Tool ${name} called`);
    log.trace(`Tool ${name} arguments: ${trunc(args, 500)}`);
    try {
      const data = await fn(args);
      return jsonResult(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warning(`Tool ${name} failed: ${msg}`);
      // The stack is the only way to locate a TypeError coming from an
      // unexpected HA payload (audit B6); debug level keeps it out of
      // normal logs.
      if (e instanceof Error && e.stack) log.debug(e.stack);
      return errorResult(msg);
    }
  };
}

export interface TimeWindow {
  start: string;
  end: string;
}

/**
 * Resolves a bounded time window from ISO start/end or a sliding number of
 * hours. Rejects invalid or overly wide windows.
 */
export function timeWindow(
  p: { start?: string | undefined; end?: string | undefined; hours?: number | undefined },
  defaultHours: number,
  maxHours: number
): TimeWindow {
  const end = p.end ? new Date(p.end) : new Date();
  const start = p.start
    ? new Date(p.start)
    : new Date(end.getTime() - (p.hours ?? defaultHours) * 3_600_000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("invalid dates, ISO 8601 expected (e.g. 2026-08-19T00:00:00Z)");
  }
  const spanHours = (end.getTime() - start.getTime()) / 3_600_000;
  if (spanHours <= 0) throw new Error("the time window is empty (start >= end)");
  if (spanHours > maxHours) {
    throw new Error(`time window too wide (${Math.round(spanHours)} h, maximum ${maxHours} h)`);
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

/** HA timestamp (epoch seconds or milliseconds, or ISO) to ISO 8601. */
export function toIso(v: unknown): string | null {
  if (typeof v === "number") {
    // Heuristic: an epoch in ms exceeds 1e12 until the year 33658.
    const ms = v > 1e12 ? v : v * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}
