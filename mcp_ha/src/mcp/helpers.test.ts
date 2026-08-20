import { describe, expect, it } from "vitest";
import { jsonResult, listEnvelope, MAX_RESPONSE_BYTES, timeWindow, toIso, trunc } from "./helpers.js";

describe("listEnvelope", () => {
  const items = Array.from({ length: 120 }, (_, i) => i);

  it("pagine avec les compteurs attendus", () => {
    const env = listEnvelope(items, 50, 0);
    expect(env.returned).toBe(50);
    expect(env.total).toBe(120);
    expect(env.has_more).toBe(true);
    expect(env.next_offset).toBe(50);
  });

  it("signale la fin de la pagination", () => {
    const env = listEnvelope(items, 50, 100);
    expect(env.returned).toBe(20);
    expect(env.has_more).toBe(false);
    expect(env.next_offset).toBeUndefined();
  });

  it("plafonne limit à 200", () => {
    const big = Array.from({ length: 500 }, (_, i) => i);
    expect(listEnvelope(big, 9999, 0).returned).toBe(200);
  });
});

describe("jsonResult", () => {
  it("laisse passer les petites réponses telles quelles", () => {
    const r = jsonResult({ a: 1 });
    expect(r.content[0].text).toBe('{"a":1}');
  });

  it("tronque les réponses trop volumineuses avec une note", () => {
    const huge = { data: "x".repeat(MAX_RESPONSE_BYTES * 2) };
    const r = jsonResult(huge);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.truncated).toBe(true);
    expect(parsed.note).toContain("Affinez");
  });
});

describe("timeWindow", () => {
  it("applique la fenêtre glissante par défaut", () => {
    const w = timeWindow({}, 24, 168);
    const span = new Date(w.end).getTime() - new Date(w.start).getTime();
    expect(Math.round(span / 3_600_000)).toBe(24);
  });

  it("rejette une fenêtre trop large", () => {
    expect(() => timeWindow({ hours: 720 }, 24, 168)).toThrow(/trop large/);
  });

  it("rejette les dates invalides et les fenêtres vides", () => {
    expect(() => timeWindow({ start: "n'importe quoi" }, 24, 168)).toThrow(/ISO 8601/);
    expect(() =>
      timeWindow({ start: "2026-01-02T00:00:00Z", end: "2026-01-01T00:00:00Z" }, 24, 168)
    ).toThrow(/vide/);
  });
});

describe("toIso", () => {
  it("convertit les secondes et millisecondes epoch", () => {
    expect(toIso(1755648000)).toBe("2025-08-20T00:00:00.000Z");
    expect(toIso(1755648000000)).toBe("2025-08-20T00:00:00.000Z");
  });

  it("normalise les chaînes ISO et rejette le reste", () => {
    expect(toIso("2026-08-20T12:00:00+02:00")).toBe("2026-08-20T10:00:00.000Z");
    expect(toIso("pas une date")).toBeNull();
    expect(toIso(undefined)).toBeNull();
  });
});

describe("trunc", () => {
  it("tronque en indiquant la taille d'origine", () => {
    const t = trunc("a".repeat(600), 500);
    expect(t.length).toBeLessThan(600);
    expect(t).toContain("600 car.");
  });
});
