import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerAddonTools } from "./addons.js";
import { setLogLevel } from "../../logger.js";
import { callTool, fakeCtx, fakeServer } from "./testkit.test.js";

beforeAll(() => setLogLevel("fatal"));

describe("ha_get_addons", () => {
  it("rejects a malicious slug before any Supervisor call", async () => {
    const { server, tools } = fakeServer();
    const supervisorGet = vi.fn();
    registerAddonTools(server, fakeCtx({ http: { supervisorGet } }));
    const res = await callTool(tools, "ha_get_addons", { slug: "../core/info" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("invalid slug");
    expect(supervisorGet).not.toHaveBeenCalled();
  });

  it("maps the add-on list to a compact projection", async () => {
    const { server, tools } = fakeServer();
    const http = {
      supervisorGet: vi.fn(async () => ({
        addons: [
          { slug: "core_mosquitto", name: "Mosquitto", version: "6.5.2", version_latest: "6.5.2", update_available: false, state: "started", extra: "dropped" },
        ],
      })),
    };
    registerAddonTools(server, fakeCtx({ http }));
    const res = await callTool(tools, "ha_get_addons", {});
    expect(res.data.total).toBe(1);
    expect(res.data.items[0]).toEqual({
      slug: "core_mosquitto",
      name: "Mosquitto",
      version: "6.5.2",
      update_available: false,
      state: "started",
    });
  });

  it("returns the details of one add-on by slug", async () => {
    const { server, tools } = fakeServer();
    const http = {
      supervisorGet: vi.fn(async (path: string) => {
        expect(path).toBe("/addons/core_mosquitto/info");
        return { slug: "core_mosquitto", name: "Mosquitto", description: "MQTT broker", version: "6.5.2", version_latest: "6.6.0", update_available: true, state: "started", boot: "auto", webui: null };
      }),
    };
    registerAddonTools(server, fakeCtx({ http }));
    const res = await callTool(tools, "ha_get_addons", { slug: "core_mosquitto" });
    expect(res.data).toMatchObject({ slug: "core_mosquitto", update_available: true, boot: "auto" });
  });

  it("surfaces the dev-mode error cleanly", async () => {
    const { server, tools } = fakeServer();
    const http = {
      supervisorGet: vi.fn(async () => {
        throw new Error("Supervisor API is not available outside the add-on environment (dev mode)");
      }),
    };
    registerAddonTools(server, fakeCtx({ http }));
    const res = await callTool(tools, "ha_get_addons", {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("dev mode");
  });
});
