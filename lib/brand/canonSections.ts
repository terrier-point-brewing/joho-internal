import type { ZodType } from "zod";
import { canonSchema } from "./canon.schema";
import type { BrandCanon } from "./canon.types";
import type { GuideSectionKey } from "./guideIntros";

/**
 * The single map from a Brand Guide subtab to the canon keys it owns.
 *
 * This is the spine of section-scoped saving: a PATCH from one subtab may only
 * write these keys, and only these keys are validated on that write. Whole-
 * document validation happens exactly once, at publish (validateCanonForPublish).
 *
 * Shared by client and server on purpose — the editor decides what to send and
 * the route decides what to accept from the same table, so the two can't drift.
 *
 * Keys deliberately absent, because no subtab edits them today:
 *   brandName · version · naming · chop · labelChassis · visibility
 * A section PATCH must preserve them verbatim. `guideIntros` is also absent:
 * every subtab owns its own entry in that record, so it's handled as a special
 * case in saveDraftSection rather than being assigned to one section here.
 */
export const SECTION_KEYS: Record<GuideSectionKey, readonly (keyof BrandCanon)[]> = {
  ethos: ["values"],
  voice: ["voice"],
  visual: ["illustrationLaw"],
  color: ["palette", "roleMap", "usageRatios", "colorForbidden"],
  type: ["fonts"],
  marks: ["marks"],
  agent: ["neverList", "precedence", "hardRules"],
};

// canonSchema.pick() wants a mask object ({ values: true }), built here from
// SECTION_KEYS so the two can never disagree. Cached per section — the schemas
// are immutable and rebuilding them on every validation is pure waste.
const schemaCache = new Map<GuideSectionKey, ZodType<Partial<BrandCanon>>>();

/**
 * The validation schema for one subtab's slice of the canon.
 *
 * Typed as `Partial<BrandCanon>` rather than the exact per-section shape: the
 * caller's next move is always to spread the parsed result into a full document,
 * and a precise union of seven pick() shapes would buy nothing at that call site.
 */
export function sectionSchema(section: GuideSectionKey): ZodType<Partial<BrandCanon>> {
  const cached = schemaCache.get(section);
  if (cached) return cached;

  const mask: Record<string, true> = {};
  for (const key of SECTION_KEYS[section]) mask[key] = true;

  const schema = canonSchema.pick(
    mask as Parameters<typeof canonSchema.pick>[0],
  ) as unknown as ZodType<Partial<BrandCanon>>;
  schemaCache.set(section, schema);
  return schema;
}

// Reverse index, built once. Used to attribute a publish-validation issue (or a
// changelog entry) to the subtab a human would go to in order to fix it.
const OWNER_BY_KEY = new Map<string, GuideSectionKey>();
for (const section of Object.keys(SECTION_KEYS) as GuideSectionKey[]) {
  for (const key of SECTION_KEYS[section]) OWNER_BY_KEY.set(key, section);
}

/** The subtab that owns a canon key, or null when no subtab edits it. */
export function sectionOf(key: string): GuideSectionKey | null {
  return OWNER_BY_KEY.get(key) ?? null;
}
