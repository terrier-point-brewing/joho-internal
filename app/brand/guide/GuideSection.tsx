import type { ReactNode } from "react";
import {
  GUIDE_SECTION_PURPOSE,
  splitParagraphs,
  type GuideSectionKey,
} from "@/lib/brand/guideIntros";

/**
 * Shell for one Brand Guide subtab: the introduction card, then the subtab's
 * content.
 *
 * The introduction is a card rather than loose prose because the intros stopped
 * being captions. Ethos runs four paragraphs and Voice three, while the other
 * five subtabs are still a single line — one flat stack of full-width `<p>`
 * served the short ones and buried the long ones, pushing the reference
 * material every reader actually came for below the fold.
 *
 * So the card does two things. Its label names what the subtab is FOR, which
 * the subtab label alone never said. And its body splits at the first
 * paragraph: the opening line is the lede, set in the display face at a capped
 * measure, and any remaining paragraphs flow beneath it in two columns at body
 * size. Nothing is hidden or collapsed — this is a reference document, and a
 * reader should never have to click to find out what a section says. The
 * columns spend horizontal room the tab was already wasting instead of vertical
 * room it can't spare.
 *
 * The lede is full-width rather than a column of its own: measured at 1280px, a
 * short lede beside a long body left its own column half empty and made the
 * whole block TALLER than the flat stack it replaced. Columns only pay for
 * themselves on the paragraphs there are several of.
 *
 * A single-paragraph intro has no columns at all and renders as one measure-
 * capped lede, so the five short subtabs look the same as they always did.
 */
export default function GuideSection({
  section,
  intro,
  children,
}: {
  /** Which subtab this is — selects the card's purpose label. */
  section: GuideSectionKey;
  intro?: string;
  children: ReactNode;
}) {
  const [lede, ...rest] = splitParagraphs(intro ?? "");
  const hasBody = rest.length > 0;

  // The card sits on mb-6 rather than the mb-8 the loose prose needed: it has a
  // border of its own now, so less of the separating falls to whitespace.

  return (
    <section>
      {lede && (
        <div className="mb-6 rounded-lg border border-brand-line bg-brand-surface p-4 sm:p-5">
          <p className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted">
            {GUIDE_SECTION_PURPOSE[section]}
          </p>
          <p className="font-brand-display text-lg text-brand-high-contrast leading-relaxed max-w-3xl mt-2">
            {lede}
          </p>
          {hasBody && (
            <div className="mt-3 lg:columns-2 lg:gap-10">
              {rest.map((p, i) => (
                <p
                  key={i}
                  className="font-brand-body text-sm text-brand-content leading-relaxed break-inside-avoid mb-3 last:mb-0"
                >
                  {p}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
      {children}
    </section>
  );
}
