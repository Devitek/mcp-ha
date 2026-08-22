import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerExplainTools } from "./explain.js";
import { setLogLevel } from "../../logger.js";
import { callTool, entity, fakeCtx, fakeServer } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));

const AT = "2026-08-22T03:00:00.000Z";

const fixtures = [
  entity("light.hallway", { name: "Hallway", last_changed: AT }),
  entity("automation.night_motion", { name: "Night motion", attributes: { id: "nm-1" } }),
  entity("binary_sensor.hall_motion", { name: "Hall motion" }),
  entity("person.thomas", { name: "Thomas", state: "home", attributes: { user_id: "abc123" } }),
];

function setup(logbookByEntity: Record<string, any[]>, cfgOver: any = {}) {
  const { server, tools } = fakeServer();
  const ws = {
    send: vi.fn(async (_type: string, payload: any) => logbookByEntity[payload.entity_ids[0]] ?? []),
  };
  registerExplainTools(server, fakeCtx({ cfg: cfgOver, ws, catalog: { index: async () => fixtures } }));
  return { tools, ws };
}

describe("ha_explain_event (#124)", () => {
  it("follows the context chain from the entity to the automation to its trigger", async () => {
    const { tools } = setup({
      "light.hallway": [
        {
          when: AT,
          entity_id: "light.hallway",
          state: "on",
          context_entity_id: "automation.night_motion",
          context_entity_id_name: "Night motion",
          context_domain: "light",
          context_service: "turn_on",
        },
      ],
      "automation.night_motion": [
        { when: AT, entity_id: "automation.night_motion", message: "triggered by state of binary_sensor.hall_motion" },
      ],
    });
    const res = await callTool(tools, "ha_explain_event", { entity_id: "light.hallway" });
    const chain = res.data.chain;
    expect(chain[0]).toMatchObject({ entity_id: "light.hallway", state: "on", via_service: "light.turn_on" });
    expect(chain[1]).toMatchObject({ caused_by: "automation.night_motion", name: "Night motion" });
    expect(chain[2]).toMatchObject({ entity_id: "automation.night_motion", message: expect.stringContaining("hall_motion") });
    expect(res.data.note).toContain("ha_get_automation_trace");
  });

  it("resolves the user to their person entity, no admin rights needed (#134)", async () => {
    const { tools } = setup({
      "light.hallway": [{ when: AT, entity_id: "light.hallway", state: "off", context_user_id: "abc123" }],
    });
    const res = await callTool(tools, "ha_explain_event", { entity_id: "light.hallway", at: AT });
    expect(res.data.chain[0]).toMatchObject({ user: "Thomas", person: "person.thomas", user_id: "abc123" });
    expect(res.data.chain[0].user_note).toBeUndefined();
  });

  it("keeps the raw id when no visible person matches", async () => {
    const { tools } = setup({
      "light.hallway": [{ when: AT, entity_id: "light.hallway", state: "off", context_user_id: "service-account-999" }],
    });
    const res = await callTool(tools, "ha_explain_event", { entity_id: "light.hallway", at: AT });
    expect(res.data.chain[0]).toMatchObject({ user_id: "service-account-999" });
    expect(res.data.chain[0].user).toBeUndefined();
    expect(res.data.chain[0].user_note).toContain("admin rights");
  });

  it("does not resolve a person hidden by filter_reads", async () => {
    const { tools } = setup(
      {
        "light.hallway": [{ when: AT, entity_id: "light.hallway", state: "off", context_user_id: "abc123" }],
      },
      { filterReads: true, entityDenylist: ["person.*"] }
    );
    const res = await callTool(tools, "ha_explain_event", { entity_id: "light.hallway", at: AT });
    expect(res.data.chain[0].user_id).toBe("abc123");
    expect(JSON.stringify(res.data)).not.toContain("Thomas");
  });

  it("answers honestly when nothing is recorded", async () => {
    const { tools } = setup({});
    const res = await callTool(tools, "ha_explain_event", { entity_id: "light.hallway" });
    expect(res.data.chain).toEqual([]);
    expect(res.data.note).toContain("No recorded cause");
  });

  it("anonymizes a hidden cause and stops the chain there", async () => {
    const { tools } = setup(
      {
        "light.hallway": [
          { when: AT, entity_id: "light.hallway", state: "on", context_entity_id: "automation.secret" },
        ],
      },
      { filterReads: true, entityDenylist: ["automation.secret"] }
    );
    const res = await callTool(tools, "ha_explain_event", { entity_id: "light.hallway" });
    expect(JSON.stringify(res.data.chain)).not.toContain("automation.secret");
    expect(res.data.chain.at(-1)).toMatchObject({ actor: "(hidden entity)" });
  });

  it("refuses hidden entities and invalid dates upfront", async () => {
    const { tools, ws } = setup({}, { filterReads: true, entityDenylist: ["light.*"] });
    const res = await callTool(tools, "ha_explain_event", { entity_id: "light.hallway" });
    expect(res.isError).toBe(true);
    expect(ws.send).not.toHaveBeenCalled();
    const { tools: t2 } = setup({});
    const bad = await callTool(t2, "ha_explain_event", { entity_id: "light.hallway", at: "not a date" });
    expect(bad.isError).toBe(true);
  });
});
