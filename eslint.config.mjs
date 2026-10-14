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
  {
    // Mobile / accessibility guard rails from docs/ui/MOBILE_REVIEW.md. Warn-only:
    // the existing code is not swept here, but new code should not add to it.
    files: ["app/**/*.tsx"],
    // PageHeader is where the one sanctioned <h2> lives.
    ignores: ["app/components/PageHeader.tsx"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            'JSXOpeningElement[name.name="input"]:has(JSXAttribute[name.name="type"] > Literal[value="number"]):not(:has(JSXAttribute[name.name="inputMode"]))',
          message:
            'A numeric <input> needs `inputMode` ("decimal" or "numeric") so phones show a number keypad.',
        },
        {
          selector: 'CallExpression[callee.property.name=/^(confirm|alert)$/][callee.object.name="window"], CallExpression[callee.name=/^(confirm|alert)$/]',
          message:
            "Use <ConfirmDialog> / <Banner> instead of window.confirm / alert: themeable, testable, and not thread-blocking on iOS.",
        },
        {
          selector: 'JSXAttribute[name.name="className"] > Literal[value=/(^|\\s)grid-cols-([3-9]|1[0-9])(\\s|$)/]',
          message:
            "An unprefixed grid-cols-3+ squeezes to ~110px columns on a phone. Start at grid-cols-1/2 and add the wider count under sm:/md:.",
        },
        {
          selector: 'JSXOpeningElement[name.name=/^h[12]$/]',
          message:
            "Page titles come from <PageHeader> (docs/UI_STANDARD.md §4); raw <h1>/<h2> break the heading outline.",
        },
      ],
    },
  },
]);

export default eslintConfig;
