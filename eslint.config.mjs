import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // This app loads all data via fetch-on-mount effects (no data-fetching
      // library) and reads browser-only state (localStorage) in mount effects,
      // which is only safe after hydration. The React Compiler's
      // set-state-in-effect rule flags every such effect as a false positive;
      // turning it off avoids contorting ~two dozen legitimate data effects.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
