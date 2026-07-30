import type { BrandCanon } from "./canon.types";

export type BrandFont = BrandCanon["fonts"][number];
export type FontSource = "bundled" | "uploaded" | "system";

/**
 * The families loaded by next/font in app/layout.tsx.
 *
 * `cssVar` is the custom property next/font defines for that face. Emitting a
 * bare family stack instead of chaining through this variable is what the old
 * comment in tokens.ts was guarding against: the face would silently fall back
 * to a generic serif/sans, and nothing in the build would notice.
 */
export const BUNDLED_FONTS: { family: string; cssVar: string; fallback: string }[] = [
  { family: "Marcellus", cssVar: "--font-marcellus", fallback: "serif" },
  { family: "Lato", cssVar: "--font-lato", fallback: "sans-serif" },
  { family: "Jost", cssVar: "--font-jost", fallback: "sans-serif" },
  { family: "Noto Serif SC", cssVar: "--font-noto-serif-sc", fallback: "serif" },
];

/**
 * A family name safe to interpolate into a CSS string literal.
 *
 * `family` is free text from the canon editor and gets written into an
 * `@font-face` rule. Even without malice a stray `"` would terminate the string
 * early and break every rule after it; with malice it's CSS injection. Only
 * characters that legitimately appear in a typeface name survive.
 *
 * Returns null when nothing usable remains, so the caller can skip the rule
 * rather than emit a broken one.
 */
export function safeFamilyName(family: string): string | null {
  const cleaned = family.replace(/[^A-Za-z0-9 _-]/g, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Where a face's bytes come from. Absent on documents predating the split. */
export function sourceOf(font: BrandFont): FontSource {
  if (font.source) return font.source;
  return BUNDLED_FONTS.some((f) => f.family === font.family) ? "bundled" : "system";
}

/**
 * The CSS value to emit for a font role.
 *
 * A bundled family MUST chain through its next/font variable — the canon's
 * stored `cssStack` is a plain fallback description (`"Marcellus", serif`), and
 * emitting that directly is precisely the bug that made the whole type editor
 * inert. `BrandStyle` writes an unlayered `:root{}` that outranks the `@theme`
 * block, so whatever this returns wins.
 *
 * Uploaded faces are declared by BrandFontFace's `@font-face` rules, so their
 * family name resolves on its own. System stacks are emitted as authored.
 */
export function fontStackFor(font: BrandFont): string {
  const bundled = BUNDLED_FONTS.find((f) => f.family === font.family);
  if (bundled) return `var(${bundled.cssVar}), "${font.family}", ${bundled.fallback}`;
  return font.cssStack;
}
