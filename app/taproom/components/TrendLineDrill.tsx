"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { SALES_REPORT_STALE_TIME } from "@/lib/query-keys";
import type { TrendLine } from "@/lib/reports/trendLines";
import { Modal } from "@/app/components/ui/Modal";
import { Table, Th, Td } from "@/app/components/ui/Table";

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

  const num = "font-mono tabular-nums";
  return (
    <Modal title={title} onClose={onClose} wide>
      <p className="text-xs text-muted mb-3">{start} → {end}</p>
      {isPending && <p className="text-xs text-faint">Loading…</p>}
      {error instanceof Error && <p className="text-xs text-danger">{error.message}</p>}
      {data && lines.length === 0 && <p className="text-xs text-faint italic">Nothing recorded in this window.</p>}

      {lines.length > 0 && (
        <>
          <Table bleed={false}>
            <thead>
              <tr className="text-2xs uppercase tracking-wider border-b border-line">
                <Th>When</Th>
                <Th>What</Th>
                {quantityLabel && <Th align="right">{quantityLabel}</Th>}
                <Th align="right">{valueLabel}</Th>
                <Th hide="sm">Ref</Th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={`${l.ref}:${l.occurredAt}:${i}`} className="border-b border-line/30">
                  <Td className="text-muted whitespace-nowrap">{formatLineTime(l.occurredAt)}</Td>
                  <Td className="text-body">
                    {l.label}
                    {l.note && <span className="ml-2 text-2xs text-muted italic">{l.note}</span>}
                  </Td>
                  {quantityLabel && <Td align="right" className={`${num} text-muted`}>{l.quantity ?? "—"}</Td>}
                  <Td align="right" className={`${num} text-strong whitespace-nowrap`}>{formatValue(l.value)}</Td>
                  <Td hide="sm" className="font-mono text-accent">{l.ref.slice(-8)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="flex items-center justify-between pt-3 text-xs font-semibold text-strong">
            <span>{lines.length} {lines.length === 1 ? "line" : "lines"}{quantityLabel ? ` · ${qty} ${quantityLabel.toLowerCase()}` : ""}</span>
            <span className={num}>{formatValue(total)}</span>
          </div>
        </>
      )}
    </Modal>
  );
}
