import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAnnounceTools, resetAnnounceLimiter } from "./announce.js";
import { setLogLevel } from "../../logger.js";
import { callTool, entity, fakeCtx, fakeServer, gatedBy } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));
beforeEach(() => resetAnnounceLimiter());

const fixtures = [
  entity("assist_satellite.kitchen", { name: "Kitchen satellite" }),
  entity("media_player.salon", { name: "Salon" }),
  entity("tts.piper", { name: "Piper" }),
];

function setup(over: any = {}) {
  const { server, tools } = fakeServer();
  const ws = { send: vi.fn(async () => ({ context: {} })) };
  registerAnnounceTools(
    server,
    fakeCtx({ cfg: { allowWrite: true, ...(over.cfg ?? {}) }, ws, catalog: { index: async () => over.entities ?? fixtures } })
  );
  return { tools, ws };
}

describe("ha_announce (#125)", () => {
  it("is absent without allow_write and for read-scoped tokens", () => {
    const a = fakeServer();
    registerAnnounceTools(gatedBy(a.server, { allowWrite: false }), fakeCtx({ cfg: { allowWrite: false } }));
    expect(a.tools.size).toBe(0);
    const b = fakeServer();
    registerAnnounceTools(gatedBy(b.server, { allowWrite: true }, false), fakeCtx({ cfg: { allowWrite: true }, canWrite: false }));
    expect(b.tools.size).toBe(0);
  });

  it("lists satellites, players and engines without a target", async () => {
    const { tools } = setup();
    const res = await callTool(tools, "ha_announce", { message: "hi" });
    expect(res.data.targets.assist_satellites).toEqual(["assist_satellite.kitchen"]);
    expect(res.data.targets.media_players).toEqual(["media_player.salon"]);
    expect(res.data.targets.tts_engines).toEqual(["tts.piper"]);
  });

  it("routes a satellite to its native announce", async () => {
    const { tools, ws } = setup();
    const res = await callTool(tools, "ha_announce", { message: "dinner is ready", target: "assist_satellite.kitchen" });
    expect(res.data.success).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(
      "call_service",
      expect.objectContaining({
        domain: "assist_satellite",
        service: "announce",
        target: { entity_id: "assist_satellite.kitchen" },
        service_data: { message: "dinner is ready" },
      })
    );
  });

  it("routes a media player through tts.speak with the auto-picked engine", async () => {
    const { tools, ws } = setup();
    await callTool(tools, "ha_announce", { message: "hello", target: "media_player.salon" });
    expect(ws.send).toHaveBeenCalledWith(
      "call_service",
      expect.objectContaining({
        domain: "tts",
        service: "speak",
        target: { entity_id: "tts.piper" },
        service_data: { media_player_entity_id: "media_player.salon", message: "hello" },
      })
    );
  });

  it("fails clearly on a media player without any TTS engine", async () => {
    const { tools } = setup({ entities: [entity("media_player.salon")] });
    const res = await callTool(tools, "ha_announce", { message: "x", target: "media_player.salon" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("no TTS engine");
  });

  it("caps at 3 per minute per target, dry runs excluded", async () => {
    const { tools } = setup();
    for (let i = 0; i < 4; i++) {
      await callTool(tools, "ha_announce", { message: "p", target: "assist_satellite.kitchen", dry_run: true });
    }
    for (let i = 0; i < 3; i++) {
      const ok = await callTool(tools, "ha_announce", { message: `n${i}`, target: "assist_satellite.kitchen" });
      expect(ok.isError).toBe(false);
    }
    const blocked = await callTool(tools, "ha_announce", { message: "n4", target: "assist_satellite.kitchen" });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("rate limited");
  });
});
