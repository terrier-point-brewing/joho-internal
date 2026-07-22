import type { BrandCanon, FontRole, ResolvedTokens, RoleName } from "./canon.types";
import { deriveDarkPalette } from "./deriveDark";

const ROLE_NAMES: RoleName[] = [
  "canvas",
  "surface",
  "surface-raised",
  "primary",
  "on-primary",
  "secondary",
  "accent",
  "on-accent",
  "high-contrast",
  "content",
  "content-muted",
  "line",
  "line-strong",
];

const FONT_ROLES: FontRole[] = ["display", "body", "wordmark", "script"];

function resolveLight(canon: BrandCanon): Record<RoleName, string> {
  const paletteByKey = new Map(canon.palette.map((c) => [c.key, c.hex]));
  const out = {} as Record<RoleName, string>;
  for (const role of ROLE_NAMES) {
    const value = canon.roleMap.light[role];
    out[role] = paletteByKey.get(value) ?? value;
  }
  return out;
}

export function resolveTokens(canon: BrandCanon): ResolvedTokens {
  const light = resolveLight(canon);
  const dark = { ...deriveDarkPalette(light), ...canon.roleMap.dark };

  const fonts = {} as Record<FontRole, string>;
  for (const role of FONT_ROLES) {
    const font = canon.fonts.find((f) => f.role === role);
    if (!font) throw new Error(`Missing font for role: ${role}`);
    fonts[role] = font.cssStack;
  }

  return { light, dark, fonts };
}

// Emits ONLY the color tokens (the sole thing that varies at runtime and by
// theme). Fonts are intentionally NOT emitted here: `@theme` in globals.css
// owns `--font-brand-*`, chaining `var(--font-marcellus), …` so the tokens
// resolve to the next/font-loaded faces. Emitting them here as bare family
// stacks would override that (BrandStyle's `:root{}` is unlayered and beats
// `@layer theme`) and silently fall back to generic serif/sans. `fonts` stays
// in ResolvedTokens for non-CSS consumers (agent brief, brand guide display).
export function emitBrandCss(t: ResolvedTokens): string {
  const lightDecls = ROLE_NAMES.map((role) => `--color-brand-${role}:${t.light[role]};`).join(" ");
  const darkDecls = ROLE_NAMES.map((role) => `--color-brand-${role}:${t.dark[role]};`).join(" ");

  return (
    `:root{ ${lightDecls} }\n` +
    `:root[data-theme="dark"]{ ${darkDecls} }\n` +
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){ ${darkDecls} }}`
  );
}
