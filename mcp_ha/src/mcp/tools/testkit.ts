// Shared helpers for the tool tests: a fake MCP server capturing tool
// registrations, a fake context, and a caller that parses ToolResult JSON.
// Excluded from the production build via tsconfig.json (it imports vitest),
// fully typechecked by tsconfig.test.json.
import { vi } from "vitest";
import type { AddonConfig } from "../../config.js";
import type { ToolContext } from "../../context.js";

export interface RegisteredTool {
  cfg: any;
  handler: (args: any) => Promise<any>;
}

export function fakeServer() {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, cfg: any, handler: any) => {
      tools.set(name, { cfg, handler });
    },
  } as any;
  return { server, tools };
}

export async function callTool(tools: Map<string, RegisteredTool>, name: string, args: any) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  const raw = await tool.handler(args);
  const text: string = raw.content[0].text;
  return {
    raw,
    isError: raw.isError === true,
    text,
    data: raw.isError ? null : JSON.parse(text),
  };
}

export function testCfg(partial: Partial<AddonConfig> = {}): AddonConfig {
  return {
    port: 9583,
    apiToken: "t",
    apiTokenGenerated: false,
    allowWrite: false,
    filterReads: false,
    entityAllowlist: [],
    entityDenylist: [],
    serviceDenylist: [],
    supervisorToken: null,
    devHaUrl: null,
    devHaToken: null,
    ...partial,
  };
}

export function fakeCtx(partial: any = {}): ToolContext {
  return {
    cfg: testCfg(partial.cfg ?? {}),
    ws: { send: vi.fn(async () => ({})), connected: true, ...(partial.ws ?? {}) },
    http: {
      coreGet: vi.fn(async () => ({})),
      coreGetText: vi.fn(async () => ""),
      corePostText: vi.fn(async () => ""),
      supervisorGet: vi.fn(async () => ({})),
      supervisorPost: vi.fn(async () => ({})),
      supervisorAvailable: true,
      ...(partial.http ?? {}),
    },
    catalog: {
      index: vi.fn(async () => []),
      registries: vi.fn(async () => ({ at: 0, areas: [], devices: [], entities: [] })),
      states: vi.fn(async () => []),
      invalidate: vi.fn(),
      ...(partial.catalog ?? {}),
    },
  } as unknown as ToolContext;
}

export function entity(id: string, over: Record<string, unknown> = {}) {
  return {
    entity_id: id,
    name: id,
    domain: id.split(".")[0] ?? "",
    state: "on",
    area: null,
    device_id: null,
    last_changed: "2026-01-01T00:00:00Z",
    hidden: false,
    category: null,
    attributes: {},
    ...over,
  };
}
