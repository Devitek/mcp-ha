import { defineConfig } from "drizzle-kit";

// Dev-only tooling (#166): `npx drizzle-kit generate` diffs src/db/schema.ts
// against the committed migrations in ./drizzle and writes the next SQL file.
// The runtime never loads this; store.ts applies the folder at boot.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
