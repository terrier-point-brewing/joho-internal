"use client";

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

/** Bordered table card + header row. Pass shared `<SortableTh>` / `<Th>` cells as `head`. */
export function LedgerTable({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-line rounded-lg overflow-hidden">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b border-line">{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Neutral pill for GL-account / category names (dynamic values, no fixed palette). */
export function CategoryBadge({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-mid text-secondary whitespace-nowrap">
      {children}
    </span>
  );
}

/** Render up to `max` category badges from a list, collapsing the rest into "+N". */
export function CategoryBadges({ items, max = 2 }: { items: string[]; max?: number }) {
  if (items.length === 0) return <span className="text-disabled">—</span>;
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((c) => <CategoryBadge key={c} title={c}>{c}</CategoryBadge>)}
      {rest > 0 && <span className="text-[10px] text-faint" title={items.join(", ")}>+{rest}</span>}
    </div>
  );
}
