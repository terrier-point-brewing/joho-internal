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
 *
 * `variant="template"` is the same card holding instructions rather than
 * content — Voice's naming template sits above four passing examples, and it
 * has to be the same object with the same labels for "here is the rule for this
 * line" to land, differing only by an accent hairline and a tag.
 */
export default function SpecCard({
  eyebrow,
  title,
  rows,
  variant = "default",
  tag,
  footer,
}: {
  eyebrow?: string;
  title: string;
  rows: SpecRow[];
  variant?: "default" | "template";
  /** Small label in the card header — what makes a template card legible as one. */
  tag?: string;
  /** Closing line, set apart in the display face below a hairline. */
  footer?: string;
}) {
  const isTemplate = variant === "template";

  return (
    <div
      className={`rounded-lg border p-4 ${
        isTemplate ? "border-brand-accent bg-brand-surface" : "border-brand-line"
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-brand-display text-lg text-brand-high-contrast">
          {eyebrow && <span className="text-brand-content-muted">{eyebrow} · </span>}
          {title}
        </p>
        {tag && (
          <span
            className={`font-brand-body text-2xs uppercase tracking-wide rounded-full border px-2.5 py-0.5 shrink-0 ${
              isTemplate
                ? "border-brand-accent text-brand-accent"
                : "border-brand-line-strong text-brand-content-muted"
            }`}
          >
            {tag}
          </span>
        )}
      </div>

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

      {footer && (
        <p className="font-brand-display text-sm text-brand-high-contrast mt-4 pt-3 border-t border-brand-line-strong leading-relaxed">
          {footer}
        </p>
      )}
    </div>
  );
}
