import type { ZodType } from "zod";
import type { BrandCanon } from "@/lib/brand/canon.types";
import { canonSchema } from "@/lib/brand/canon.schema";

/**
 * One definition per editable canon slice, shared by the CanonEditor facet
 * switch and each SliceJsonFacet. `keys` names the fields the slice owns;
 * `schema` is the matching canonSchema.pick() used to validate an edited slice
 * on blur. The Brand Guide's four content subtabs each own exactly one slice —
 * no tab edits another's fields. Each subtab's introduction block is edited
 * separately (IntroFacet → canon.guideIntros), not through these slices.
 *
 * Each subtab's narrative copy is not here either — it lives in
 * canon.guideIntros and is edited by IntroFacet, one textarea per subtab.
 *
 * Fields that live on other tabs/modules are intentionally absent here:
 *   colorForbidden → Color tab (colorSlice)   naming/labelChassis → Releases
 *   chop → Marks/Releases   visibility → Phase-5 public site
 * Those keep their stored values; their editors are owned by their own modules.
 */
export type CanonSlice = {
  keys: readonly (keyof BrandCanon)[];
  schema: ZodType;
  title: string;
  description: string;
};

export const ethosSlice: CanonSlice = {
  keys: ["values"],
  schema: canonSchema.pick({ values: true }),
  title: "Ethos",
  description: "The values with what each one means and costs. Validated on blur.",
};

export const voiceSlice: CanonSlice = {
  keys: ["voice"],
  schema: canonSchema.pick({ voice: true }),
  title: "Voice",
  description: "Calibration sliders, word lists, and rewrites. Validated on blur.",
};

export const visualSlice: CanonSlice = {
  keys: ["illustrationLaw"],
  schema: canonSchema.pick({ illustrationLaw: true }),
  title: "Visual Identity",
  description: "The illustration rules — the seed of the wider visual-identity spec. Validated on blur.",
};

export const agentSlice: CanonSlice = {
  keys: ["neverList", "precedence", "hardRules"],
  schema: canonSchema.pick({ neverList: true, precedence: true, hardRules: true }),
  title: "Agent Rules",
  description: "The Never List, precedence order, and hard rules. Validated on blur.",
};

/** Color-tab slice for the forbidden-colors list (rendered in ColorView). */
export const colorForbiddenSlice: CanonSlice = {
  keys: ["colorForbidden"],
  schema: canonSchema.pick({ colorForbidden: true }),
  title: "Forbidden colors",
  description: "Colors that must never appear. Validated on blur.",
};
