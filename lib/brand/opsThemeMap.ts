import type { RoleName } from "./canon.types";

// Maps the internal ops-chrome color tokens (app/globals.css @theme, the dark
// zinc/amber system) onto brand roles. When "brand chrome" is enabled, the
// ops --color-* values are overridden with the brand's DARK palette (the app
// is dark-only), so the whole internal UI wears Joho without touching a single
// component — every ops component already binds to these semantic tokens.
//
// Status colors (danger / success / info) are NOT drawn from the brand palette
// — red / green / blue must keep their meaning whatever the brand is — but they
// DO flip light/dark (see STATUS_LIGHT/STATUS_DARK below): the ops defaults are
// dark-tuned and wash out on a light canvas. Accent maps to brand PRIMARY
// (indigo), not the brand accent (Seal Red), because the brand caps Seal Red at
// ≤5% of a composition — it can't be the app-wide accent.
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

// Status ramps (danger / success / info). Their HUE meaning is fixed across
// themes — red stays red — but the ops defaults in globals.css are dark-tuned
// (light `-400` text on a near-black `-950` surface), which washes out on a
// light canvas. These are the one set of colors NOT drawn from the brand
// palette (status must read the same whatever the brand is), so they carry
// hardcoded light + dark ramps here. Dark values mirror globals.css @theme so
// the dark blocks are a faithful re-assertion (needed because the light `:root`
// below would otherwise leak into dark mode). Each token flips as a set:
// `text-danger` / `bg-danger-surface` / `border-danger-border`, etc.
const STATUS_TOKENS = [
  "danger",
  "danger-emphasis",
  "danger-border",
  "danger-surface",
  "success",
  "success-emphasis",
  "success-border",
  "success-surface",
  "info",
  "info-emphasis",
  "info-border",
  "info-surface",
] as const;

const STATUS_LIGHT: Record<(typeof STATUS_TOKENS)[number], string> = {
  danger: "#b91c1c", // red-700 — dark text on light tint
  "danger-emphasis": "#dc2626", // red-600
  "danger-border": "#fca5a5", // red-300
  "danger-surface": "#fef2f2", // red-50
  success: "#15803d", // green-700
  "success-emphasis": "#16a34a", // green-600
  "success-border": "#86efac", // green-300
  "success-surface": "#f0fdf4", // green-50
  info: "#1d4ed8", // blue-700
  "info-emphasis": "#2563eb", // blue-600
  "info-border": "#93c5fd", // blue-300
  "info-surface": "#eff6ff", // blue-50
};

const STATUS_DARK: Record<(typeof STATUS_TOKENS)[number], string> = {
  danger: "#f87171", // red-400 (globals.css @theme)
  "danger-emphasis": "#ef4444", // red-500
  "danger-border": "#7f1d1d", // red-900
  "danger-surface": "#450a0a", // red-950
  success: "#4ade80", // green-400
  "success-emphasis": "#16a34a", // green-600
  "success-border": "#14532d", // green-900
  "success-surface": "#052e16", // green-950
  info: "#60a5fa", // blue-400
  "info-emphasis": "#2563eb", // blue-600
  "info-border": "#1e3a8a", // blue-900
  "info-surface": "#172554", // blue-950
};

