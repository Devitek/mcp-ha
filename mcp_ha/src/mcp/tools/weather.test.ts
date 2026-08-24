import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerWeatherTools } from "./weather.js";
import { setLogLevel } from "../../logger.js";
import { callTool, entity, fakeCtx, fakeServer } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));

const fixtures = [
  entity("weather.maison", {
    name: "Maison",
    state: "partlycloudy",
    attributes: { temperature_unit: "°C", precipitation_unit: "mm", wind_speed_unit: "km/h" },
  }),
  entity("light.kitchen"),
];

function setup(over: any = {}) {
  const { server, tools } = fakeServer();
  const ws = over.ws ?? {
    send: vi.fn(async () => ({
      response: {
        "weather.maison": {
          forecast: [
            { datetime: "2026-08-24T00:00:00Z", condition: "rainy", temperature: 19, templow: 12, precipitation: 4.2, precipitation_probability: 80, wind_speed: 22, extra_noise: "dropped" },
            { datetime: "2026-08-25T00:00:00Z", condition: "sunny", temperature: 24, templow: 14 },
          ],
        },
      },
    })),
  };
  registerWeatherTools(server, fakeCtx({ cfg: over.cfg ?? {}, ws, catalog: { index: async () => fixtures } }));
  return { tools, ws };
}

describe("ha_get_forecast (#140)", () => {
  it("lists weather entities without an id", async () => {
    const { tools } = setup();
    const res = await callTool(tools, "ha_get_forecast", {});
    expect(res.data.items).toEqual([{ entity_id: "weather.maison", name: "Maison", condition: "partlycloudy" }]);
  });

  it("fetches the daily forecast via get_forecasts return_response, projected with units", async () => {
    const { tools, ws } = setup();
    const res = await callTool(tools, "ha_get_forecast", { entity_id: "weather.maison" });
    expect(ws.send).toHaveBeenCalledWith("call_service", {
      domain: "weather",
      service: "get_forecasts",
      target: { entity_id: "weather.maison" },
      service_data: { type: "daily" },
      return_response: true,
    });
    expect(res.data.forecast[0]).toEqual({
      datetime: "2026-08-24T00:00:00Z",
      condition: "rainy",
      temperature: 19,
      templow: 12,
      precipitation: 4.2,
      precipitation_probability: 80,
      wind_speed: 22,
    });
    expect(res.data.units).toEqual({ temperature: "°C", precipitation: "mm", wind_speed: "km/h" });
  });

  it("caps hourly forecasts at 48 entries with a note", async () => {
    const big = Array.from({ length: 72 }, (_, i) => ({ datetime: `t${i}`, condition: "sunny", temperature: 20 }));
    const { tools, ws } = setup({ ws: { send: vi.fn(async () => ({ response: { "weather.maison": { forecast: big } } })) } });
    const res = await callTool(tools, "ha_get_forecast", { entity_id: "weather.maison", type: "hourly" });
    expect((ws.send as any).mock.calls[0][1].service_data).toEqual({ type: "hourly" });
    expect(res.data.forecast).toHaveLength(48);
    expect(res.data.total).toBe(72);
    expect(res.data.note).toContain("48");
  });

  it("relays provider errors and honours filter_reads", async () => {
    const { tools } = setup({ ws: { send: vi.fn(async () => { throw new Error("Forecast type twice_daily is not supported"); }) } });
    const err = await callTool(tools, "ha_get_forecast", { entity_id: "weather.maison", type: "twice_daily" });
    expect(err.isError).toBe(true);
    expect(err.text).toContain("not supported");
    const { tools: t2, ws: ws2 } = setup({ cfg: { filterReads: true, entityDenylist: ["weather.*"] } });
    const hidden = await callTool(t2, "ha_get_forecast", { entity_id: "weather.maison" });
    expect(hidden.isError).toBe(true);
    expect(ws2.send).not.toHaveBeenCalled();
  });
});
