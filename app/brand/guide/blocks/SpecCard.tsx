export interface SpecRow {
  label: string;
  value: string;
  /** `accent` colours the LABEL only — never the value. */
  tone?: "default" | "accent";
}

/**
 * A titled card whose body is a set of labelled rows.
 *
 * Every row gets the same label treatment. That symmetry is the point: Ethos
 * previously labelled only "The cost" and left "what it means" as unlabelled
 * body text, so the two halves of a value read as different kinds of thing when
 * they're the same kind of thing.
 */
export default function SpecCard({
  eyebrow,
  title,
  rows,
}: {
  eyebrow?: string;
  title: string;
  rows: SpecRow[];
}) {
  return (
    <div className="rounded-lg border border-brand-line p-4">
      <p className="font-brand-display text-lg text-brand-high-contrast">
        {eyebrow && <span className="text-brand-content-muted">{eyebrow} · </span>}
        {title}
      </p>

      <dl className="mt-3 flex flex-col gap-3">
        {rows.map((row, i) => (
          <div key={i}>
            <dt
              className={`font-brand-body text-2xs uppercase tracking-wide ${
                row.tone === "accent" ? "text-brand-accent" : "text-brand-content-muted"
              }`}
            >
              {row.label}
            </dt>
            <dd className="font-brand-body text-sm text-brand-content mt-0.5 leading-relaxed">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
