import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerPresenceTools } from "./presence.js";
import { setLogLevel } from "../../logger.js";
import { callTool, entity, fakeCtx, fakeServer } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));

const fixtures = [
  entity("person.thomas", {
    name: "Thomas",
    state: "home",
    last_changed: "2026-08-22T07:00:00Z",
    attributes: { latitude: 48.85, longitude: 2.35, source: "device_tracker.pixel" },
  }),
  entity("person.guest", { name: "Guest", state: "not_home" }),
  entity("zone.home", { name: "Home", state: "1" }),
  entity("zone.work", { name: "Work", state: "0" }),
  entity("light.kitchen"),
];

function setup(over: any = {}) {
  const { server, tools } = fakeServer();
  const ws = {
    send: vi.fn(async () => ({
      "person.thomas": [
        { s: "not_home", lu: 1755648000 },
        { s: "home", lu: 1755680000 },
      ],
      "person.guest": [{ s: "not_home", lu: 1755648000 }],
    })),
  };
  registerPresenceTools(server, fakeCtx({ cfg: over.cfg ?? {}, ws, catalog: { index: async () => fixtures } }));
  return { tools, ws };
}

describe("ha_get_presence (#112)", () => {
  it("summarizes people, zones with occupant counts, and the zone timeline", async () => {
    const { tools, ws } = setup();
    const res = await callTool(tools, "ha_get_presence", {});
    expect(res.data.people).toContainEqual({ entity_id: "person.thomas", name: "Thomas", zone: "home", since: "2026-08-22T07:00:00Z" });
    expect(res.data.zones).toContainEqual({ entity_id: "zone.home", name: "Home", persons: 1 });
    expect(res.data.timeline["person.thomas"].map((t: any) => t.zone)).toEqual(["not_home", "home"]);
    expect(ws.send).toHaveBeenCalledWith(
      "history/history_during_period",
      expect.objectContaining({ entity_ids: ["person.thomas", "person.guest"], no_attributes: true })
    );
  });

  it("never exposes coordinates or tracker sources by design", async () => {
    const { tools } = setup();
    const res = await callTool(tools, "ha_get_presence", {});
    const raw = JSON.stringify(res.data);
    expect(raw).not.toContain("latitude");
    expect(raw).not.toContain("48.85");
    expect(raw).not.toContain("device_tracker");
  });

  it("hides filtered persons entirely", async () => {
    const { tools, ws } = setup({ cfg: { filterReads: true, entityDenylist: ["person.guest"] } });
    const res = await callTool(tools, "ha_get_presence", {});
    expect(res.data.people.map((p: any) => p.entity_id)).toEqual(["person.thomas"]);
    expect(ws.send).toHaveBeenCalledWith(
      "history/history_during_period",
      expect.objectContaining({ entity_ids: ["person.thomas"] })
    );
  });

  it("rejects windows beyond 7 days", async () => {
    const { tools } = setup();
    const res = await callTool(tools, "ha_get_presence", { hours: 200 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("too wide");
  });
});
