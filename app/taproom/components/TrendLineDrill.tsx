"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { SALES_REPORT_STALE_TIME } from "@/lib/query-keys";
import type { TrendLine } from "@/lib/reports/trendLines";

function formatLineTime(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The individual records behind one row of a trend view, newest first. */
export default function TrendLineDrill({
  title, start, end, url, queryKey, quantityLabel, valueLabel, formatValue, onClose,
}: {
  title: string;
  start: string;
  end: string;
  /** Returns `{ lines: TrendLine[] }`. */
  url: string;
  queryKey: readonly unknown[];
  /** Omit when the lines carry no count (a per-keg figure). */
  quantityLabel?: string;
  valueLabel: string;
  formatValue: (v: number) => string;
  onClose: () => void;
}) {
  const { data, isPending, error } = useQuery({
    queryKey,
    queryFn: () => fetchJson<{ lines: TrendLine[] }>(url),
    staleTime: SALES_REPORT_STALE_TIME,
  });
  const lines = data?.lines ?? [];
  const total = lines.reduce((s, l) => s + l.value, 0);
  const qty = lines.reduce((s, l) => s + (l.quantity ?? 0), 0);

  return (
    <div className="rounded-lg border border-line bg-canvas mb-6">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-line/60">
        <div>
          <span className="text-sm font-semibold text-strong">{title}</span>
          <span className="text-xs text-muted ml-2">{start} → {end}</span>
        </div>
        <button type="button" onClick={onClose} className="btn-secondary text-xs">Close</button>
      </div>

      {isPending && <div className="px-4 py-3 text-xs text-faint">Loading…</div>}
      {error instanceof Error && <div className="px-4 py-3 text-xs text-danger">{error.message}</div>}
      {data && lines.length === 0 && <div className="px-4 py-3 text-xs text-faint italic">Nothing recorded in this window.</div>}

      {lines.length > 0 && (
        <>
          <div className="overflow-auto max-h-96">
            <table className="w-full text-xs min-w-[480px]">
              <thead className="sticky top-0 bg-canvas">
                <tr className="text-2xs text-faint uppercase tracking-wider border-b border-line/60">
                  <th className="text-left px-4 py-1.5 font-medium">When</th>
                  <th className="text-left px-3 py-1.5 font-medium">What</th>
                  {quantityLabel && <th className="text-right px-3 py-1.5 font-medium">{quantityLabel}</th>}
                  <th className="text-right px-3 py-1.5 font-medium">{valueLabel}</th>
                  <th className="text-left px-3 py-1.5 font-medium">Ref</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={`${l.ref}:${l.occurredAt}:${i}`} className="border-b border-line/30">
                    <td className="px-4 py-1.5 text-muted whitespace-nowrap">{formatLineTime(l.occurredAt)}</td>
                    <td className="px-3 py-1.5 text-body">
                      {l.label}
                      {l.note && <span className="ml-2 text-2xs text-muted italic">{l.note}</span>}
                    </td>
                    {quantityLabel && (
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted">{l.quantity ?? "—"}</td>
                    )}
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-strong">{formatValue(l.value)}</td>
                    <td className="px-3 py-1.5 font-mono text-accent">{l.ref.slice(-8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-4 py-2 border-t border-line-strong text-xs font-semibold text-strong">
            <span>{lines.length} {lines.length === 1 ? "line" : "lines"}{quantityLabel ? ` · ${qty} ${quantityLabel.toLowerCase()}` : ""}</span>
            <span className="font-mono tabular-nums">{formatValue(total)}</span>
          </div>
        </>
      )}
    </div>
  );
}
