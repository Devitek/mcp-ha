import { describe, expect, it } from "vitest";
import { jsonResult, listEnvelope, MAX_RESPONSE_BYTES, timeWindow, toIso, trunc } from "./helpers.js";

describe("listEnvelope", () => {
  const items = Array.from({ length: 120 }, (_, i) => i);

  it("paginates with the expected counters", () => {
    const env = listEnvelope(items, 50, 0);
    expect(env.returned).toBe(50);
    expect(env.total).toBe(120);
    expect(env.has_more).toBe(true);
    expect(env.next_offset).toBe(50);
  });

  it("flags the end of the pagination", () => {
    const env = listEnvelope(items, 50, 100);
    expect(env.returned).toBe(20);
    expect(env.has_more).toBe(false);
    expect(env.next_offset).toBeUndefined();
  });

  it("caps limit at 200", () => {
    const big = Array.from({ length: 500 }, (_, i) => i);
    expect(listEnvelope(big, 9999, 0).returned).toBe(200);
  });
});

describe("jsonResult", () => {
  it("passes small responses through unchanged", () => {
    const r = jsonResult({ a: 1 });
    expect((r.content[0]?.text ?? "")).toBe('{"a":1}');
  });

  it("truncates oversized responses with a note", () => {
    const huge = { data: "x".repeat(MAX_RESPONSE_BYTES * 2) };
    const r = jsonResult(huge);
    const parsed = JSON.parse((r.content[0]?.text ?? ""));
    expect(parsed.truncated).toBe(true);
    expect(parsed.note).toContain("Refine");
  });

  it("measures the cap in real bytes, not UTF-16 units (audit B14)", () => {
    // 6000 emoji = 12000 UTF-16 units but ~24000 UTF-8 bytes: must truncate.
    const emoji = { data: "🏠".repeat(6000) };
    const parsed = JSON.parse((jsonResult(emoji).content[0]?.text ?? ""));
    expect(parsed.truncated).toBe(true);
    // The preview must not end on a lone surrogate half.
    expect(parsed.preview.at(-1)).not.toMatch(/[\uD800-\uDBFF]/);
  });
});

describe("timeWindow", () => {
  it("applies the default sliding window", () => {
    const w = timeWindow({}, 24, 168);
    const span = new Date(w.end).getTime() - new Date(w.start).getTime();
    expect(Math.round(span / 3_600_000)).toBe(24);
  });

  it("rejects an overly wide window", () => {
    expect(() => timeWindow({ hours: 720 }, 24, 168)).toThrow(/too wide/);
  });

  it("rejects invalid dates and empty windows", () => {
    expect(() => timeWindow({ start: "not a date" }, 24, 168)).toThrow(/ISO 8601/);
    expect(() =>
      timeWindow({ start: "2026-01-02T00:00:00Z", end: "2026-01-01T00:00:00Z" }, 24, 168)
    ).toThrow(/empty/);
  });
});

describe("toIso", () => {
  it("converts epoch seconds and milliseconds", () => {
    expect(toIso(1755648000)).toBe("2025-08-20T00:00:00.000Z");
    expect(toIso(1755648000000)).toBe("2025-08-20T00:00:00.000Z");
  });

  it("normalizes ISO strings and rejects the rest", () => {
    expect(toIso("2026-08-20T12:00:00+02:00")).toBe("2026-08-20T10:00:00.000Z");
    expect(toIso("not a date")).toBeNull();
    expect(toIso(undefined)).toBeNull();
  });
});

describe("trunc", () => {
  it("truncates while reporting the original size", () => {
    const t = trunc("a".repeat(600), 500);
    expect(t.length).toBeLessThan(600);
    expect(t).toContain("600 chars");
  });
});
