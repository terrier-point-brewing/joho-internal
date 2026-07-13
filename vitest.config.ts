import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, ".") },
  },
  test: {
    // app/finance/financials/buildTree.test.ts covers the pure buildTree()
    // helper, which is co-located with FinancialsTable.tsx under app/ (not
    // lib/) per its task brief -- widen include so it actually runs. Coverage
    // scope below stays lib/-only; the app/ addition doesn't affect the ratchet.
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
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
