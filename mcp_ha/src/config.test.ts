import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { getLogLevel, setLogLevel } from "./logger.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

const existsMock = vi.mocked(existsSync);
const readMock = vi.mocked(readFileSync);
const writeMock = vi.mocked(writeFileSync);
const renameMock = vi.mocked(renameSync);

const ENV_KEYS = ["SUPERVISOR_TOKEN", "MCP_API_TOKEN", "MCP_PORT", "MCP_ALLOW_WRITE", "LOG_LEVEL", "HA_URL", "HA_TOKEN"];

beforeAll(() => setLogLevel("fatal"));

beforeEach(() => {
  vi.clearAllMocks();
  existsMock.mockReturnValue(false);
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  setLogLevel("fatal");
});

function withOptions(content: string): void {
  existsMock.mockImplementation((p) => p === "/data/options.json");
  readMock.mockImplementation((p) => {
    if (p === "/data/options.json") return content;
    throw new Error(`unexpected read: ${String(p)}`);
  });
}

describe("loadConfig", () => {
  it("reads the add-on options and applies the log level", () => {
    withOptions(
      JSON.stringify({
        api_token: "user-token-long-enough",
        allow_write: true,
        filter_reads: true,
        log_level: "debug",
        entity_allowlist: ["light.*"],
        entity_denylist: ["lock.*"],
        service_denylist: ["hassio.*"],
      })
    );
    const cfg = loadConfig();
    expect(cfg).toMatchObject({
      apiToken: "user-token-long-enough",
      apiTokenGenerated: false,
      allowWrite: true,
      filterReads: true,
      entityAllowlist: ["light.*"],
      entityDenylist: ["lock.*"],
      serviceDenylist: ["hassio.*"],
    });
    expect(getLogLevel()).toBe("debug");
  });

  it("uses safe defaults when no options file exists", () => {
    process.env.MCP_API_TOKEN = "env-token-long-enough";
    const cfg = loadConfig();
    expect(cfg.allowWrite).toBe(false);
    expect(cfg.filterReads).toBe(false);
    expect(cfg.apiToken).toBe("env-token-long-enough");
    expect(cfg.port).toBe(9583);
    expect(cfg.supervisorToken).toBeNull();
    // v0.2: locks and alarms require confirmation out of the box.
    expect(cfg.confirmDomains).toEqual(["lock", "alarm_control_panel"]);
  });

  it("falls back to defaults when options.json is corrupted (audit F7)", () => {
    // JSON.parse("null") succeeds: without validation this used to crash
    // outside the catch and loop the add-on.
    withOptions("null");
    process.env.MCP_API_TOKEN = "env-token-long-enough";
    const cfg = loadConfig();
    expect(cfg.allowWrite).toBe(false);
    expect(cfg.entityDenylist).toEqual([]);
  });

  it("falls back to defaults on wrongly typed values (audit B4)", () => {
    withOptions(JSON.stringify({ allow_write: "yes", entity_denylist: "lock.*", log_level: 3 }));
    process.env.MCP_API_TOKEN = "env-token-long-enough";
    const cfg = loadConfig();
    expect(cfg.allowWrite).toBe(false);
    expect(cfg.entityDenylist).toEqual([]);
  });

  it("rejects an out-of-range MCP_PORT (audit B4)", () => {
    process.env.MCP_API_TOKEN = "env-token-long-enough";
    process.env.MCP_PORT = "not-a-port";
    expect(loadConfig().port).toBe(9583);
    process.env.MCP_PORT = "70000";
    expect(loadConfig().port).toBe(9583);
  });

  it("warns loudly about a brute-forceable short token (audit D3)", () => {
    setLogLevel("error");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    withOptions(JSON.stringify({ api_token: "1234" }));
    const cfg = loadConfig();
    expect(cfg.apiToken).toBe("1234");
    expect(spy.mock.calls.map((c) => String(c[0])).some((l) => l.includes("brute-forceable"))).toBe(true);
    spy.mockRestore();
  });

  it("generates and persists a 32-byte token atomically (audit F6)", () => {
    const cfg = loadConfig();
    expect(cfg.apiTokenGenerated).toBe(true);
    expect(cfg.apiToken).toMatch(/^[0-9a-f]{64}$/);
    expect(writeMock).toHaveBeenCalledWith("/data/token.tmp", cfg.apiToken, { mode: 0o600 });
    expect(renameMock).toHaveBeenCalledWith("/data/token.tmp", "/data/token");
  });

  it("reloads a previously generated token from /data/token", () => {
    existsMock.mockImplementation((p) => p === "/data/token");
    readMock.mockImplementation((p) => {
      if (p === "/data/token") return "persisted-token\n";
      throw new Error(`unexpected read: ${String(p)}`);
    });
    const cfg = loadConfig();
    expect(cfg.apiToken).toBe("persisted-token");
    expect(cfg.apiTokenGenerated).toBe(true);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("never logs the full API token, only a masked prefix", () => {
    // The security regression test for issue #39: whatever the path
    // (generation here), the raw token must not reach the logs.
    setLogLevel("info");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cfg = loadConfig();
    const logged = spy.mock.calls.map((c) => String(c[0]));
    expect(cfg.apiToken).toMatch(/^[0-9a-f]{64}$/);
    expect(logged.some((l) => l.includes(cfg.apiToken))).toBe(false);
    expect(logged.some((l) => l.includes(`${cfg.apiToken.slice(0, 8)}**********`))).toBe(true);
    spy.mockRestore();
  });

  it("honours environment overrides", () => {
    process.env.MCP_API_TOKEN = "x".repeat(20);
    process.env.MCP_PORT = "1234";
    process.env.MCP_ALLOW_WRITE = "true";
    process.env.SUPERVISOR_TOKEN = "sup";
    process.env.LOG_LEVEL = "warning";
    const cfg = loadConfig();
    expect(cfg.port).toBe(1234);
    expect(cfg.allowWrite).toBe(true);
    expect(cfg.supervisorToken).toBe("sup");
    expect(getLogLevel()).toBe("warning");
  });
});
