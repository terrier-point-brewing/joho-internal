import type { BrandCanon, FontRole, ResolvedTokens, RoleName } from "./canon.types";
import { deriveDarkPalette } from "./deriveDark";
import { fontStackFor } from "./fontRegistry";

export const ROLE_NAMES: RoleName[] = [
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

/** Role → hex for light mode. A role value is a palette key or a raw hex. */
export function resolveLightRoles(canon: BrandCanon): Record<RoleName, string> {
  const paletteByKey = new Map(canon.palette.map((c) => [c.key, c.hex]));
  const out = {} as Record<RoleName, string>;
  for (const role of ROLE_NAMES) {
    const value = canon.roleMap.light[role];
    out[role] = paletteByKey.get(value) ?? value;
  }
  return out;
}

/**
 * Role → hex for dark mode, mirroring light: each role's value is a palette key
 * or a raw hex.
 *
 * Falls back to `deriveDarkPalette` for any role `roleMap.dark` omits. That
 * fallback is what makes this deployable ahead of migration 20260905 — without
 * it, shipping the symmetric model against today's empty dark map would leave
 * every dark role unresolved. Once the migration lands the map is complete and
 * the derivation never runs.
 */
export function resolveDarkRoles(
  canon: BrandCanon,
  light: Record<RoleName, string>,
): Record<RoleName, string> {
  const paletteByKey = new Map(canon.palette.map((c) => [c.key, c.hex]));
  const derived = deriveDarkPalette(light);
  const stored = canon.roleMap.dark ?? {};

  const out = {} as Record<RoleName, string>;
  for (const role of ROLE_NAMES) {
    const value = stored[role];
    out[role] = value ? (paletteByKey.get(value) ?? value) : derived[role];
  }
  return out;
}

export function resolveTokens(canon: BrandCanon): ResolvedTokens {
  const light = resolveLightRoles(canon);
  const dark = resolveDarkRoles(canon, light);

  const fonts = {} as Record<FontRole, string>;
  for (const role of FONT_ROLES) {
    const font = canon.fonts.find((f) => f.role === role);
    if (!font) throw new Error(`Missing font for role: ${role}`);
    // NOT font.cssStack — see fontStackFor. A bundled family has to chain
    // through its next/font variable or the face silently degrades.
    fonts[role] = fontStackFor(font);
  }

  return { light, dark, fonts };
}

/**
 * Emits the brand color AND font tokens.
 *
 * Fonts used to be excluded here, with `@theme` in globals.css hardcoding
 * `--font-brand-display: var(--font-marcellus), …`. The consequence was that
 * the Type editor did nothing: an admin could assign Lato to the display role,
 * save, publish — and the guide kept rendering Marcellus.
 *
 * The original reason for the exclusion was real. `BrandStyle` writes an
 * unlayered `:root{}` that outranks `@layer theme`, so emitting a bare family
 * stack (`"Marcellus", serif`) would override the next/font chain and silently
 * fall back to a generic face. The fix is to emit the *mapping* rather than the
 * stack — `fontStackFor` chains through the next/font variable for bundled
 * families, so the canon chooses WHICH loaded face a role uses without
 * breaking HOW it loads. globals.css keeps its four lines as build-time
 * defaults; this overrides them at runtime.
 *
 * ⚠️ A broken var() chain fails silently and passes every build. Verify by
 * reading `getComputedStyle(el).fontFamily` in a browser, not by compiling.
 */
export function emitBrandCss(t: ResolvedTokens): string {
  const lightDecls = ROLE_NAMES.map((role) => `--color-brand-${role}:${t.light[role]};`).join(" ");
  const darkDecls = ROLE_NAMES.map((role) => `--color-brand-${role}:${t.dark[role]};`).join(" ");
  const fontDecls = FONT_ROLES.map((role) => `--font-brand-${role}:${t.fonts[role]};`).join(" ");

  return (
    `:root{ ${lightDecls} ${fontDecls} }\n` +
    `:root[data-theme="dark"]{ ${darkDecls} }\n` +
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){ ${darkDecls} }}`
  );
}
