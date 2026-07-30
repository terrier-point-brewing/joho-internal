"use client";

// Unobtrusive reconciliation entry point for the Financials page (spec §7).
// Renders `data.dataQuality` (Task 6/7's DataQualitySummary) behind a compact
// ⚑ indicator that opens a Modal listing each bucket -- pure presentation,
// no business logic. Row-derivable buckets (unmapped/uncategorized/
// unknownVolume) also offer a "show in table" action that applies the
// `quality` filter (Task 11's controls.ts) to the page's current view.
//
// Count caveat: every bucket's `count` is a count of FinancialsRow groups
// (post-aggregation), not raw transactions -- rows below deliberately lead
// with the dollar total (via <Badge>) and label the count "categories" so
// nothing here implies "N transactions".

import { useState } from "react";
import { formatCurrencyCents } from "@/lib/format";
import type { DataQualitySummary } from "@/lib/finance/financials/types";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";
import { Modal } from "@/app/components/ui/Modal";

/** The subset of quality buckets that map onto controls.ts's qualityBucket() / "quality" filter. */
export type RowQualityBucket = "unmapped" | "uncategorized" | "unknownVolume";

const ROW_BUCKETS: { key: RowQualityBucket; label: string }[] = [
  { key: "unmapped", label: "Unmapped" },
  { key: "uncategorized", label: "Uncategorized" },
  { key: "unknownVolume", label: "Unknown Volume" },
];

function BucketRow({
  label,
  count,
  cents,
  href,
  onShowInTable,
}: {
  label: string;
  count: number;
  cents: number;
  href: string;
  onShowInTable?: () => void;
}) {
  if (count === 0) return null;
  return (
    <Card padding="p-3" className="flex items-center justify-between gap-3">
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-sm font-medium text-primary">{label}</span>
        <Badge tone="danger" className="w-fit">{formatCurrencyCents(cents)}</Badge>
        <span className="text-xs text-muted">{count} {count === 1 ? "category" : "categories"}</span>
      </div>
      <div className="flex flex-col items-end gap-1.5 shrink-0">
        {onShowInTable && (
          <button type="button" onClick={onShowInTable} className="btn-secondary btn-xxs">
            Show in table
          </button>
        )}
        <a href={href} className="btn-secondary btn-xxs">
          Review in Transactions
        </a>
      </div>
    </Card>
  );
}

export default function DataQualityPanel({
  summary,
  onFilterQuality,
}: {
  summary: DataQualitySummary;
  onFilterQuality: (bucket: RowQualityBucket) => void;
}) {
  const [open, setOpen] = useState(false);

  const issueBucketCount =
    (summary.unmapped.count > 0 ? 1 : 0) +
    (summary.uncategorized.count > 0 ? 1 : 0) +
    (summary.unknownVolume.count > 0 ? 1 : 0) +
    (summary.exciseCoverage.shipmentsMissingExcise > 0 ? 1 : 0) +
    (summary.unsourcedAccounts.count > 0 ? 1 : 0);

  if (issueBucketCount === 0) {
    return <span className="text-xs text-faint whitespace-nowrap">⚑ All reconciled</span>;
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-secondary btn-xxs whitespace-nowrap">
        ⚑ {issueBucketCount} to review
      </button>
      {open && (
        <Modal title="Data quality" onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-2">
            {ROW_BUCKETS.map(({ key, label }) => (
              <BucketRow
                key={key}
                label={label}
                count={summary[key].count}
                cents={summary[key].cents}
                href={summary[key].href}
                onShowInTable={() => {
                  onFilterQuality(key);
                  setOpen(false);
                }}
              />
            ))}

            {summary.exciseCoverage.shipmentsMissingExcise > 0 && (
              <Card padding="p-3" className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-sm font-medium text-primary">Excise Coverage</span>
                  <Badge tone="danger" className="w-fit">
                    {summary.exciseCoverage.shipmentsMissingExcise} shipment{summary.exciseCoverage.shipmentsMissingExcise === 1 ? "" : "s"}
                  </Badge>
                  <span className="text-xs text-muted">missing excise detail</span>
                </div>
                <a href={summary.exciseCoverage.href} className="btn-secondary btn-xxs shrink-0">
                  Review in Transactions
                </a>
              </Card>
            )}

            {summary.unsourcedAccounts.count > 0 && (
              <Card padding="p-3" className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-sm font-medium text-primary">Unsourced Accounts</span>
                  <Badge tone="danger" className="w-fit">
                    {summary.unsourcedAccounts.count} account{summary.unsourcedAccounts.count === 1 ? "" : "s"}
                  </Badge>
                  <span className="text-xs text-muted">no configured balance source</span>
                </div>
                <a href={summary.unsourcedAccounts.href} className="btn-secondary btn-xxs shrink-0">
                  Configure sources
                </a>
              </Card>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
