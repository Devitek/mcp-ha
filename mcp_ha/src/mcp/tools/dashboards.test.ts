import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerDashboardTools } from "./dashboards.js";
import { setLogLevel } from "../../logger.js";
import { callTool, fakeCtx, fakeServer } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));

describe("ha_list_dashboards (#129)", () => {
  function setup() {
    const { server, tools } = fakeServer();
    const ws = {
      send: vi.fn(async (type: string, payload: any) => {
        if (type === "lovelace/dashboards/list")
          return [
            { url_path: "mobile", title: "Mobile", mode: "storage" },
            { url_path: "wall", title: "Wall", mode: "yaml" },
          ];
        if (type === "lovelace/config" && payload.url_path === null)
          return {
            views: [
              { title: "Home", path: "home", cards: [{}, {}] },
              { title: "Salon", type: "sections", sections: [{ type: "grid", cards: [{}] }, { type: "grid", cards: [{}, {}] }] },
            ],
          };
        return {};
      }),
    };
    registerDashboardTools(server, fakeCtx({ ws }));
    return { tools, ws };
  }

  it("lists dashboards with their editability", async () => {
    const { tools } = setup();
    const res = await callTool(tools, "ha_list_dashboards", {});
    expect(res.data.items[0]).toMatchObject({ url_path: "lovelace" });
    expect(res.data.items).toContainEqual(expect.objectContaining({ url_path: "mobile", editable: true }));
    expect(res.data.items).toContainEqual(expect.objectContaining({ url_path: "wall", editable: false }));
  });

  it("lists the views of one dashboard with layout and card counts", async () => {
    const { tools, ws } = setup();
    const res = await callTool(tools, "ha_list_dashboards", { dashboard: "lovelace" });
    expect(ws.send).toHaveBeenCalledWith("lovelace/config", { url_path: null });
    expect(res.data.views[0]).toEqual({ index: 0, title: "Home", path: "home", layout: "cards", cards: 2 });
    expect(res.data.views[1]).toMatchObject({ index: 1, layout: "sections", cards: 3 });
  });
});
