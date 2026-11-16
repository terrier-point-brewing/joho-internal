import { type ReactNode } from "react";
import { alignCls, type Align } from "./Table";

/**
 * An editable grid: a row of inputs per item (docs/UI_STANDARD.md §7 B, "a
 * wide editable grid becomes one card per row"). From `sm` it is a table. On
 * a phone the same markup lays out as one card per row, each control under
 * its own label, two to a line, so nothing scrolls sideways and the page
 * does not keep a second, hand-written phone copy of the form.
 *
 * It is one DOM, restyled, so an input keeps focus and state across a
 * rotation, and a new column is added in one place.
 */

export type EditCol<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  align?: Align;
  /** A width class for the table column, written with its breakpoint (`sm:w-20`). */
  width?: string;
  /** Take the whole card row on a phone (a name, a long select). Default is half. */
  wide?: boolean;
  /** Read-only value the phone card can drop when it has nothing to show. */
  hideIfEmpty?: (row: T) => boolean;
};

export default function EditGrid<T>({
  rows,
  cols,
  onRemove,
  itemLabel = "Row",
  rowKey,
  rowClassName,
  className = "",
}: {
  rows: T[];
  cols: EditCol<T>[];
  onRemove?: (index: number) => void;
  /** What one row is called on its phone card ("Step 3"). */
  itemLabel?: string;
  rowKey?: (row: T, index: number) => string | number;
  /** Extra classes for one row (an unsaved-edit tint). */
  rowClassName?: (row: T, index: number) => string;
  className?: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className={`sm:rounded sm:border sm:border-line sm:scroll-x ${className}`}>
      <table className="w-full text-sm max-sm:block">
        <thead className="max-sm:hidden">
          <tr className="border-b border-line bg-surface/50">
            {cols.map((c) => (
              <th key={c.key} className={`px-3 py-2 text-xs font-medium text-muted whitespace-nowrap ${alignCls(c.align)} ${c.width ?? ""}`}>{c.header}</th>
            ))}
            {onRemove && <th className="px-3 py-2 w-6" />}
          </tr>
        </thead>
        <tbody className="max-sm:block max-sm:space-y-2">
          {rows.map((row, i) => (
            <tr
              key={rowKey ? rowKey(row, i) : i}
              className={`max-sm:grid max-sm:grid-cols-2 max-sm:gap-x-2 max-sm:gap-y-2 max-sm:rounded max-sm:border max-sm:border-line max-sm:p-3 sm:border-b sm:border-line/60 sm:last:border-0 ${i % 2 !== 0 ? "sm:bg-surface/20" : ""} ${rowClassName?.(row, i) ?? ""}`}
            >
              <td className="sm:hidden col-span-2 flex items-center justify-between gap-2">
                <span className="text-xs text-muted font-medium">{itemLabel} {i + 1}</span>
                {onRemove && <button type="button" onClick={() => onRemove(i)} className="btn-danger btn-xxs">× Remove</button>}
              </td>
              {cols.map((c) => (
                <td
                  key={c.key}
                  className={`max-sm:block max-sm:min-w-0 ${c.wide ? "max-sm:col-span-2" : ""} ${c.hideIfEmpty?.(row) ? "max-sm:hidden" : ""} sm:px-2 sm:py-1.5 sm:first:pl-3 ${c.align === "right" ? "sm:text-right" : c.align === "center" ? "sm:text-center" : ""} ${c.width ?? ""}`}
                >
                  <span className="sm:hidden block text-xs text-muted mb-1">{c.header}</span>
                  {c.cell(row, i)}
                </td>
              ))}
              {onRemove && (
                <td className="max-sm:hidden px-3 py-1.5 text-center">
                  <button type="button" onClick={() => onRemove(i)} aria-label={`Remove ${itemLabel.toLowerCase()} ${i + 1}`} className="btn-danger btn-xxs">×</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
