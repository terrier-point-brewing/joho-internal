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
 */
export default function SummaryStatBar({ stats }: { stats: Stat[] }) {
  if (stats.length === 0) return null;
  return (
    <div className="shrink-0 flex flex-wrap items-center gap-4 sm:gap-6 px-4 sm:px-6 py-3 border-b border-line/60 bg-surface/30">
      {stats.map((s) => (
        <div key={s.label}>
          <span className="text-xs text-muted">{s.label} </span>
          <span className={`text-sm font-semibold ${TONE_CLS[s.tone ?? "strong"]}`}>{s.value}</span>
        </div>
      ))}
    </div>
  );
}
