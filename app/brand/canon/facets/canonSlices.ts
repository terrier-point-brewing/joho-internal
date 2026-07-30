import type { ZodType } from "zod";
import type { BrandCanon } from "@/lib/brand/canon.types";
import { canonSchema } from "@/lib/brand/canon.schema";
import { SECTION_KEYS, sectionSchema } from "@/lib/brand/canonSections";

/**
 * UI copy for each editable canon slice.
 *
 * `keys` and `schema` come from lib/brand/canonSections.ts — the same table the
 * PATCH route validates against — so the editor and the server can never
 * disagree about what a subtab owns. Only the human-facing title and
 * description live here.
 *
 * Each subtab's introduction is edited separately (IntroFacet →
 * canon.guideIntros), not through these slices.
 */
export type CanonSlice = {
  keys: readonly (keyof BrandCanon)[];
  schema: ZodType;
  title: string;
  description: string;
};

export const visualSlice: CanonSlice = {
  keys: SECTION_KEYS.visual,
  schema: sectionSchema("visual"),
  title: "Visual Identity",
  description:
    "The illustration rules — the seed of the wider visual-identity spec. Validated on blur.",
};

export const agentSlice: CanonSlice = {
  keys: SECTION_KEYS.agent,
  schema: sectionSchema("agent"),
  title: "Agent Rules",
  description: "The Never List, precedence order, and hard rules. Validated on blur.",
};

/**
 * The Color tab's forbidden-colors list.
 *
 * A SUB-slice, not a section: Color owns four keys, and Palette and Theme have
 * their own dedicated facets. So this one builds its own single-key schema
 * rather than reusing sectionSchema("color"), which requires all four keys to
 * be present and would reject a patch carrying only colorForbidden.
 */
export const colorForbiddenSlice: CanonSlice = {
  keys: ["colorForbidden"],
  schema: canonSchema.pick({ colorForbidden: true }),
  title: "Forbidden colors",
  description: "Colors that must never appear. Validated on blur.",
};
