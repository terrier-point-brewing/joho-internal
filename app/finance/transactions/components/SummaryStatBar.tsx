"use client";

export type StatTone = "strong" | "accent" | "secondary";

export interface Stat {
  label: string;
  value: React.ReactNode;
  tone?: StatTone;
}

const TONE_CLS: Record<StatTone, string> = {
  strong:    "text-strong",
  accent:    "text-accent",
  secondary: "text-secondary",
};

/**
 * Shared summary bar for the Transactions subtabs — a row of label/value
 * stats. Promoted from the Invoices page so Orders and Expenses read the same.
 *
 * Rendered as the page's bottom rail, frozen under the table rather than above
 * it: these are totals over the rows on screen, and a totals line belongs at
 * the foot of a ledger. It also keeps the header/filter stack short so the
 * table itself gets the vertical space.
 *
 * Inset with `mx-` rather than padded with `px-`, so its rule starts and ends
 * exactly where the subtab bar's underline and the table card's edges do — a
 * horizontal rule that overshoots the content it belongs to reads as a page
 * divider instead of a footer.
 */
export default function SummaryStatBar({ stats }: { stats: Stat[] }) {
  if (stats.length === 0) return null;
  return (
    <div className="shrink-0 flex flex-wrap items-center gap-4 sm:gap-6 mx-4 sm:mx-6 py-2 border-t border-line/60">
      {stats.map((s) => (
        <div key={s.label}>
          <span className="text-xs text-muted">{s.label} </span>
          <span className={`text-sm font-semibold ${TONE_CLS[s.tone ?? "strong"]}`}>{s.value}</span>
        </div>
      ))}
    </div>
  );
}
