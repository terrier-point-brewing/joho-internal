import type { BrandAsset } from "@/lib/brand/assets";
import type { GuideRule } from "@/lib/brand/guideRules";
import { splitByPolarity } from "@/lib/brand/guideRules";
import RuleCard from "./RuleCard";

/**
 * Do / Don't as two columns.
 *
 * Rules used to render as one undifferentiated bullet list that mixed musts
 * with must-nots, so a reader had to parse each line to work out which kind it
 * was. Sorting them into columns makes that structural: the column says which,
 * and the rule says what.
 *
 * A column with nothing in it is omitted rather than shown empty, so a
 * don't-only list (the Color tab's forbidden section) renders as one column
 * instead of a half-blank grid.
 */
export default function RuleGrid({
  rules,
  assetsById,
}: {
  rules: GuideRule[];
  /** Resolved assets, so each card can use its authored alt text. */
  assetsById?: Map<string, BrandAsset>;
}) {
  const { dos, donts } = splitByPolarity(rules);

  if (rules.length === 0) {
    return (
      <p className="font-brand-body text-sm text-brand-content-muted">No rules yet.</p>
    );
  }

  const columns = [
    { key: "do", label: "Do", items: dos, tone: "text-brand-primary" },
    { key: "dont", label: "Don't", items: donts, tone: "text-brand-accent" },
  ].filter((c) => c.items.length > 0);

  return (
    <div className={`grid gap-x-6 gap-y-4 ${columns.length > 1 ? "sm:grid-cols-2" : ""}`}>
      {columns.map((column) => (
        <div key={column.key}>
          <p
            className={`font-brand-body text-xs font-semibold uppercase tracking-wide mb-2 ${column.tone}`}
          >
            {column.label}
          </p>
          <div className="flex flex-col gap-3">
            {column.items.map((rule) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                asset={rule.assetId ? assetsById?.get(rule.assetId) : undefined}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
