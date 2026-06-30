"use client";
import { useState } from "react";

export interface UnrecognizedSample {
  description: string;
  category: string | null;
  channel: string;
  invoiceDate: string | null;
  amountDollars: number;
  reason: string;
}

export interface UnrecognizedSummary {
  totalDollars: number;
  count: number;
  unmappedAccountCount: number;
  byChannel: Record<string, number>;
  samples: UnrecognizedSample[];
}

export interface ExciseCoverage {
  missingDetailTxns: number;
  byChannel: Record<string, number>;
}

const REASON_LABELS: Record<string, string> = {
  uncategorized:     "Uncategorized",
  no_channel:        "No channel link",
  ambiguous_channel: "Mixed channels",
  no_line_items:     "No line-item detail",
  off_channel:       "Wrong channel category",
};

function fmtUsd(n: number) {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

// Warns when invoice revenue couldn't be placed into any displayed row, and
// when TPB-liable shipments are missing recorded excise (so reported excise
// would be understated). Replaces the silent line-item drops of the old route.
export default function UnrecognizedBanner({
  data,
  excise,
}: {
  data?: UnrecognizedSummary;
  excise?: ExciseCoverage;
}) {
  const [open, setOpen] = useState(false);
  const hasRevenue = !!data && data.count > 0;
  const hasExcise  = !!excise && excise.missingDetailTxns > 0;
  if (!hasRevenue && !hasExcise) return null;

  return (
    <div className="mx-4 sm:mx-6 mb-4 bg-amber-900/20 border border-amber-700/60 rounded p-3 text-sm text-amber-200 space-y-2">
      {excise && excise.missingDetailTxns > 0 && (
        <div>
          Excise may be understated: <span className="font-semibold">{excise.missingDetailTxns}</span>
          {" "}TPB-liable shipment{excise.missingDetailTxns === 1 ? "" : "s"} have volume but no recorded
          {" "}excise detail. Reported excise reflects only what was actually charged.
        </div>
      )}
      {data && data.count > 0 && (
      <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="font-semibold">{fmtUsd(data.totalDollars)}</span> of invoice revenue
          {" "}({data.count} line {data.count === 1 ? "item" : "items"}) couldn&apos;t be matched to a
          {" "}displayed row and is excluded from the totals below.
          {data.unmappedAccountCount > 0 && (
            <span className="text-amber-300/80">
              {" "}· {data.unmappedAccountCount} placed item{data.unmappedAccountCount === 1 ? "" : "s"} still
              {" "}missing a GL account mapping.
            </span>
          )}
        </div>
        {data.samples.length > 0 && (
          <button
            onClick={() => setOpen((o) => !o)}
            className="shrink-0 px-2 py-1 text-xs rounded border border-amber-700/60 hover:bg-amber-800/30 transition-colors"
          >
            {open ? "Hide" : "Details"}
          </button>
        )}
      </div>

      {open && (
        <div className="mt-3 border-t border-amber-700/40 pt-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-amber-300/70 text-left">
                <th className="py-1 pr-3 font-medium">Date</th>
                <th className="py-1 pr-3 font-medium">Description</th>
                <th className="py-1 pr-3 font-medium">Channel</th>
                <th className="py-1 pr-3 font-medium">Reason</th>
                <th className="py-1 pl-3 font-medium text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.samples.map((s, i) => (
                <tr key={i} className="border-t border-amber-700/20">
                  <td className="py-1 pr-3 whitespace-nowrap text-amber-200/80">{s.invoiceDate ?? "—"}</td>
                  <td className="py-1 pr-3 max-w-[280px] truncate">{s.description}</td>
                  <td className="py-1 pr-3 text-amber-200/80">{s.channel}</td>
                  <td className="py-1 pr-3 text-amber-200/80">{REASON_LABELS[s.reason] ?? s.reason}</td>
                  <td className="py-1 pl-3 text-right tabular-nums font-mono">{fmtUsd(s.amountDollars)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.count > data.samples.length && (
            <p className="mt-2 text-amber-300/60 text-xs">
              Showing {data.samples.length} of {data.count}. Map the underlying catalog variations in
              {" "}Settings → Account Mapping to clear these.
            </p>
          )}
        </div>
      )}
      </>
      )}
    </div>
  );
}
