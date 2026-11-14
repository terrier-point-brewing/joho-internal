import { Fragment, type ReactNode } from "react";
import type { SortState } from "@/lib/table/types";
import SortableTh from "./SortableTh";
import { DrawerCell, alignCls, type Align } from "./Table";

/**
 * The list / log table (docs/UI_STANDARD.md §7 B, "List and log tables"): one
 * row per thing, mostly text. A page describes its columns once and gives each
 * a role; the role decides what a phone does with it, so no page writes its
 * own `max-sm:hidden` / `sm:hidden` twins.
 *
 * | role       | from the fold breakpoint | below it                                   |
 * |------------|--------------------------|--------------------------------------------|
 * | `label`    | first column             | first column; carries everything folded    |
 * | `headline` | column                   | column (keep to one or two)                |
 * | `detail`   | column                   | joined into a muted sub-line under label   |
 * | `action`   | column, right-aligned    | a wrapping row of buttons under the label  |
 *
 * So a phone never scrolls a list sideways, and nothing a column showed is
 * lost. A `cell` that returns nothing renders the standard dash on desktop and
 * is dropped from the sub-line. `drawer` adds an expandable row laid out at
 * the viewport's width; its chevron rides in the label cell, not a column.
 */

export type ListRole = "label" | "headline" | "detail" | "action";

export type ListCol<T> = {
  key: string;
  header?: ReactNode;
  role?: ListRole;
  cell: (row: T, index: number) => ReactNode;
  align?: Align;
  /** Makes the header a sort button (needs `sort` and `onSort` on the table). */
  sortKey?: string;
  /** What the phone sub-line shows instead of `cell`; `false` leaves the column out of it. */
  fold?: ((row: T, index: number) => ReactNode) | false;
  /** A faint prefix in the sub-line, for a value that means nothing bare ("Owed 4.0"). */
  foldLabel?: string;
  /** Give the folded value a line of its own (a note, a progress bar). */
  foldBlock?: boolean;
  /** Extra classes for the column's `<td>`. */
  className?: string;
  /** Extra classes for the column's `<th>`. */
  headClassName?: string;
  /** A width class for the column from the fold breakpoint up (`w-[18%]`). Give every column one or none. */
  width?: string;
};

/** A run of rows under a full-width heading (one partner's deals, one day's entries). */
export type ListGroup<T> = {
  key: string | number;
  header?: ReactNode;
  rows: T[];
  footer?: ReactNode;
  /** Classes for every row of the group (a dimmed, locked group). */
  className?: string;
};

const BP = {
  sm: { col: "max-sm:hidden", fold: "sm:hidden", top: "max-sm:align-top" },
  md: { col: "max-md:hidden", fold: "md:hidden", top: "max-md:align-top" },
  lg: { col: "max-lg:hidden", fold: "lg:hidden", top: "max-lg:align-top" },
} as const;

const isBlank = (n: ReactNode) => n == null || n === false || n === "" || n === "—";
const DASH = <span className="text-disabled">—</span>;

