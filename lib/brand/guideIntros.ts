import type { BrandCanon } from "./canon.types";
import { guideSectionSchema } from "./canon.schema";
import { seedCanon } from "./seedCanon";

/** The Brand Guide's subtabs, in display order. */
export const GUIDE_SECTIONS = guideSectionSchema.options;
export type GuideSectionKey = (typeof GUIDE_SECTIONS)[number];

/**
 * The introduction prose for one Brand Guide subtab, from the canon's
 * `guideIntros` — the single home for the guide's narrative copy, stored in
 * Supabase with the rest of the canon document.
 *
 * Falls back to the seed per subtab, mirroring getCanon()'s whole-document
 * fallback: a document published before `guideIntros` existed (or one whose
 * admin never opened a given tab) still shows that tab's founder-approved
 * prose instead of an empty page.
 *
 * The one resolver — the guide views, the canon editor, the brand preview, and
 * the agent brief all read through it, so what the guide shows and what agents
 * are told can never drift.
 */
export function resolveGuideIntro(canon: BrandCanon, section: GuideSectionKey): string {
  return canon.guideIntros?.[section]?.trim() || seedCanon.guideIntros?.[section] || "";
}

/**
 * What each subtab is for, in a few words — the label on its introduction card.
 *
 * Deliberately not in the canon and not editable: this is structural chrome,
 * the same kind of thing as the subtab labels in BrandGuideTabs, and it has to
 * stay parallel across all seven to read as a set. The prose that IS the
 * brand's own words lives in `guideIntros`, which admins own.
 */
export const GUIDE_SECTION_PURPOSE: Record<GuideSectionKey, string> = {
  ethos: "What we're for",
  voice: "How we sound",
  visual: "How we look",
  color: "How color works",
  type: "How type works",
  marks: "The fixed marks",
  release: "How a release is built",
  agent: "For agents",
};

/** Splits intro prose into paragraphs on blank lines, dropping empties. */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** The intro's opening paragraph — for surfaces that show a single line of it. */
export function firstParagraph(canon: BrandCanon, section: GuideSectionKey): string {
  return splitParagraphs(resolveGuideIntro(canon, section))[0] ?? "";
}
