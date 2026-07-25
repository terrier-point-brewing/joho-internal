import type { BrandCanon } from "@/lib/brand/canon.types";
import { resolveGuideIntro } from "@/lib/brand/guideIntros";
import GuideSection from "./GuideSection";

/**
 * Ethos view: the introduction (the mission narrative, until an admin edits it)
 * then the values with their costs — one Ethos family, so the values carry no
 * sub-heading of their own. The mission line itself lives in the canon and the
 * brand brief, not on this tab.
 */
export default function EthosView({ canon }: { canon: BrandCanon }) {
  return (
    <GuideSection intro={resolveGuideIntro(canon, "ethos")}>
      {canon.values?.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {canon.values.map((v) => (
            <div key={v.n} className="rounded-lg border border-brand-line p-4">
              <p className="font-brand-display text-lg text-brand-high-contrast">
                {v.n}. {v.title}
              </p>
              <p className="font-brand-body text-sm text-brand-content mt-1">{v.means}</p>
              <p className="font-brand-body text-xs text-brand-content-muted mt-2">
                <span className="text-brand-accent uppercase tracking-wide">The cost · </span>
                {v.cost}
              </p>
            </div>
          ))}
        </div>
      )}
    </GuideSection>
  );
}
