import type { ZodType } from "zod";
import type { BrandCanon } from "@/lib/brand/canon.types";
import { canonSchema } from "@/lib/brand/canon.schema";

/**
 * One definition per editable canon slice, shared by the CanonEditor facet
 * switch and each SliceJsonFacet. `keys` names the fields the slice owns;
 * `schema` is the matching canonSchema.pick() used to validate an edited slice
 * on blur. The Brand Guide's four content subtabs each own exactly one slice —
 * no tab edits another's fields.
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
  keys: ["mission", "missionNarrative", "values"],
  schema: canonSchema.pick({ mission: true, missionNarrative: true, values: true }),
  title: "Ethos",
  description: "Mission, its narrative, and the values with their costs. Validated on blur.",
};

export const voiceSlice: CanonSlice = {
  keys: ["voice"],
  schema: canonSchema.pick({ voice: true }),
  title: "Voice",
  description: "Summary, personality, calibration sliders, word lists, and rewrites. Validated on blur.",
};

export const visualSlice: CanonSlice = {
  keys: ["illustrationLaw"],
  schema: canonSchema.pick({ illustrationLaw: true }),
  title: "Visual Identity",
  description: "Illustration narrative and its rules — the seed of the wider visual-identity spec. Validated on blur.",
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
