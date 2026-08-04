import type { BrandAsset } from "@/lib/brand/assets";
import type { BrandCanon } from "@/lib/brand/canon.types";
import { normalizePairs, type RulePanel } from "@/lib/brand/rulePairs";
import RulePairCard from "./blocks/RulePairCard";

/**
 * Visual Identity view: the introduction, then the rules as paired do/don't
 * cards.
 *
 * The rules were two independent columns — six dos on the left, three don'ts on
 * the right — but they were never independent rules. "Flat vector rendering"
 * and "no photorealism" are one rule stated from both ends, and in two columns
 * they sat at different heights, drifting further apart with every rule above
 * them. Each rule is now ONE card holding both halves, so the failure a rule
 * prevents is always level with the rule itself.
 *
 * Style homage used to sit here as a permission with no failure opposite it;
 * it's gone now that each rule's own nuance carries that kind of caveat.
 *
 * The label chassis rendered here through Phase A, but it is the frame a
 * release is designed into rather than a law of illustration — it now anchors
 * the Release Design tab, drawn as an annotated label.
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

  // The asset row travels with the panel so the card block stays dumb about
  // where assets come from.
  const resolve = (panel: RulePanel) => ({
    ...panel,
    asset: panel.assetId ? assetsById?.get(panel.assetId) : undefined,
  });

  return pairs.length === 0 ? (
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
  );
}
