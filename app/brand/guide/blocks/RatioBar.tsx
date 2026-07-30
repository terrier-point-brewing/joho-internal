import type { BrandCanon } from "@/lib/brand/canon.types";

type Ratio = BrandCanon["usageRatios"][number];

/**
 * Usage ratios as a single proportion bar.
 *
 * "60%" appended to a swatch label is a number you have to imagine; a bar is
 * the thing itself. The whole point of a 60/30/10 rule is the relative weight,
 * which a list of percentages actively hides.
 */
export default function RatioBar({
  ratios,
  hexForRole,
}: {
  ratios: Ratio[];
  hexForRole: (role: Ratio["role"]) => string;
}) {
  if (ratios.length === 0) return null;

  const total = ratios.reduce((sum, r) => sum + r.pct, 0);
  if (total <= 0) return null;

  return (
    <div>
      <div className="flex h-6 rounded overflow-hidden border border-brand-line">
        {ratios.map((ratio) => (
          <div
            key={ratio.role}
            style={{ background: hexForRole(ratio.role), width: `${(ratio.pct / total) * 100}%` }}
            title={`${ratio.role} · ${ratio.pct}%`}
          />
        ))}
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 mt-2">
        {ratios.map((ratio) => (
          <div key={ratio.role} className="flex items-baseline gap-1.5">
            <dt className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted">
              {ratio.role}
            </dt>
            <dd className="font-brand-body text-xs tabular-nums text-brand-high-contrast">
              {ratio.pct}%
            </dd>
            {ratio.note && (
              <dd className="font-brand-body text-2xs text-brand-content-muted">{ratio.note}</dd>
            )}
          </div>
        ))}
      </dl>
    </div>
  );
}
