import { type ReactNode } from "react";
import Card from "./Card";

/**
 * Phone-first table primitives (docs/UI_STANDARD.md §7, pattern B).
 *
 * A desktop table is the wrong shape for a 390px screen, and sideways scroll
 * is the fallback, not the design. These give every hand-written table the
 * same three moves without a per-page layout:
 *
 * - `<Table>` is the scroll container: `Card scroll="x"` (hidden scrollbar,
 *   contained swipe, overflow fade) with the standard phone bleed, and `pin`
 *   keeps the first column in view while the rest scrolls.
 * - `<Th hide="sm">` / `<Td hide="sm">` drop a column below a breakpoint. Pair
 *   them: the header and every body cell for that column take the same
 *   `hide`, so rows stay aligned. Keep the columns the reader acts on;
 *   fold the rest into a sub-line or the expanded row.
 * - `<DrawerCell>` is the full-width row under an expanded row. It lays out
 *   at the viewport's width, not the table's scroll width, so an editor in
 *   it (and its Save button) is never off-screen.
 *
 * - `<CellLabel>` is what goes in the pinned cell. It caps the label at 40%
 *   of a phone's width (wrapping to two lines, then clipping) so a pinned
 *   column can never crowd out the numbers, and carries the `sub` line that
 *   hidden descriptive columns fold into.
 *
 * Cell padding is tight on a phone (`px-2`) and the usual `px-4` from `sm`.
 */

export type Align = "left" | "right" | "center";
export type Hide = "sm" | "md";

export const alignCls = (a: Align = "left") => (a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left");
export const hideCls = (h?: Hide) => (h === "sm" ? "max-sm:hidden" : h === "md" ? "max-md:hidden" : "");
export const CELL = "px-2 sm:px-4 py-2";

export function Table({
  children,
  pin = false,
  bleed = true,
  className = "",
  size = "xs",
}: {
  children: ReactNode;
  /** Keep the first column in view while the rows scroll sideways. */
  pin?: boolean;
  /** Edge-to-edge below `sm` (the default for a table sitting in a `px-4` page). */
  bleed?: boolean;
  className?: string;
  size?: "xs" | "sm";
}) {
  return (
    <Card padding="" scroll="x" bleed={bleed} className={className}>
      <table className={`w-full border-collapse ${size === "xs" ? "text-xs" : "text-sm"} ${pin ? "tbl-pin" : ""}`}>{children}</table>
    </Card>
  );
}

export function Th({ children, align, hide, className = "", colSpan }: { children?: ReactNode; align?: Align; hide?: Hide; className?: string; colSpan?: number }) {
  return <th colSpan={colSpan} className={`${CELL} ${alignCls(align)} text-muted font-medium ${hideCls(hide)} ${className}`}>{children}</th>;
}

export function Td({ children, align, hide, className = "", colSpan, onClick, title }: {
  children?: ReactNode; align?: Align; hide?: Hide; className?: string; colSpan?: number; onClick?: () => void; title?: string;
}) {
  return <td colSpan={colSpan} onClick={onClick} title={title} className={`${CELL} ${alignCls(align)} ${hideCls(hide)} ${className}`}>{children}</td>;
}

export function DrawerCell({ colSpan, children, className = "" }: { colSpan: number; children: ReactNode; className?: string }) {
  return (
    <td colSpan={colSpan} className="p-0">
      <div className={`sticky left-0 max-w-[calc(100vw-2rem)] desk:max-w-none ${className}`}>{children}</div>
    </td>
  );
}

/**
 * The row's identity, for a pinned first cell. Below `sm` it is at most 40vw
 * wide and two lines tall; from `sm` it is one line. `sub` is the faint
 * second line a hidden column folds into (give it the same breakpoint as the
 * column's `hide`, e.g. `<span className="md:hidden">`).
 */
export function CellLabel({ children, sub, swatch }: {
  children: ReactNode;
  sub?: ReactNode;
  /** A series colour tying the row to a chart line; `null` keeps the slot so labels stay aligned. */
  swatch?: string | null;
}) {
  return (
    <div className="flex items-start gap-1.5 max-sm:w-max max-sm:max-w-[40vw] sm:max-w-72">
      {swatch !== undefined && (
        <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={swatch ? { background: swatch } : undefined} />
      )}
      <div className="min-w-0">
        <div className="font-medium text-strong max-sm:line-clamp-2 sm:truncate">{children}</div>
        {sub && <div className="text-2xs text-faint font-normal truncate">{sub}</div>}
      </div>
    </div>
  );
}
