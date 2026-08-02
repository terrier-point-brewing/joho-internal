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
 *   brandName · version · visibility
 * A section PATCH must preserve them verbatim. `guideIntros` is also absent:
 * every subtab owns its own entry in that record, so it's handled as a special
 * case in saveDraftSection rather than being assigned to one section here.
 *
 * `naming`, `chop` and `labelChassis` joined this table in Phase A, owned by
 * subject matter: the chop is a mark, the chassis was visual law, naming was
 * language. `naming` and `labelChassis` have since moved to `release` — they
 * were never two subjects, but the two halves of one spec for designing a new
 * release: the card that names it and the chassis it is poured into. The data
 * keys themselves never moved; only which subtab edits them.
 */
export const SECTION_KEYS: Record<GuideSectionKey, readonly (keyof BrandCanon)[]> = {
  ethos: ["values"],
  voice: ["voice"],
  visual: ["illustrationLaw"],
  color: ["palette", "roleMap", "usageRatios", "colorForbidden"],
  type: ["fonts", "typeUseCases"],
  marks: ["marks", "chop"],
  release: ["naming", "labelChassis"],
  agent: ["neverList", "precedence", "hardRules", "agentTechnical"],
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

/**
 * The exact payload a section PATCH should carry: that subtab's keys, plus its
 * own `guideIntros` entry when set. Nothing else — the editor never sends a
 * whole document, so concurrent edits on different subtabs don't collide.
 */
export function pickSectionPatch(
  canon: BrandCanon,
  section: GuideSectionKey,
): Partial<BrandCanon> {
  const patch: Partial<BrandCanon> = {};
  for (const key of SECTION_KEYS[section]) {
    if (canon[key] !== undefined) {
      (patch as Record<string, unknown>)[key] = canon[key];
    }
  }

  const intro = canon.guideIntros?.[section];
  if (intro !== undefined) patch.guideIntros = { [section]: intro };

  return patch;
}

/** True when a subtab's own slice differs between two canon documents. */
export function isSectionDirty(
  a: BrandCanon | null | undefined,
  b: BrandCanon | null | undefined,
  section: GuideSectionKey,
): boolean {
  if (!a || !b) return false;
  return JSON.stringify(pickSectionPatch(a, section)) !== JSON.stringify(pickSectionPatch(b, section));
}

/** Every subtab whose slice differs — drives the publish bar's summary. */
export function changedSections(
  a: BrandCanon | null | undefined,
  b: BrandCanon | null | undefined,
): GuideSectionKey[] {
  if (!a || !b) return [];
  return (Object.keys(SECTION_KEYS) as GuideSectionKey[]).filter((s) => isSectionDirty(a, b, s));
}
