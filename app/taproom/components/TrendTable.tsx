"use client";

import type { ReactNode } from "react";
import { Table, Th, Td, type Hide } from "@/app/components/ui/Table";
import type { TrendRow } from "@/lib/reports/draftTrend";

export interface TrendTableSummary {
  label: string;
  title?: string;
  value: (row: TrendRow) => string;
  /** Drop the column below a breakpoint. The first column is never hidden. */
  hide?: Hide;
}

/**
 * The matrix behind a trend chart: one pinned label, a few summary columns,
 * then one column per bucket, newest first. The reference for a table with
 * fixed columns and more columns than a phone can show
 * (docs/UI_STANDARD.md §7 B, "wide tables"):
 *
 * - One pinned column, capped at 40% of a phone's width by `<CellLabel>`.
 * - Descriptive columns fold into the label's sub-line; secondary summaries
 *   take `hide`. At 390px the label, the headline number and at least two
 *   buckets are in view before any scrolling.
 * - No action column on a phone. The headline number is the link to the
 *   records behind it; from `md` the action gets its own labelled column.
 * - A tap is the only gesture. Nothing hangs off a double-click.
 */
export default function TrendTable({
  labelHeader, rows, overall, buckets, bucketHeader, describe = [], summary, cell, renderLabel,
  onRowClick, isActive, details,
}: {
  labelHeader: string;
  rows: TrendRow[];
  overall?: { label: string; row: TrendRow } | null;
  /** Bucket keys in display order (newest first). */
  buckets: string[];
  bucketHeader: (bucket: string) => { top: string; main: string };
  /**
   * Descriptive columns (a category, an owner). Give each a `hide` and repeat
   * the value in the label's sub-line below that breakpoint.
   */
  describe?: { label: string; value: (row: TrendRow) => ReactNode; hide: Hide }[];
  summary: TrendTableSummary[];
  cell: (v: number | null | undefined) => string;
  /** A `<CellLabel>` for the row. */
  renderLabel: (row: TrendRow) => ReactNode;
  onRowClick: (row: TrendRow) => void;
  isActive?: (row: TrendRow) => boolean;
  /** When given, every row can open the records behind it. */
  details?: { label: string; onOpen: (row: TrendRow) => void };
}) {
  const line = "border-b border-line/40";
  return (
    <Table pin className="sm:w-fit sm:max-w-full">
      <thead>
        <tr className="border-b border-line">
          <Th className="font-semibold text-secondary whitespace-nowrap">{labelHeader}</Th>
          {describe.map((d) => (
            <Th key={d.label} hide={d.hide} className="font-semibold text-secondary whitespace-nowrap">{d.label}</Th>
          ))}
          {summary.map((c, i) => (
            <Th key={c.label} align="right" hide={i === 0 ? undefined : c.hide} className="font-semibold text-secondary whitespace-nowrap">
              <span title={c.title}>{c.label}</span>
            </Th>
          ))}
          {details && <Th hide="md" />}
          {buckets.map((b, i) => {
            const h = bucketHeader(b);
            return (
              <Th key={b} align="right" className={`text-secondary whitespace-nowrap ${i === 0 ? "border-l border-line" : ""}`}>
                <span className="block text-faint">{h.top}</span>
                {h.main}
              </Th>
            );
          })}
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {rows.map((r) => {
          const active = isActive?.(r) ?? false;
          return (
            <tr
              key={r.recipe_id}
              data-active={active}
              onClick={() => onRowClick(r)}
              className={`cursor-pointer select-none ${active ? "bg-accent-muted/20" : "hover:bg-surface-mid/40"}`}
            >
              <Td className={line}>{renderLabel(r)}</Td>
              {describe.map((d) => (
                <Td key={d.label} hide={d.hide} className={`${line} text-muted whitespace-nowrap`}>{d.value(r)}</Td>
              ))}
              {summary.map((c, i) => (
                <Td key={c.label} align="right" hide={i === 0 ? undefined : c.hide} className={`${line} ${i === 0 ? "font-semibold text-strong" : "text-body"}`}>
                  {i === 0 && details ? (
                    <>
                      <span className="max-md:hidden">{c.value(r)}</span>
                      <button
                        type="button"
                        aria-label={`${details.label}: ${r.beer_name}`}
                        className="md:hidden -my-2 -mx-2 px-2 py-2 font-semibold text-accent underline decoration-dotted underline-offset-4"
                        onClick={(e) => { e.stopPropagation(); details.onOpen(r); }}
                      >
                        {c.value(r)}
                      </button>
                    </>
                  ) : c.value(r)}
                </Td>
              ))}
              {details && (
                <Td hide="md" className={line}>
                  <button
                    type="button"
                    className="py-1 text-2xs text-accent hover:underline whitespace-nowrap"
                    onClick={(e) => { e.stopPropagation(); details.onOpen(r); }}
                  >
                    {details.label}
                  </button>
                </Td>
              )}
              {buckets.map((b, i) => (
                <Td key={b} align="right" className={`${line} ${i === 0 ? "border-l" : ""} ${r.by_bucket[b] != null ? "text-body" : "text-faint"}`}>
                  {cell(r.by_bucket[b])}
                </Td>
              ))}
            </tr>
          );
        })}
        {overall && (
          <tr className="font-semibold text-strong">
            <Td className="whitespace-nowrap">{overall.label}</Td>
            {describe.map((d) => <Td key={d.label} hide={d.hide} />)}
            {summary.map((c, i) => (
              <Td key={c.label} align="right" hide={i === 0 ? undefined : c.hide}>{c.value(overall.row)}</Td>
            ))}
            {details && <Td hide="md" />}
            {buckets.map((b, i) => (
              <Td key={b} align="right" className={i === 0 ? "border-l border-line/40" : ""}>{cell(overall.row.by_bucket[b])}</Td>
            ))}
          </tr>
        )}
      </tbody>
    </Table>
  );
}
