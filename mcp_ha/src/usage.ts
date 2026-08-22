/**
 * In-memory usage counters (#128): "what has my assistant been doing?".
 * Counted at the HTTP handler on every tools/call, so no tool path can be
 * forgotten; displayed on the ingress page. Deliberately not persisted:
 * restart resets to zero, the persistent audit log covers write history.
 */
export class UsageTracker {
  /** Cardinality guard: garbage tool names cannot grow the maps unbounded. */
  private static readonly MAX_KEYS = 200;

  private byTool = new Map<string, number>();
  private byClient = new Map<string, number>();
  total = 0;

  record(tool: string, client: string): void {
    this.total++;
    if (this.byTool.has(tool) || this.byTool.size < UsageTracker.MAX_KEYS) {
      this.byTool.set(tool, (this.byTool.get(tool) ?? 0) + 1);
    }
    if (this.byClient.has(client) || this.byClient.size < UsageTracker.MAX_KEYS) {
      this.byClient.set(client, (this.byClient.get(client) ?? 0) + 1);
    }
  }

  /** Counts the tools/call messages of a JSON-RPC body (object or batch). */
  recordBody(body: unknown, client: string): void {
    for (const m of Array.isArray(body) ? body : [body]) {
      const msg = m as { method?: string; params?: { name?: unknown } } | null;
      if (msg?.method === "tools/call") {
        this.record(String(msg.params?.name ?? "unknown"), client);
      }
    }
  }

  snapshot(): { total: number; top_tools: Array<{ tool: string; calls: number }>; by_client: Array<{ client: string; calls: number }> } {
    return {
      total: this.total,
      top_tools: [...this.byTool.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([tool, calls]) => ({ tool, calls })),
      by_client: [...this.byClient.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([client, calls]) => ({ client, calls })),
    };
  }
}
