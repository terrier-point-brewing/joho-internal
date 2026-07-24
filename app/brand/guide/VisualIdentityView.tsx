import type { BrandCanon } from "@/lib/brand/canon.types";
import GuideSection from "./GuideSection";

/**
 * Visual Identity view: today the illustration law (narrative + rules). This
 * subtab is the permanent home for the brand's wider visual-identity rules and
 * will grow to cover more than illustration over time. Single unnumbered
 * section, matching the Color/Type tab layout.
 */
export default function VisualIdentityView({ canon }: { canon: BrandCanon }) {
  const rules = canon.illustrationLaw?.rules ?? [];

  return (
    <GuideSection title="Visual Identity" lead={canon.illustrationLaw?.narrative}>
      {rules.length > 0 ? (
        <ul className="grid gap-x-10 gap-y-2 sm:grid-cols-2 font-brand-body text-sm text-brand-content">
          {rules.map((r, i) => (
            <li key={i} className="flex gap-2.5 leading-relaxed">
              <span className="text-brand-accent shrink-0" aria-hidden="true">
                —
              </span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="font-brand-body text-sm text-brand-content-muted">
          No visual-identity rules yet.
        </p>
      )}
    </GuideSection>
  );
}
