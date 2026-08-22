import { describe, expect, it } from "vitest";
import { UsageTracker } from "./usage.js";

describe("UsageTracker (#128)", () => {
  it("counts tools/call messages, objects and batches alike", () => {
    const u = new UsageTracker();
    u.recordBody({ method: "tools/call", params: { name: "ha_get_entity" } }, "default");
    u.recordBody(
      [
        { method: "tools/call", params: { name: "ha_get_entity" } },
        { method: "tools/list" },
        { method: "tools/call", params: { name: "ha_call_service" } },
      ],
      "writer"
    );
    const s = u.snapshot();
    expect(s.total).toBe(3);
    expect(s.top_tools[0]).toEqual({ tool: "ha_get_entity", calls: 2 });
    expect(s.by_client).toContainEqual({ client: "writer", calls: 2 });
  });

  it("ignores non tool calls and bounds cardinality", () => {
    const u = new UsageTracker();
    u.recordBody({ method: "initialize" }, "x");
    expect(u.snapshot().total).toBe(0);
    for (let i = 0; i < 300; i++) u.record(`garbage_${i}`, "x");
    expect(u.snapshot().total).toBe(300);
    // the map stopped growing at the cap, known keys still count
    u.record("garbage_0", "x");
    expect(u.snapshot().top_tools[0]).toEqual({ tool: "garbage_0", calls: 2 });
  });
});
