import type { RoleName } from "./canon.types";

// Maps the internal ops-chrome color tokens (app/globals.css @theme, the dark
// zinc/amber system) onto brand roles. When "brand chrome" is enabled, the
// ops --color-* values are overridden with the brand's DARK palette (the app
// is dark-only), so the whole internal UI wears Joho without touching a single
// component — every ops component already binds to these semantic tokens.
//
// Status colors (danger / success / info) are deliberately NOT mapped: red /
// green / blue must keep their meaning. Accent maps to brand PRIMARY (indigo),
// not the brand accent (Seal Red), because the brand caps Seal Red at ≤5% of a
// composition — it can't be the app-wide accent.
export const OPS_TO_BRAND_ROLE: Record<string, RoleName> = {
  canvas: "canvas",
  surface: "surface",
  "surface-mid": "surface-raised",
  "surface-high": "line-strong",
  line: "line",
  "line-strong": "line-strong",
  "line-subtle": "line-strong",
  "text-primary": "high-contrast",
  "text-strong": "high-contrast",
  "text-body": "content",
  "text-secondary": "content",
  "text-muted": "content-muted",
  "text-faint": "content-muted",
  "text-disabled": "line-strong",
  accent: "primary",
  "accent-emphasis": "primary",
  "accent-border": "primary",
  "accent-soft": "primary",
  "accent-muted": "surface-raised",
};

// Only #hex values are emitted. Canon colors are admin-controlled, but
// roleMap.dark overrides are validated as plain strings, so a malformed value
// is skipped (the ops default stands) rather than injected into the <style> —
// prevents any CSS breakout from a bad value.
const HEX = /^#[0-9a-fA-F]{3,8}$/;

// Builds a :root override that repoints each mapped ops token at its brand-role
// hex (from the brand dark palette). Unlayered :root wins over Tailwind's
// @layer theme, so this override takes effect app-wide.
export function opsChromeOverrideCss(darkPalette: Record<RoleName, string>): string {
  const decls = Object.entries(OPS_TO_BRAND_ROLE)
    .map(([opsToken, brandRole]) => {
      const value = darkPalette[brandRole];
      return HEX.test(value) ? `--color-${opsToken}:${value};` : "";
    })
    .filter(Boolean)
    .join(" ");
  return `:root{ ${decls} }`;
}
