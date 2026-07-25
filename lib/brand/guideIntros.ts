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
