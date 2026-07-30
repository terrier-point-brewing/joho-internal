import type { ZodType } from "zod";
import type { BrandCanon } from "@/lib/brand/canon.types";
import { SECTION_KEYS, sectionSchema } from "@/lib/brand/canonSections";

/**
 * UI copy for the one canon slice still edited as raw JSON.
 *
 * `keys` and `schema` come from lib/brand/canonSections.ts — the same table the
 * PATCH route validates against — so the editor and the server can never
 * disagree about what a subtab owns. Only the human-facing title and
 * description live here.
 *
 * Ethos, Voice, Visual Identity and the forbidden-color list have moved to
 * typed editors under `../fields/`. Agent Rules is the last holdout and goes in
 * phase 6, when it becomes a markdown compile target rather than three arrays.
 */
export type CanonSlice = {
  keys: readonly (keyof BrandCanon)[];
  schema: ZodType;
  title: string;
  description: string;
};

export const agentSlice: CanonSlice = {
  keys: SECTION_KEYS.agent,
  schema: sectionSchema("agent"),
  title: "Agent Rules",
  description: "The Never List, precedence order, and hard rules. Validated on blur.",
};
