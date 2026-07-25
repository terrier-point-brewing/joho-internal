"use client";

import type { BrandCanon } from "@/lib/brand/canon.types";
import { resolveGuideIntro, type GuideSectionKey } from "@/lib/brand/guideIntros";

/**
 * Edits the introduction block that opens one Brand Guide subtab
 * (`canon.guideIntros[section]`). Every subtab gets one, so each tab owns its
 * own intro and no tab edits another's. Until an admin types here the field is
 * unset and the guide falls back to the legacy narrative field or the built-in
 * default — so the textarea starts pre-filled with whatever is on screen today.
 */
export default function IntroFacet({
  section,
  draft,
  onChange,
}: {
  section: GuideSectionKey;
  draft: BrandCanon;
  onChange: (next: BrandCanon) => void;
}) {
  const value = draft.guideIntros?.[section] ?? resolveGuideIntro(draft, section);

  function setIntro(next: string) {
    onChange({ ...draft, guideIntros: { ...draft.guideIntros, [section]: next } });
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Introduction</h3>
      <p className="text-xs text-faint">
        The prose that opens this subtab. Leave a blank line between paragraphs.
      </p>
      <textarea
        className="inp min-h-32"
        value={value}
        onChange={(e) => setIntro(e.target.value)}
      />
    </div>
  );
}
