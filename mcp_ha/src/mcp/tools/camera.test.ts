import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCameraTools } from "./camera.js";
import { setLogLevel } from "../../logger.js";
import { fakeCtx, fakeServer } from "./testkit.js";

beforeAll(() => setLogLevel("fatal"));

let consoleSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function auditLines(): any[] {
  return consoleSpy.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((line: string) => line.includes('"audit":true'))
    .map((line: string) => JSON.parse(line));
}

const IMG = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), contentType: "image/jpeg" };

describe("ha_get_camera_snapshot (#86)", () => {
  it("is not registered without allow_camera", () => {
    const { server, tools } = fakeServer();
    registerCameraTools(server, fakeCtx({ cfg: { allowCamera: false } }));
    expect(tools.size).toBe(0);
  });

  it("returns an image content and audits the snapshot", async () => {
    const { server, tools } = fakeServer();
    const coreGetBinary = vi.fn(async () => IMG);
    registerCameraTools(server, fakeCtx({ cfg: { allowCamera: true }, http: { coreGetBinary }, client: "kiosk" }));
    const res = await tools.get("ha_get_camera_snapshot")!.handler({ entity_id: "camera.front" });
    expect(res.content[0]).toEqual({ type: "image", data: IMG.buffer.toString("base64"), mimeType: "image/jpeg" });
    expect(coreGetBinary).toHaveBeenCalledWith("/camera_proxy/camera.front", expect.any(Number));
    expect(auditLines()).toContainEqual(expect.objectContaining({ client: "kiosk", tool: "ha_get_camera_snapshot", allowed: true }));
  });

  it("rejects a non-camera entity_id", async () => {
    const { server, tools } = fakeServer();
    registerCameraTools(server, fakeCtx({ cfg: { allowCamera: true }, http: { coreGetBinary: vi.fn() } }));
    const res = await tools.get("ha_get_camera_snapshot")!.handler({ entity_id: "light.kitchen" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text?: string }).text).toContain("camera.*");
  });

  it("respects filter_reads and audits the refusal", async () => {
    const { server, tools } = fakeServer();
    const coreGetBinary = vi.fn();
    registerCameraTools(
      server,
      fakeCtx({ cfg: { allowCamera: true, filterReads: true, entityDenylist: ["camera.*"] }, http: { coreGetBinary } })
    );
    const res = await tools.get("ha_get_camera_snapshot")!.handler({ entity_id: "camera.bedroom" });
    expect(res.isError).toBe(true);
    expect(coreGetBinary).not.toHaveBeenCalled();
    expect(auditLines()).toContainEqual(expect.objectContaining({ allowed: false, reason: "filter_reads" }));
  });
});
