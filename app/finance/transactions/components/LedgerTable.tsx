"use client";

import { shortAccountName } from "../../AccountSelect";

// ── Shared table shell + header cells for the Transactions subtabs ─────────────
// One row-per-transaction ledger with an expandable detail drawer. Sorting now
// comes from useTableControls + app/components/ui/SortableTh; this owns the table
// shell, the static header cell, and the category badges.

type Align = "left" | "right" | "center";
const alignCls = (a: Align) => (a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left");

/** Static (non-sortable) column header. */
export function Th({ label, align = "left", className = "" }: { label?: string; align?: Align; className?: string }) {
  return <th className={`px-4 py-2 ${alignCls(align)} text-muted font-medium ${className}`}>{label}</th>;
}

/**
 * Bordered table card + header row. Pass shared `<SortableTh>` / `<Th>` cells as
 * `head`. The inner `overflow-x-auto` lets wide rows scroll horizontally within
 * the card instead of spilling past it (the rounded card keeps `overflow-hidden`
 * so its corners still clip the table's square edges).
 *
 * `groupHead` is an optional row of colspan'd `<th>`s rendered above `head`, for
 * tables whose columns only make sense in bands (Finance → Payroll groups its
 * Gusto figures so the reader can see they sum to a total). Omit it and the
 * header is a single row exactly as before.
 *
 * `fill` switches the card from "as tall as its rows" to "as tall as the space
 * it's given", making the card itself the scroll container and freezing the
 * column headers at its top. The Transactions subtabs opt in: they are all one
 * ledger apiece, so scrolling the page and scrolling the rows were the same
 * gesture, except the page version carried the headers away with it. Callers
 * that sit inside a normally-scrolling page (Payroll, the Settings backfills,
 * Period Close) leave it off and are untouched.
 */
export function LedgerTable({
  head,
  groupHead,
  children,
  fill = false,
}: {
  head: React.ReactNode;
  groupHead?: React.ReactNode;
  children: React.ReactNode;
  fill?: boolean;
}) {
  // A sticky <th> inside a border-collapse table drops its own border as it
  // detaches, so the header row's hairline is drawn as an inset shadow instead
  // — that travels with the cell.
  const headRowCls = fill ? "" : "border-b border-line";
  return (
    <div className={`bg-surface border border-line rounded-lg overflow-hidden ${fill ? "flex-1 min-h-0 flex flex-col" : ""}`}>
      <div className={fill ? "flex-1 min-h-0 overflow-auto" : "overflow-x-auto"}>
        <table className="w-full text-xs border-collapse">
          <thead
            className={
              fill
                ? "sticky top-0 z-20 [&_th]:bg-surface [&_th]:shadow-[inset_0_-1px_0_var(--color-line)]"
                : ""
            }>
            {groupHead && <tr className={headRowCls}>{groupHead}</tr>}
            <tr className={headRowCls}>{head}</tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Neutral pill for GL-account / category names (dynamic values, no fixed palette).
 * Caps its width and truncates so a long colon-path GL name can't blow the table
 * past a laptop's viewport; the full value stays available via the `title` tooltip.
 */
export function CategoryBadge({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-block max-w-[200px] truncate align-middle px-1.5 py-0.5 rounded text-2xs font-medium bg-surface-mid text-secondary">
      {children}
    </span>
  );
}

/**
 * Render up to `max` category badges from a list, collapsing the rest into "+N".
 * GL-account names come through as full colon-paths — show just the leaf segment
 * (with the full path in the tooltip) so the column stays compact.
 */
export function CategoryBadges({ items, max = 2 }: { items: string[]; max?: number }) {
  if (items.length === 0) return <span className="text-disabled">—</span>;
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((c) => <CategoryBadge key={c} title={c}>{shortAccountName(c)}</CategoryBadge>)}
      {rest > 0 && <span className="text-2xs text-faint" title={items.join(", ")}>+{rest}</span>}
    </div>
  );
}
