import type { GuideRule } from "@/lib/brand/guideRules";
import AssetImage from "./AssetImage";

/**
 * One brand rule, with room to show it rather than only state it.
 *
 * The text sits ABOVE the artwork. A rule is read first and illustrated second
 * — leading with the image made a reader decode a picture before knowing what
 * it was meant to demonstrate, and it pushed the actual rule below the fold on
 * a two-column grid.
 *
 * The polarity isn't repeated on the card: RuleGrid's column header carries it,
 * so a card inside the "Don't" column doesn't need to say "don't" again. That
 * keeps the title free to be the rule itself.
 */
export default function RuleCard({ rule }: { rule: GuideRule }) {
  return (
    <div className="rounded-lg border border-brand-line p-3">
      <p className="font-brand-body text-sm font-semibold text-brand-high-contrast">
        {rule.title}
      </p>
      {rule.detail && (
        <p className="font-brand-body text-sm text-brand-content-muted mt-1 leading-relaxed">
          {rule.detail}
        </p>
      )}

      {/* Only take up vertical space when there is something to show. */}
      {rule.assetId && (
        <div className="mt-3">
          <AssetImage assetId={rule.assetId} alt={rule.title} caption={rule.caption} />
        </div>
      )}
    </div>
  );
}
