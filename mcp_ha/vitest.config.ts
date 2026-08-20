import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/mcp/tools/testkit.ts", "src/types.ts", "src/context.ts"],
      // Guard rails, not vanity metrics (audit E9): they exist so a whole
      // layer can never silently drop to zero again, like index.ts did.
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 70,
      },
    },
  },
});
