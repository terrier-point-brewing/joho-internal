import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent tooling scripts (Node CommonJS), not app code.
    ".claude/**",
  ]),
  {
    // The .btn-* tiers own their padding, height and width (docs/UI_STANDARD.md §5).
    // Overriding the geometry is how buttons drift out of sync between pages — a fixed
    // width pads short labels with dead space, so the same action looks different from
    // one page to the next. `w-full` is the one sanctioned exception, for full-width
    // form submits. Catches string literals; a computed template literal can still slip
    // through, so this is a guard rail, not a proof.
    files: ["app/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'JSXAttribute[name.name="className"] > Literal[value=/\\bbtn-(primary|secondary|danger)\\b/][value=/\\b(min-w-|max-w-|h-[0-9]|px-|py-|p-[0-9]|w-(?!full\\b))/]',
          message:
            "Don't override a .btn-* tier's geometry (width/padding/height) — the tier owns it. Only `w-full` is allowed, for full-width form submits. See docs/UI_STANDARD.md §5.",
        },
      ],
    },
  },
]);

export default eslintConfig;
