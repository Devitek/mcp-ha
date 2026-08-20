import { log } from "../logger.js";

/** Plafond de taille d'une réponse d'outil : le contexte du LLM est précieux. */
export const MAX_RESPONSE_BYTES = 15_000;

export interface ListEnvelope<T> {
  items: T[];
  returned: number;
  total: number;
  has_more: boolean;
  next_offset?: number;
  note?: string;
}

/** Enveloppe standard de toutes les listes : pagination + compteurs. */
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

/** Tronque une chaîne en signalant la coupe. */
export function trunc(s: unknown, max: number): string {
  const str = typeof s === "string" ? s : JSON.stringify(s) ?? "";
  return str.length > max ? `${str.slice(0, max)}… (tronqué, ${str.length} car.)` : str;
}

export interface ToolResult {
  // Signature d'index requise pour être assignable au CallToolResult du SDK.
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Sérialise le résultat en JSON compact, plafonné à MAX_RESPONSE_BYTES. */
export function jsonResult(data: unknown): ToolResult {
  let text = JSON.stringify(data);
  if (text.length > MAX_RESPONSE_BYTES) {
    text = JSON.stringify({
      truncated: true,
      note: "Réponse trop volumineuse, tronquée. Affinez avec des filtres (domain, area, search, limit, fenêtre temporelle plus courte).",
      preview: text.slice(0, MAX_RESPONSE_BYTES),
    });
  }
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: `Erreur : ${message}` }], isError: true };
}

/** Enrobe un handler d'outil : erreurs propres, jamais de stack au client. */
export function safe<A>(name: string, fn: (args: A) => Promise<unknown>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      const data = await fn(args);
      return jsonResult(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`Outil ${name} en erreur : ${msg}`);
      return errorResult(msg);
    }
  };
}

export interface TimeWindow {
  start: string;
  end: string;
}

/**
 * Résout une fenêtre temporelle bornée à partir de start/end ISO ou d'un
 * nombre d'heures glissant. Rejette les fenêtres invalides ou trop larges.
 */
export function timeWindow(
  p: { start?: string; end?: string; hours?: number },
  defaultHours: number,
  maxHours: number
): TimeWindow {
  const end = p.end ? new Date(p.end) : new Date();
  const start = p.start
    ? new Date(p.start)
    : new Date(end.getTime() - (p.hours ?? defaultHours) * 3_600_000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("dates invalides, format ISO 8601 attendu (ex. 2026-08-19T00:00:00Z)");
  }
  const spanHours = (end.getTime() - start.getTime()) / 3_600_000;
  if (spanHours <= 0) throw new Error("la fenêtre temporelle est vide (start >= end)");
  if (spanHours > maxHours) {
    throw new Error(`fenêtre trop large (${Math.round(spanHours)} h, maximum ${maxHours} h)`);
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Timestamp HA (secondes ou millisecondes epoch, ou ISO) vers ISO 8601. */
export function toIso(v: unknown): string | null {
  if (typeof v === "number") {
    // Heuristique : avant l'an 33658 en secondes, un epoch ms dépasse 1e12.
    const ms = v > 1e12 ? v : v * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}
