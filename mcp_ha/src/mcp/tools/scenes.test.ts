import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerSceneTools } from "./scenes.js";
import { setLogLevel } from "../../logger.js";
import { callTool, entity, fakeCtx, fakeServer, gatedBy } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));

function setup(over: any = {}) {
  const { server, tools } = fakeServer();
  const ws = { send: vi.fn(async () => ({ context: {} })) };
  registerSceneTools(
    server,
    fakeCtx({ cfg: { allowWrite: true, ...(over.cfg ?? {}) }, ws, catalog: { index: async () => over.entities ?? [] } })
  );
  return { tools, ws };
}

describe("ha_snapshot_scene (#110)", () => {
  it("is absent without allow_write and for read-scoped tokens", () => {
    const a = fakeServer();
    registerSceneTools(gatedBy(a.server, { allowWrite: false }), fakeCtx({ cfg: { allowWrite: false } }));
    expect(a.tools.size).toBe(0);
    const b = fakeServer();
    registerSceneTools(gatedBy(b.server, { allowWrite: true }, false), fakeCtx({ cfg: { allowWrite: true }, canWrite: false }));
    expect(b.tools.size).toBe(0);
  });

  it("captures the given entities under a slugified scene id and explains volatility", async () => {
    const { tools, ws } = setup();
    const res = await callTool(tools, "ha_snapshot_scene", {
      name: "Soirée cinéma",
      entities: ["light.living_room", "media_player.tv"],
    });
    expect(ws.send).toHaveBeenCalledWith(
      "call_service",
      expect.objectContaining({
        domain: "scene",
        service: "create",
        service_data: { scene_id: "soiree_cinema", snapshot_entities: ["light.living_room", "media_player.tv"] },
      })
    );
    expect(res.data.scene).toBe("scene.soiree_cinema");
    expect(res.data.note).toContain("Volatile");
  });

  it("honours the entity lists on what is capturable", async () => {
    const { tools, ws } = setup({ cfg: { entityDenylist: ["camera.*"] } });
    const res = await callTool(tools, "ha_snapshot_scene", { name: "Spy", entities: ["camera.front"] });
    expect(res.isError).toBe(true);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an existing scene (creation only)", async () => {
    const { tools, ws } = setup({ entities: [entity("scene.soiree_cinema")] });
    const res = await callTool(tools, "ha_snapshot_scene", { name: "Soirée cinéma", entities: ["light.a"] });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("already exists");
    expect(ws.send).not.toHaveBeenCalled();
  });
});
