import { describe, expect, it } from "vitest";
import {
  allows,
  atLeast,
  CATEGORIES,
  gatedRegistrar,
  grantsFromConfig,
  TOOL_REGISTRY,
  toolCounts,
} from "./registry.js";
import { testCfg } from "./tools/testkit.js";

describe("tool registry (#165)", () => {
  it("declares 45 tools across the closed category list", () => {
    const entries = Object.entries(TOOL_REGISTRY);
    expect(entries).toHaveLength(45);
    for (const [name, entry] of entries) {
      expect(name).toMatch(/^ha_[a-z_]+$/);
      expect(CATEGORIES).toContain(entry.category);
      expect(["read", "write", "manage"]).toContain(entry.level);
    }
  });

  it("orders levels none < read < write < manage, inclusively", () => {
    expect(atLeast("manage", "write")).toBe(true);
    expect(atLeast("write", "read")).toBe(true);
    expect(atLeast("read", "write")).toBe(false);
    expect(atLeast("none", "read")).toBe(false);
  });

  it("never allows a tool missing from the registry", () => {
    const grants = grantsFromConfig(testCfg({ allowWrite: true, allowConfigWrite: true, allowCamera: true }), true);
    expect(allows(grants, "ha_made_up_tool")).toBe(false);
  });

  it("maps the option gates to the historical tool counts", () => {
    expect(toolCounts(grantsFromConfig(testCfg(), undefined))).toEqual({ read: 26, write: 0, total: 26 });
    expect(toolCounts(grantsFromConfig(testCfg({ allowCamera: true }), undefined))).toEqual({ read: 27, write: 0, total: 27 });
    expect(toolCounts(grantsFromConfig(testCfg({ allowWrite: true }), undefined))).toEqual({ read: 26, write: 10, total: 36 });
    expect(
      toolCounts(grantsFromConfig(testCfg({ allowWrite: true, allowConfigWrite: true, allowCamera: true }), undefined))
    ).toEqual({ read: 27, write: 18, total: 45 });
  });

  it("a read-scoped token gets no write tool even with every gate open", () => {
    const grants = grantsFromConfig(testCfg({ allowWrite: true, allowConfigWrite: true, allowCamera: true }), false);
    expect(toolCounts(grants)).toEqual({ read: 27, write: 0, total: 27 });
    expect(allows(grants, "ha_call_service")).toBe(false);
    expect(allows(grants, "ha_delete_automation")).toBe(false);
    expect(allows(grants, "ha_get_entity")).toBe(true);
  });

  it("manage includes write within its category: the documented #165 deviation", () => {
    // allow_config_write without allow_write: the old gates hid run/trigger/
    // set while allowing full config rewrites, an illusory boundary. The
    // hierarchy exposes those 3 runtime tools; nothing else changes.
    const grants = grantsFromConfig(testCfg({ allowConfigWrite: true }), undefined);
    expect(allows(grants, "ha_trigger_automation")).toBe(true);
    expect(allows(grants, "ha_run_script")).toBe(true);
    expect(allows(grants, "ha_call_service")).toBe(false);
    expect(allows(grants, "ha_create_helper")).toBe(false);
    expect(toolCounts(grants)).toEqual({ read: 26, write: 11, total: 37 });
  });

  it("gatedRegistrar registers exactly what the grants allow", () => {
    const seen: string[] = [];
    const fake = { registerTool: (name: string) => void seen.push(name) } as never;
    const gated = gatedRegistrar(fake, grantsFromConfig(testCfg({ allowWrite: true }), true));
    const reg = gated.registerTool as unknown as (n: string, m: unknown, h: unknown) => unknown;
    reg("ha_get_entity", {}, async () => ({}));
    reg("ha_call_service", {}, async () => ({}));
    reg("ha_delete_automation", {}, async () => ({}));
    reg("ha_unknown", {}, async () => ({}));
    expect(seen).toEqual(["ha_get_entity", "ha_call_service"]);
  });
});