// Category / data-hue badge tokens (--cat-{hue}-{bg,fg,bd}). The DARK defaults
// live in globals.css (`:root`); here we override them for LIGHT and re-assert
// DARK in the dark blocks, so the whole category palette flips with the theme
// under the brand skin exactly like the neutrals.
//
// LITERAL Tailwind hexes, NOT `var(--color-{hue}-{step})`: Tailwind v4 only
// emits a palette var to :root when a utility uses that exact step, and the
// token rewrite removed the raw `bg-{hue}-{100,800,900}` usages that would keep
// them alive — so a `var(--color-{hue}-100)` here would resolve to nothing.
// Light badge = `-100` fill / `-800` text / `-300` border; dark badge = `-900`
// fill @ 50% / `-300` text / `-700` border. The dark side is kept in lockstep
// with the `:root` defaults in globals.css. Authored constants, never admin
// input, so they bypass the hex-guard.
const CAT_RAMP: Record<string, { c100: string; c300: string; c700: string; c800: string; c900: string }> = {
  red:     { c100: "#fee2e2", c300: "#fca5a5", c700: "#b91c1c", c800: "#991b1b", c900: "#7f1d1d" },
  orange:  { c100: "#ffedd5", c300: "#fdba74", c700: "#c2410c", c800: "#9a3412", c900: "#7c2d12" },
  amber:   { c100: "#fef3c7", c300: "#fcd34d", c700: "#b45309", c800: "#92400e", c900: "#78350f" },
  yellow:  { c100: "#fef9c3", c300: "#fde047", c700: "#a16207", c800: "#854d0e", c900: "#713f12" },
  green:   { c100: "#dcfce7", c300: "#86efac", c700: "#15803d", c800: "#166534", c900: "#14532d" },
  emerald: { c100: "#d1fae5", c300: "#6ee7b7", c700: "#047857", c800: "#065f46", c900: "#064e3b" },
  teal:    { c100: "#ccfbf1", c300: "#5eead4", c700: "#0f766e", c800: "#115e59", c900: "#134e4a" },
  cyan:    { c100: "#cffafe", c300: "#67e8f9", c700: "#0e7490", c800: "#155e75", c900: "#164e63" },
  sky:     { c100: "#e0f2fe", c300: "#7dd3fc", c700: "#0369a1", c800: "#075985", c900: "#0c4a6e" },
  blue:    { c100: "#dbeafe", c300: "#93c5fd", c700: "#1d4ed8", c800: "#1e40af", c900: "#1e3a8a" },
  purple:  { c100: "#f3e8ff", c300: "#d8b4fe", c700: "#7e22ce", c800: "#6b21a8", c900: "#581c87" },
  violet:  { c100: "#ede9fe", c300: "#c4b5fd", c700: "#6d28d9", c800: "#5b21b6", c900: "#4c1d95" },
  rose:    { c100: "#ffe4e6", c300: "#fda4af", c700: "#be123c", c800: "#9f1239", c900: "#881337" },
  stone:   { c100: "#f5f5f4", c300: "#d6d3d1", c700: "#44403c", c800: "#292524", c900: "#1c1917" },
};

function categoryDecls(scheme: "light" | "dark"): string {
  return Object.entries(CAT_RAMP)
    .map(([hue, r]) => {
      if (scheme === "light") {
        return `--cat-${hue}-bg:${r.c100};--cat-${hue}-fg:${r.c800};--cat-${hue}-bd:${r.c300};`;
      }
      return (
        `--cat-${hue}-bg:color-mix(in srgb, ${r.c900} 50%, transparent);` +
        `--cat-${hue}-fg:${r.c300};--cat-${hue}-bd:${r.c700};`
      );
    })
    .join("");
}

// Only #hex values are emitted for the brand-derived neutrals. Canon colors are
// admin-controlled, but roleMap.dark overrides are validated as plain strings,
// so a malformed value is skipped (the ops default stands) rather than injected
// into the <style> — prevents any CSS breakout from a bad value. (Status and
// category decls are authored constants, so they bypass this guard.)
const HEX = /^#[0-9a-fA-F]{3,8}$/;

function overrideBlock(palette: Record<RoleName, string>, scheme: "light" | "dark"): string {
  const neutralDecls = Object.entries(OPS_TO_BRAND_ROLE)
    .map(([opsToken, brandRole]) => {
      const value = palette[brandRole];
      return HEX.test(value) ? `--color-${opsToken}:${value};` : "";
    })
    .filter(Boolean)
    .join(" ");
  const status = scheme === "light" ? STATUS_LIGHT : STATUS_DARK;
  const statusDecls = STATUS_TOKENS.map((t) => `--color-${t}:${status[t]};`).join(" ");
  return `color-scheme:${scheme}; ${neutralDecls} ${statusDecls} ${categoryDecls(scheme)}`;
}

// Repoints the mapped ops tokens at the brand palette for BOTH modes, so the
// skinned internal app flips light/dark via the same `data-theme` mechanism as
// the brand surfaces: light is the default (`:root`), dark applies when the
// user picks dark (`[data-theme="dark"]`) or their OS prefers dark and they
// haven't forced light. Unlayered `:root` wins over Tailwind's `@layer theme`,
// so these overrides (and the color-scheme flip) take effect app-wide.
export function opsChromeOverrideCss(
  light: Record<RoleName, string>,
  dark: Record<RoleName, string>,
): string {
  return [
    `:root{ ${overrideBlock(light, "light")} }`,
    `:root[data-theme="dark"]{ ${overrideBlock(dark, "dark")} }`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){ ${overrideBlock(dark, "dark")} }}`,
  ].join("\n");
}
