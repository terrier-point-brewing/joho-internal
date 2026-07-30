export interface ComparisonSide {
  label: string;
  value: string;
}

/**
 * Two labelled sides shown next to each other.
 *
 * Left-vs-right rather than stacked: people read a comparison horizontally, and
 * with the columns aligned across rows you can scan one column on its own — all
 * the on-voice examples, say — which a stacked layout makes impossible.
 * Collapses to one column below `sm`, where side-by-side would be too narrow.
 */
export default function ComparisonCard({
  context,
  left,
  right,
}: {
  context: string;
  left: ComparisonSide;
  right: ComparisonSide;
}) {
  return (
    <div className="rounded-lg border border-brand-line overflow-hidden">
      <p className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted px-3 py-2 border-b border-brand-line">
        {context}
      </p>
      <div className="grid sm:grid-cols-2">
        <div className="p-3">
          <p className="font-brand-body text-2xs uppercase tracking-wide text-brand-primary">
            {left.label}
          </p>
          <p className="font-brand-body text-sm text-brand-content mt-1 leading-relaxed">
            {left.value}
          </p>
        </div>
        <div className="p-3 border-t sm:border-t-0 sm:border-l border-brand-line">
          <p className="font-brand-body text-2xs uppercase tracking-wide text-brand-accent">
            {right.label}
          </p>
          <p className="font-brand-body text-sm text-brand-content-muted mt-1 leading-relaxed">
            {right.value}
          </p>
        </div>
      </div>
    </div>
  );
}
