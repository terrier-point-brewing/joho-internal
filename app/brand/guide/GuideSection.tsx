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
 * paragraph: the opening line is the lede, set in the display face, with any
 * remaining paragraphs BESIDE it at body size. Nothing is hidden or collapsed —
 * this is a reference document, and a reader should never have to click to find
 * out what a section says. The second column spends horizontal room the tab was
 * already wasting instead of vertical room it can't spare.
 *
 * The 4:7 split is load-bearing. An even-ish 5:6 leaves the lede column half
 * empty next to three body paragraphs, and the block ends up TALLER than the
 * flat stack it replaced — the short side sets the height while the long side
 * sets the line count. Giving the lede the narrower column makes it run deeper
 * at large type while the body runs shallower, so the two columns land close to
 * level and the card is shorter than either the even split or the flat stack.
 *
 * A single-paragraph intro has no second column and renders as one measure-
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
          <div
            className={`mt-2 gap-x-10 ${
              hasBody ? "lg:grid lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]" : ""
            }`}
          >
            <p className="font-brand-display text-lg text-brand-high-contrast leading-relaxed max-w-3xl">
              {lede}
            </p>
            {hasBody && (
              <div className="flex flex-col gap-3 mt-3 lg:mt-0">
                {rest.map((p, i) => (
                  <p
                    key={i}
                    className="font-brand-body text-sm text-brand-content leading-relaxed"
                  >
                    {p}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {children}
    </section>
  );
}
