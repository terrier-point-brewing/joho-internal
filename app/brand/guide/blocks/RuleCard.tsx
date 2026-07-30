import type { GuideRule } from "@/lib/brand/guideRules";
import AssetImage from "./AssetImage";

/**
 * One brand rule, with room to show it rather than only state it.
 *
 * The polarity isn't repeated on the card — RuleGrid's column header carries
 * it, so a card inside the "Don't" column doesn't need to say "don't" again.
 * That keeps the title free to be the rule itself.
 */
export default function RuleCard({ rule }: { rule: GuideRule }) {
  return (
    <div className="rounded-lg border border-brand-line p-3">
      <AssetImage assetId={rule.assetId} alt={rule.title} caption={rule.caption} />
      <p className="font-brand-body text-sm font-semibold text-brand-high-contrast mt-3">
        {rule.title}
      </p>
      {rule.detail && (
        <p className="font-brand-body text-sm text-brand-content-muted mt-1 leading-relaxed">
          {rule.detail}
        </p>
      )}
    </div>
  );
}
