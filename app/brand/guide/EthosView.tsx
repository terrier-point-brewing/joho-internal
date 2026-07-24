import type { BrandCanon } from "@/lib/brand/canon.types";
import GuideSection from "./GuideSection";

/**
 * Ethos view: the mission up top, its narrative, then the values with their
 * costs — treated as one Ethos family, so the values carry no sub-heading of
 * their own. Single unnumbered section, matching the Color/Type tab layout.
 */
export default function EthosView({ canon }: { canon: BrandCanon }) {
  return (
    <GuideSection title="Ethos">
      <p className="font-brand-display text-2xl sm:text-4xl leading-tight text-brand-high-contrast mb-6">
        {canon.mission}
      </p>
      {canon.missionNarrative && (
        <p className="font-brand-body text-base text-brand-content leading-relaxed max-w-3xl">
          {canon.missionNarrative}
        </p>
      )}

      {canon.values?.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 mt-10">
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
