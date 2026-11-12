"use client";

import { shortAccountName } from "../../AccountSelect";
import Badge from "@/app/components/ui/Badge";

// ── Shared table shell + header cells for the Transactions subtabs ─────────────
// One row-per-transaction ledger with an expandable detail drawer. Sorting now
// comes from useTableControls + app/components/ui/SortableTh; this owns the table
// shell, the static header cell, and the category badges.

type Align = "left" | "right" | "center";
const alignCls = (a: Align) => (a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left");

/** Below which breakpoint a column is dropped on a handheld (pattern B). */
export type Hide = "sm" | "md";
export const hideCls = (h?: Hide) => (h === "sm" ? "max-sm:hidden" : h === "md" ? "max-md:hidden" : "");

/** Ledger cell padding: tight on a phone, where eight `px-4` cells spend 256px on gutters. */
export const CELL = "px-2 sm:px-4 py-2";

/**
 * Static (non-sortable) column header. `hide` drops the column below that
 * breakpoint; the matching <td>s take the same `hideCls`/`<Td hide>` so the
 * row stays aligned.
 */
export function Th({ label, align = "left", className = "", hide }: { label?: string; align?: Align; className?: string; hide?: Hide }) {
  return <th className={`${CELL} ${alignCls(align)} text-muted font-medium ${hideCls(hide)} ${className}`}>{label}</th>;
}

/** Body cell with the ledger's padding and the same `hide` contract as <Th>. */
export function Td({ children, align = "left", className = "", hide, colSpan, onClick }: {
  children?: React.ReactNode; align?: Align; className?: string; hide?: Hide; colSpan?: number; onClick?: () => void;
}) {
  return <td colSpan={colSpan} onClick={onClick} className={`${CELL} ${alignCls(align)} ${hideCls(hide)} ${className}`}>{children}</td>;
}

/**
 * The full-width drawer under an expanded row. A `colSpan` cell is as wide as
 * the table's scroll width, so anything laid out inside it (split editors,
 * their Save button) can sit off-screen on a phone. The inner box pins itself
 * to the left edge and caps at the viewport, so the drawer lays out at the
 * width the reader can see, whatever the table behind it is doing.
 */
export function DrawerCell({ colSpan, children, className = "" }: { colSpan: number; children: React.ReactNode; className?: string }) {
  return (
    <td colSpan={colSpan} className="p-0">
      <div className={`sticky left-0 max-w-[calc(100vw-2rem)] desk:max-w-none ${className}`}>{children}</div>
    </td>
  );
}

/**
 * Bordered table card + header row. Pass shared `<SortableTh>` / `<Th>` cells as
 * `head`. The inner `.scroll-x` lets wide rows scroll horizontally within
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
 *
 * `fill` only engages on a `desk:` viewport. On a handheld the page is a
 * normal block and the app pane scrolls (pattern A), so the card is just a
 * `.scroll-x` strip like the non-fill case — an inner scroller there was a
 * 0–230px window fighting the page.
 *
 * `pin` keeps the first column in view while the rows scroll sideways.
 */
export function LedgerTable({
  head,
  groupHead,
  children,
  fill = false,
  pin = false,
}: {
  head: React.ReactNode;
  groupHead?: React.ReactNode;
  children: React.ReactNode;
  fill?: boolean;
  pin?: boolean;
}) {
  // A sticky <th> inside a border-collapse table drops its own border as it
  // detaches, so the header row's hairline is drawn as an inset shadow instead
  // — that travels with the cell.
  const headRowCls = fill ? "" : "border-b border-line";
  return (
    <div className={`bg-surface border border-line rounded-lg overflow-hidden ${fill ? "desk:flex-1 desk:min-h-0 desk:flex desk:flex-col" : ""}`}>
      <div className={`scroll-x ${fill ? "desk:flex-1 desk:min-h-0 desk:overflow-auto desk:overscroll-x-contain" : ""}`}>
        <table className={`w-full text-xs border-collapse ${pin ? "tbl-pin" : ""}`}>
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
  // `title` sits on a wrapping span rather than on <Badge> itself (which has
  // no title prop) — a native title tooltip still resolves to the nearest
  // ancestor that has one, so the truncated full value stays available on hover.
  return (
    <span title={title}>
      <Badge className="max-w-[200px] truncate align-middle">{children}</Badge>
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