export default function ListTable<T>({
  rows,
  groups,
  cols,
  rowKey,
  foldBelow = "sm",
  dense = false,
  zebra = true,
  sort,
  onSort,
  onRowClick,
  drawer,
  isOpen,
  rowClassName,
  rowRef,
  empty,
  footer,
  className = "",
}: {
  /** The rows, or `groups` for rows under headings. */
  rows?: T[];
  groups?: ListGroup<T>[];
  cols: ListCol<T>[];
  rowKey: (row: T, index: number) => string | number;
  /** Where detail and action columns fold under the label. `md`/`lg` for a table too wide for a tablet. */
  foldBelow?: keyof typeof BP;
  /** `px-3` cells from `sm` instead of `px-4`, for a table with many columns. */
  dense?: boolean;
  zebra?: boolean;
  sort?: SortState;
  onSort?: (key: string) => void;
  onRowClick?: (row: T) => void;
  /** The expanded row. Rendered when `isOpen(row)`. */
  drawer?: (row: T) => ReactNode;
  isOpen?: (row: T) => boolean;
  rowClassName?: (row: T) => string;
  rowRef?: (row: T) => ((el: HTMLTableRowElement | null) => void) | undefined;
  /** Shown in place of the body when there are no rows. */
  empty?: ReactNode;
  /** Totals under the rows. Not table cells, so it reads the same at every width. */
  footer?: ReactNode;
  className?: string;
}) {
  const bp = BP[foldBelow];
  const px = dense ? "px-2 sm:px-3" : "px-2 sm:px-4";
  const role = (c: ListCol<T>): ListRole => c.role ?? "detail";
  const stays = (c: ListCol<T>) => role(c) === "label" || role(c) === "headline";
  const labelKey = (cols.find((c) => role(c) === "label") ?? cols[0]).key;
  const folded = cols.filter((c) => role(c) === "detail" && c.fold !== false);
  const actions = cols.filter((c) => role(c) === "action");

  // The chevron rides in the first cell. When that is not the label it sits
  // there from the fold breakpoint up, and beside the label below it, unless
  // the first column stays on a phone too (a checkbox), in which case it
  // never moves.
  const first = cols[0];
  const chevronIn: "label" | "first" | "both" = first.key === labelKey ? "label" : stays(first) ? "first" : "both";
  const chevron = (row: T) => (
    <span aria-hidden className={`inline-block mt-1 text-faint text-[10px] leading-none transition-transform ${isOpen?.(row) ? "rotate-90" : ""}`}>▶</span>
  );

  const foldValue = (c: ListCol<T>, row: T, i: number) => (c.fold ? c.fold(row, i) : c.cell(row, i));

  function labelCell(c: ListCol<T>, row: T, i: number) {
    const inline: ReactNode[] = [];
    const blocks: ReactNode[] = [];
    for (const f of folded) {
      const v = foldValue(f, row, i);
      if (isBlank(v)) continue;
      const item = (
        <span key={f.key} className={f.foldBlock ? "block" : "relative inline-flex items-center gap-1 pl-3 before:absolute before:left-1 before:content-['·'] before:text-faint"}>
          {f.foldLabel && <span className="text-faint">{f.foldLabel}</span>}
          {v}
        </span>
      );
      (f.foldBlock ? blocks : inline).push(item);
    }
    const acts = actions.map((a) => ({ key: a.key, node: a.cell(row, i) })).filter((a) => !isBlank(a.node));
    return (
      <div className="flex items-start gap-1.5">
        {drawer && chevronIn !== "first" && <span className={chevronIn === "both" ? bp.fold : ""}>{chevron(row)}</span>}
        <div className="min-w-0 flex-1">
          {c.cell(row, i)}
          {inline.length > 0 && (
            // The dot between items sits in each item's left gutter; the row is
            // pulled left by that gutter and clipped, so a wrapped line never
            // starts with a dot.
            <div className={`${bp.fold} mt-0.5 overflow-hidden text-xs font-normal text-muted`}>
              <div className="-ml-3 flex flex-wrap items-center gap-y-0.5">{inline}</div>
            </div>
          )}
          {blocks.length > 0 && <div className={`${bp.fold} mt-0.5 space-y-0.5 text-xs font-normal text-muted`}>{blocks}</div>}
          {acts.length > 0 && (
            <div className={`${bp.fold} mt-1.5 flex flex-wrap items-center gap-1.5`} onClick={(e) => e.stopPropagation()}>
              {acts.map((a) => <Fragment key={a.key}>{a.node}</Fragment>)}
            </div>
          )}
        </div>
      </div>
    );
  }

  const clickable = !!(onRowClick || drawer);
  const sections: ListGroup<T>[] = groups ?? [{ key: "rows", rows: rows ?? [] }];
  const total = sections.reduce((n, g) => n + g.rows.length, 0);
  const widths = cols.some((c) => c.width);

  return (
    <div className={`scroll-x rounded-lg border border-line ${className}`}>
      <table className="w-full text-sm [&>tbody>tr:last-child]:border-0">
        {widths && <colgroup className={bp.col}>{cols.map((c) => <col key={c.key} className={c.width} />)}</colgroup>}
        <thead>
          <tr className="border-b border-line bg-surface/50 text-left">
            {cols.map((c) => {
              const hide = stays(c) ? "" : bp.col;
              if (c.sortKey && onSort && typeof c.header === "string") {
                return (
                  <SortableTh
                    key={c.key}
                    label={c.header}
                    sortKey={c.sortKey}
                    sort={sort ?? null}
                    onSort={onSort}
                    align={c.align === "right" ? "right" : "left"}
                    className={`text-xs !text-muted !py-2.5 ${dense ? "sm:!px-3" : ""} ${hide} ${c.headClassName ?? ""}`}
                  />
                );
              }
              return (
                <th key={c.key} className={`${px} py-2.5 text-xs font-medium text-muted whitespace-nowrap ${alignCls(c.align)} ${hide} ${c.headClassName ?? ""}`}>
                  {c.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {total === 0 && empty && (
            <tr>
              <td colSpan={cols.length} className="px-3 py-6 text-center text-faint text-sm">{empty}</td>
            </tr>
          )}
          {sections.map((g) => (
            <Fragment key={g.key}>
              {g.header && (
                <tr className={`border-b border-line bg-surface/40 ${g.className ?? ""}`}>
                  <td colSpan={cols.length} className={`${px} py-2`}>{g.header}</td>
                </tr>
              )}
              {g.rows.map((row, i) => {
                const open = !!drawer && !!isOpen?.(row);
                return (
                  <Fragment key={rowKey(row, i)}>
                    <tr
                      ref={rowRef?.(row)}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      className={`border-b border-line/60 ${zebra && i % 2 !== 0 ? "bg-surface/30" : ""} ${clickable ? "cursor-pointer hover:bg-surface/40" : ""} ${g.className ?? ""} ${rowClassName?.(row) ?? ""}`}
                    >
                      {cols.map((c) => {
                        const r = role(c);
                        if (c.key === labelKey) {
                          return <td key={c.key} className={`${px} py-2.5 ${bp.top} font-medium text-primary ${c.className ?? ""}`}>{labelCell(c, row, i)}</td>;
                        }
                        const v = c.cell(row, i);
                        return (
                          <td
                            key={c.key}
                            onClick={r === "action" ? (e) => e.stopPropagation() : undefined}
                            className={`${px} py-2.5 ${alignCls(r === "action" ? c.align ?? "right" : c.align)} ${r === "headline" ? `${bp.top} whitespace-nowrap` : ""} ${stays(c) ? "" : bp.col} ${c.className ?? ""}`}
                          >
                            {r === "action" ? <div className="flex items-center justify-end gap-1">{v}</div>
                              : drawer && c.key === first.key ? <div className="flex items-start gap-1.5">{chevron(row)}{isBlank(v) ? null : v}</div>
                              : isBlank(v) ? DASH : v}
                          </td>
                        );
                      })}
                    </tr>
                    {open && (
                      <tr className={`border-b border-line/60 bg-surface/40 ${g.className ?? ""}`}>
                        <DrawerCell colSpan={cols.length}>{drawer!(row)}</DrawerCell>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {g.footer && (
                <tr className="border-b border-line/60 bg-surface/20">
                  <DrawerCell colSpan={cols.length}>{g.footer}</DrawerCell>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {footer && <div className="border-t border-line">{footer}</div>}
    </div>
  );
}
