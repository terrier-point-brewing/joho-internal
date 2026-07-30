/**
 * A section heading inside a guide subtab: the kicker, and optionally a line
 * explaining what the section is.
 *
 * The two are deliberately different weights. Where the guide previously used
 * one class for both a label and its explanation, neither read as primary —
 * the Voice tab's calibration notes were the clearest casualty.
 */
export default function SubHead({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-3">
      <p className="font-brand-body text-xs font-semibold uppercase tracking-wide text-brand-content-muted">
        {title}
      </p>
      {description && (
        <p className="font-brand-body text-sm text-brand-content mt-1 max-w-3xl leading-relaxed">
          {description}
        </p>
      )}
    </div>
  );
}
