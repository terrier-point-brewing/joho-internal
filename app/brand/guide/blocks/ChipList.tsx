/**
 * A labelled row of word chips.
 *
 * Vocabulary lists used to sit inline as `Lean on: a, b, c` in a run of small
 * text, which made a working reference look like a footnote. Chips give each
 * word its own boundary so the list can be scanned rather than read.
 *
 * Renders nothing when there are no words — an empty labelled panel is worse
 * than no panel.
 */
export default function ChipList({
  label,
  words,
  tone = "neutral",
}: {
  label: string;
  words: string[];
  tone?: "neutral" | "accent";
}) {
  if (words.length === 0) return null;

  return (
    <div>
      <p
        className={`font-brand-body text-2xs uppercase tracking-wide mb-1.5 ${
          tone === "accent" ? "text-brand-accent" : "text-brand-content-muted"
        }`}
      >
        {label}
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {words.map((word, i) => (
          <li
            key={i}
            className={`font-brand-body text-xs rounded-full border px-2.5 py-0.5 ${
              tone === "accent"
                ? "border-brand-accent text-brand-accent"
                : "border-brand-line-strong text-brand-content"
            }`}
          >
            {word}
          </li>
        ))}
      </ul>
    </div>
  );
}
