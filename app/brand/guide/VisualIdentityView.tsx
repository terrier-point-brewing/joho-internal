import type { BrandAsset } from "@/lib/brand/assets";
import type { BrandCanon } from "@/lib/brand/canon.types";
import { resolveGuideIntro } from "@/lib/brand/guideIntros";
import { normalizePairs, type RulePanel } from "@/lib/brand/rulePairs";
import GuideSection from "./GuideSection";
import RulePairCard from "./blocks/RulePairCard";
import SubHead from "./blocks/SubHead";
import SpecCard from "./blocks/SpecCard";

/**
 * Visual Identity view: the introduction, the rules as paired do/don't cards,
 * then the label chassis.
 *
 * The rules were two independent columns — six dos on the left, three don'ts on
 * the right — but they were never independent rules. "Flat vector rendering"
 * and "no photorealism" are one rule stated from both ends, and in two columns
 * they sat at different heights, drifting further apart with every rule above
 * them. Each rule is now ONE card holding both halves, so the failure a rule
 * prevents is always level with the rule itself.
 *
 * Style homage is the exception that proves it: it is a permission with no
 * failure opposite it, so it reads as a line beneath the introduction rather
 * than as a card with an empty half.
 *
 * The chassis appears here for the first time in Phase A. It was stored in the
 * canon and rendered nowhere, which meant the one spec every beer label is built
 * against could not be read by anyone using the guide.
 */
export default function VisualIdentityView({
  canon,
  assetsById,
}: {
  canon: BrandCanon;
  /** Resolved assets, so illustrated rules can use their authored alt text. */
  assetsById?: Map<string, BrandAsset>;
}) {
  const law = canon.illustrationLaw;
  const pairs = normalizePairs(law);
  const chassis = canon.labelChassis;
  const elements = chassis?.elements ?? [];

  // The asset row travels with the panel so the card block stays dumb about
  // where assets come from.
  const resolve = (panel: RulePanel) => ({
    ...panel,
    asset: panel.assetId ? assetsById?.get(panel.assetId) : undefined,
  });

  return (
    <GuideSection section="visual" intro={resolveGuideIntro(canon, "visual")}>
      {law?.homage && (
        <p className="font-brand-body text-sm text-brand-content leading-relaxed mb-6 border-l-2 border-brand-line-strong pl-3">
          {law.homage}
        </p>
      )}

      {pairs.length === 0 ? (
        <p className="font-brand-body text-sm text-brand-content-muted">No rules yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {pairs.map((pair, i) => (
            <RulePairCard
              key={pair.id ?? i}
              title={pair.title}
              doPanel={resolve(pair.do)}
              dontPanel={resolve(pair.dont)}
              nuance={pair.nuance}
            />
          ))}
        </div>
      )}

      {(chassis?.narrative || elements.length > 0) && (
        <section className="mt-8">
          <SubHead
            title="The label chassis"
            description="The fixed frame every release is poured into. The illustration roams; the chassis is home."
          />
          {chassis?.narrative && (
            <p className="font-brand-body text-sm text-brand-content leading-relaxed mb-4">
              {chassis.narrative}
            </p>
          )}
          {elements.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {elements.map((element, i) => (
                <SpecCard
                  key={i}
                  eyebrow={element.n}
                  title={element.title}
                  rows={[{ label: "Rule", value: element.desc }]}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </GuideSection>
  );
}
