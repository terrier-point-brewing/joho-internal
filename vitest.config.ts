import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, ".") },
  },
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html"],
      include: ["lib/**/*.ts"],
      exclude: ["lib/**/*.test.ts", "lib/**/types.ts"],
      // Ratchet: never let coverage regress below the current floor.
      // Raise these toward 70 once the backfill PRs land (see Definition of Done).
      thresholds: {
        lines: 86,
        statements: 86,
        functions: 0, // raised after backfill
        branches: 0, // raised after backfill
      },
    },
  },
});
