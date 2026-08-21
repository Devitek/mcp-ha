import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit, disableAuditFile, enableAuditFile, flushAudit, getLogLevel, log, setLogLevel } from "./logger.js";

describe("setLogLevel", () => {
  afterEach(() => {
    setLogLevel("info");
    vi.restoreAllMocks();
  });

  it("accepts the HA level names and common aliases", () => {
    expect(setLogLevel("debug")).toBe("debug");
    expect(setLogLevel("WARNING")).toBe("warning");
    expect(setLogLevel("warn")).toBe("warning");
    expect(setLogLevel("err")).toBe("error");
  });

  it("keeps the current level on unknown input", () => {
    setLogLevel("notice");
    expect(setLogLevel("verbose")).toBe("notice");
    expect(getLogLevel()).toBe("notice");
  });

  it("suppresses messages below the threshold", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setLogLevel("warning");
    log.debug("hidden");
    log.info("hidden too");
    log.warning("visible");
    log.error("also visible");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[0]?.[0])).toContain("WARNING visible");
  });

  it("lets everything through at trace level", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setLogLevel("trace");
    log.trace("t");
    log.debug("d");
    log.fatal("f");
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe("persistent audit file (#91)", () => {
  let dir: string;

  afterEach(async () => {
    disableAuditFile();
    setLogLevel("info");
    vi.restoreAllMocks();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function freshDir(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "mcpha-audit-"));
    return dir;
  }

  it("mirrors audit lines to the file while keeping stdout", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const file = join(await freshDir(), "audit.log");
    enableAuditFile(file);
    audit({ tool: "ha_call_service", allowed: true, client: "writer" });
    audit({ tool: "ha_call_service", allowed: false });
    await flushAudit();
    const lines = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ audit: true, tool: "ha_call_service", allowed: true, client: "writer" });
    expect(spy).toHaveBeenCalledTimes(2); // stdout behaviour unchanged
  });

  it("rotates by size and keeps exactly one previous file", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const file = join(await freshDir(), "audit.log");
    // Each line weighs ~60 bytes: the third write must rotate.
    enableAuditFile(file, 150);
    audit({ n: 1 });
    audit({ n: 2 });
    audit({ n: 3 });
    await flushAudit();
    const current = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l).n);
    const rotated = (await readFile(`${file}.1`, "utf8")).trim().split("\n").map((l) => JSON.parse(l).n);
    expect(rotated).toEqual([1, 2]);
    expect(current).toEqual([3]);
    // A second rotation replaces the previous .1 instead of piling up files.
    audit({ n: 4 });
    audit({ n: 5 });
    await flushAudit();
    const rotated2 = (await readFile(`${file}.1`, "utf8")).trim().split("\n").map((l) => JSON.parse(l).n);
    expect(rotated2).toEqual([3, 4]);
  });

  it("never throws when the file is unwritable and warns exactly once", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setLogLevel("warning");
    enableAuditFile("/nonexistent-mcpha-dir/sub/audit.log");
    audit({ n: 1 });
    audit({ n: 2 });
    await flushAudit();
    const calls = spy.mock.calls.map((c) => String(c[0]));
    expect(calls.filter((l) => l.includes('"audit":true'))).toHaveLength(2); // stdout intact
    expect(calls.filter((l) => l.includes("audit lines stay on stdout only"))).toHaveLength(1);
  });
});
