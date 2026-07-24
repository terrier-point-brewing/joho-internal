import type { ReactNode } from "react";

/** Shared second-level label style (sub-headings within a section). */
export const KICKER =
  "font-brand-body text-xs font-semibold uppercase tracking-wide text-brand-content-muted";

/**
 * Section heading for the brand guide: optional reference number + large
 * display-face title + optional lead, over a hairline rule. Used by the long
 * narrative tab (numbered) and by the single-topic Color/Type/Marks tabs
 * (unnumbered).
 */
export default function GuideSection({
  id,
  num,
  title,
  lead,
  children,
}: {
  id?: string;
  num?: string;
  title: string;
  lead?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-8">
      <header className="mb-6 border-b border-brand-line pb-4">
        <div className="flex items-baseline gap-3">
          {num && <span className="font-brand-body text-sm tabular-nums text-brand-accent">{num}</span>}
          <h2 className="font-brand-display text-2xl sm:text-3xl text-brand-high-contrast">{title}</h2>
        </div>
        {lead && (
          <p className="font-brand-body text-sm text-brand-content-muted mt-2 max-w-3xl">{lead}</p>
        )}
      </header>
      {children}
    </section>
  );
}
