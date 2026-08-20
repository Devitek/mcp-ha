import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogLevel, log, setLogLevel } from "./logger.js";

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
