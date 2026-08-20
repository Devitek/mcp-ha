import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { getLogLevel, setLogLevel } from "./logger.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const existsMock = vi.mocked(existsSync);
const readMock = vi.mocked(readFileSync);
const writeMock = vi.mocked(writeFileSync);

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

function withOptions(options: Record<string, unknown>): void {
  existsMock.mockImplementation((p) => p === "/data/options.json");
  readMock.mockImplementation((p) => {
    if (p === "/data/options.json") return JSON.stringify(options);
    throw new Error(`unexpected read: ${String(p)}`);
  });
}

describe("loadConfig", () => {
  it("reads the add-on options and applies the log level", () => {
    withOptions({
      api_token: "user-token",
      allow_write: true,
      filter_reads: true,
      log_level: "debug",
      entity_allowlist: ["light.*"],
      entity_denylist: ["lock.*"],
      service_denylist: ["hassio.*"],
    });
    const cfg = loadConfig();
    expect(cfg).toMatchObject({
      apiToken: "user-token",
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
    process.env.MCP_API_TOKEN = "env-token";
    const cfg = loadConfig();
    expect(cfg.allowWrite).toBe(false);
    expect(cfg.filterReads).toBe(false);
    expect(cfg.apiToken).toBe("env-token");
    expect(cfg.port).toBe(9583);
    expect(cfg.supervisorToken).toBeNull();
  });

  it("generates and persists a 32-byte token when none is configured", () => {
    const cfg = loadConfig();
    expect(cfg.apiTokenGenerated).toBe(true);
    expect(cfg.apiToken).toMatch(/^[0-9a-f]{64}$/);
    expect(writeMock).toHaveBeenCalledWith("/data/token", cfg.apiToken, { mode: 0o600 });
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

  it("honours environment overrides", () => {
    process.env.MCP_API_TOKEN = "x";
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
