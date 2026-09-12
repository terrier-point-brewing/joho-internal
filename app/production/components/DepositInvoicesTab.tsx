"use client";

import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson, useContractPartnersQuery } from "../hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import { fmtUsd } from "@/lib/utils/formatting";
import { FULFILLMENT_TOLERANCE_BBL } from "@/lib/production/commitmentFulfillment";
import Banner from "@/app/components/ui/Banner";
import FilterBar from "@/app/components/ui/FilterBar";
import FilterSelect from "@/app/components/ui/FilterSelect";

interface DepositBreakdownLine {
  id: string; ingredient_name: string; unit: string;
  quantity_per_bbl: number; cost_per_unit_usd: number; line_total_cents: number; sort_order: number;
}
interface DepositInvoiceListItem {
  id: string; invoice_number: string | null; invoice_date: string | null;
  customer_name: string | null; partner_id: string | null; partner_name: string | null;
  status: string; source: string; square_invoice_id: string | null; square_dashboard_url: string | null;
  total_cents: number; percentage: number | null;
  beer_name: string | null; batch_number: string | null; volume_bbl: number | null;
  generated_at: string | null; sent_at: string | null; paid_at: string | null;
  refund_amount_cents: number | null; refunded_at: string | null;
  projected_yield_bbl: number | null; packaged_bbl: number | null; in_tank_bbl: number | null;
  packaging_yield_pct: number; guaranteed_bbl: number | null; fulfilled_bbl: number | null;
  breakdown: DepositBreakdownLine[];
}

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-surface-mid text-secondary",
  open: "bg-accent-muted/40 text-accent",
  paid: "bg-success-surface/40 text-success",
  voided: "bg-danger-surface/40 text-danger",
  partial: "bg-info-surface/40 text-info",
  unknown: "bg-surface-mid text-muted",
};
const STATUS_LABEL: Record<string, string> = {
  draft: "Draft", open: "Sent / Open", paid: "Paid", voided: "Voided", partial: "Partial", unknown: "Unknown",
};

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function ExpandedPanel({ invoice }: { invoice: DepositInvoiceListItem }) {
  const panelClass = "rounded border border-line bg-surface/40 p-3 space-y-2";
  const breakdownTotal = invoice.breakdown.reduce((s, l) => s + l.line_total_cents, 0);
  const refundCents = invoice.refund_amount_cents ?? 0;
  return (
    <div className="px-4 pb-4 space-y-3">
      <div className={panelClass}>
        <p className="text-xs font-medium text-secondary uppercase tracking-wide mb-1">Deposit Details</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <span className="text-muted">Partner</span>
          <span className="text-strong">{invoice.partner_name ?? invoice.customer_name ?? "—"}</span>
          <span className="text-muted">Batch</span>
          <span className="text-body">{invoice.beer_name ? `${invoice.batch_number != null ? `#${invoice.batch_number} ` : ""}${invoice.beer_name}` : "—"}</span>
          <span className="text-muted">Allocation</span>
          <span className="text-body">{invoice.percentage != null ? `${invoice.percentage.toFixed(1)}%` : "—"}{invoice.volume_bbl != null ? ` of ${invoice.volume_bbl.toFixed(1)} bbl brewed` : ""}</span>
          <span className="text-muted">Generated</span>
          <span className="text-body">{invoice.generated_at ? fmt(invoice.generated_at) : "—"}</span>
          <span className="text-muted">Paid</span>
          <span className="text-body">{invoice.paid_at ? fmt(invoice.paid_at) : "—"}</span>
          {refundCents > 0 && (
            <React.Fragment>
              <span className="text-muted">Refunded</span>
              <span className="text-body">
                <span className="text-danger font-medium">−{fmtUsd(refundCents / 100)}</span>
                {invoice.refunded_at ? ` on ${fmt(invoice.refunded_at)}` : ""}
              </span>
              <span className="text-muted">Net Deposit</span>
              <span className="text-strong font-medium">{fmtUsd((invoice.total_cents - refundCents) / 100)}</span>
            </React.Fragment>
          )}
          <span className="text-muted">Status</span>
          <span><span className={`px-1.5 py-0.5 rounded text-xs ${STATUS_BADGE[invoice.status] ?? STATUS_BADGE.unknown}`}>{STATUS_LABEL[invoice.status] ?? invoice.status}</span></span>
          {invoice.square_dashboard_url && (
            <React.Fragment>
              <span className="text-muted">Square</span>
              <a href={invoice.square_dashboard_url} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:text-accent-soft underline">View in Square →</a>
            </React.Fragment>
          )}
        </div>
      </div>

      {invoice.percentage != null && (
        <div className={panelClass}>
          <p className="text-xs font-medium text-secondary uppercase tracking-wide mb-1">Allocation &amp; Fulfillment</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            <span className="text-muted">Allocation</span>
            <span className="text-strong">{invoice.percentage.toFixed(1)}%</span>
            <span className="text-muted">Current Est. Yield</span>
            <span className="text-body">
              {invoice.projected_yield_bbl != null ? (
                <React.Fragment>
                  {invoice.projected_yield_bbl.toFixed(2)} bbl
                  {(invoice.in_tank_bbl ?? 0) > 0.01 && (
                    <span className="text-faint"> ({invoice.packaged_bbl?.toFixed(2)} packaged + {invoice.in_tank_bbl?.toFixed(2)} in tank at {invoice.packaging_yield_pct}%)</span>
                  )}
                </React.Fragment>
              ) : "—"}
            </span>
            <span className="text-muted">Guaranteed by Deposit</span>
            <span className="text-body">{invoice.guaranteed_bbl != null ? `${invoice.guaranteed_bbl.toFixed(2)} bbl` : "—"}</span>
            <span className="text-muted">Fulfilled to Date</span>
            <span className="text-body">
              {invoice.fulfilled_bbl != null ? `${invoice.fulfilled_bbl.toFixed(2)} bbl` : "—"}
              {invoice.fulfilled_bbl != null && invoice.guaranteed_bbl != null && invoice.guaranteed_bbl > 0 && (
                invoice.fulfilled_bbl >= invoice.guaranteed_bbl - FULFILLMENT_TOLERANCE_BBL
                  ? <span className="ml-1.5 px-1.5 py-0.5 rounded text-xs bg-success-surface/40 text-success">Fulfilled</span>
                  : <span className="text-faint"> of {invoice.guaranteed_bbl.toFixed(2)} bbl ({Math.min(100, (invoice.fulfilled_bbl / invoice.guaranteed_bbl) * 100).toFixed(0)}%)</span>
              )}
            </span>
          </div>
          {invoice.guaranteed_bbl != null && invoice.guaranteed_bbl > 0 && invoice.fulfilled_bbl != null && (
            <div className="h-1.5 rounded bg-surface-mid overflow-hidden">
              <div
                className={`h-full rounded ${invoice.fulfilled_bbl >= invoice.guaranteed_bbl - FULFILLMENT_TOLERANCE_BBL ? "bg-success" : "bg-accent"}`}
                style={{ width: `${Math.min(100, (invoice.fulfilled_bbl / invoice.guaranteed_bbl) * 100)}%` }}
              />
            </div>
          )}
          <p className="text-xs text-faint">Shipments credit this allocation in Export → Cold Storage.</p>
        </div>
      )}

      <div className={panelClass}>
        <p className="text-xs font-medium text-secondary uppercase tracking-wide mb-1">Frozen Ingredient Breakdown</p>
        {invoice.breakdown.length === 0 ? (
          <p className="text-xs text-faint">No breakdown recorded for this deposit.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted border-b border-line">
                <th className="pb-1">Ingredient</th>
                <th className="pb-1 text-right">Qty / bbl</th>
                <th className="pb-1 text-right">Unit Cost</th>
                <th className="pb-1 text-right">Deposit Share</th>
              </tr>
            </thead>
            <tbody>
              {invoice.breakdown.map((l) => (
                <tr key={l.id} className="border-b border-line/50 last:border-0">
                  <td className="py-1 text-strong">{l.ingredient_name}</td>
                  <td className="py-1 text-right text-secondary">{l.quantity_per_bbl} {l.unit}</td>
                  <td className="py-1 text-right text-secondary">{fmtUsd(l.cost_per_unit_usd)}</td>
                  <td className="py-1 text-right text-body">{fmtUsd(l.line_total_cents / 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex justify-end pt-1 border-t border-line mt-1">
          <span className="text-xs text-secondary">Total: <span className="text-primary font-medium">{fmtUsd(breakdownTotal / 100)}</span></span>
        </div>
      </div>
    </div>
  );
}

export default function DepositInvoicesTab() {
  // isPending, not isLoading: isLoading is `isPending && isFetching`, so a retry
  // React Query has paused reads as false while there is still no data — the
  // empty branch would claim "no deposit invoices" for a load that never landed.
  const { data: invoices = [], isPending, error } = useQuery({
    queryKey: queryKeys.production.depositInvoices(),
    queryFn: () => fetchJson<DepositInvoiceListItem[]>("/api/production/deposit-invoices"),
  });
  const { data: partners = [] } = useContractPartnersQuery();

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [customerFilter, setCustomerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [yearFilter, setYearFilter] = useState<string>("all");

  const years = useMemo(() => {
    const ys = new Set(invoices.map((inv) => inv.invoice_date?.slice(0, 4)).filter(Boolean) as string[]);
    return [...ys].sort().reverse();
  }, [invoices]);

  const filtered = useMemo(() => invoices.filter((inv) => {
    if (customerFilter !== "all" && inv.partner_id !== customerFilter) return false;
    if (statusFilter !== "all" && inv.status !== statusFilter) return false;
    if (yearFilter !== "all" && inv.invoice_date?.slice(0, 4) !== yearFilter) return false;
    return true;
  }), [invoices, customerFilter, statusFilter, yearFilter]);

  const openTotal = filtered.filter((inv) => inv.status === "open" || inv.status === "draft").reduce((s, inv) => s + inv.total_cents, 0);
  const grandTotal = filtered.reduce((s, inv) => s + inv.total_cents, 0);

  const filterActiveCount = (customerFilter !== "all" ? 1 : 0) + (statusFilter !== "all" ? 1 : 0) + (yearFilter !== "all" ? 1 : 0);

  return (
    <div className="space-y-4">
      <FilterBar
        activeCount={filterActiveCount}
        onClear={() => { setCustomerFilter("all"); setStatusFilter("all"); setYearFilter("all"); }}
      >
        <FilterSelect
          label="Customer"
          options={partners.map((p) => ({ value: p.id, label: p.company_name }))}
          value={customerFilter !== "all" ? [customerFilter] : []}
          onChange={(v) => setCustomerFilter(v[0] ?? "all")}
          allLabel="All Customers"
        />
        <FilterSelect
          label="Status"
          options={[
            { value: "draft", label: "Draft" },
            { value: "open", label: "Sent / Open" },
            { value: "paid", label: "Paid" },
            { value: "voided", label: "Voided" },
          ]}
          value={statusFilter !== "all" ? [statusFilter] : []}
          onChange={(v) => setStatusFilter(v[0] ?? "all")}
          allLabel="All Statuses"
        />
        <FilterSelect
          label="Year"
          options={years.map((y) => ({ value: y, label: y }))}
          value={yearFilter !== "all" ? [yearFilter] : []}
          onChange={(v) => setYearFilter(v[0] ?? "all")}
          allLabel="All Years"
        />
      </FilterBar>

      <div className="flex items-center gap-6 px-4 py-2 bg-surface/60 border border-line rounded text-xs">
        <span className="text-secondary">{filtered.length} invoice{filtered.length !== 1 ? "s" : ""}</span>
        <span className="text-muted">|</span>
        <span className="text-secondary"><span className="text-accent-soft font-medium">{fmtUsd(openTotal / 100)}</span> open</span>
        <span className="text-muted">|</span>
        <span className="text-secondary"><span className="text-strong font-medium">{fmtUsd(grandTotal / 100)}</span> total</span>
      </div>

      {error ? (
        <Banner>Could not load deposit invoices: {error instanceof Error ? error.message : "unknown error"}</Banner>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-faint">
          {isPending ? "Loading deposit invoices…" : "No deposit invoices match the current filters."}
        </p>
      ) : (
        <div className="rounded-lg border border-line overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface/50 text-left">
                <th className="px-4 py-2.5 w-6" aria-label="Expand" />
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Invoice #</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Date</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Customer</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Batch</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Status</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted text-right">Fulfilled</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const isExpanded = expandedId === inv.id;
                return (
                  <React.Fragment key={inv.id}>
                    <tr className="border-b border-line hover:bg-surface/30 cursor-pointer transition-colors" onClick={() => setExpandedId(isExpanded ? null : inv.id)}>
                      <td className="px-4 py-2.5 text-muted text-xs">{isExpanded ? "▾" : "▸"}</td>
                      <td className="px-4 py-2.5 text-strong font-mono">{inv.invoice_number ? `#${inv.invoice_number}` : <span className="text-faint">—</span>}</td>
                      <td className="px-4 py-2.5 text-secondary whitespace-nowrap">{inv.invoice_date ? fmt(inv.invoice_date) : "—"}</td>
                      <td className="px-4 py-2.5 text-body">{inv.partner_name ?? inv.customer_name ?? "—"}</td>
                      <td className="px-4 py-2.5 text-body">{inv.beer_name ?? "—"}</td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_BADGE[inv.status] ?? STATUS_BADGE.unknown}`}>{STATUS_LABEL[inv.status] ?? inv.status}</span>
                        {(inv.refund_amount_cents ?? 0) > 0 && (
                          <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded bg-danger-surface/40 text-danger">Partial Refund</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right text-secondary tabular-nums whitespace-nowrap">
                        {inv.fulfilled_bbl != null && inv.guaranteed_bbl != null && inv.guaranteed_bbl > 0 ? (
                          <span className={inv.fulfilled_bbl >= inv.guaranteed_bbl - FULFILLMENT_TOLERANCE_BBL ? "text-success" : undefined}>
                            {inv.fulfilled_bbl.toFixed(1)} / {inv.guaranteed_bbl.toFixed(1)} bbl
                          </span>
                        ) : <span className="text-faint">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right text-strong font-medium tabular-nums">
                        {fmtUsd(inv.total_cents / 100)}
                        {(inv.refund_amount_cents ?? 0) > 0 && (
                          <span className="block text-xs text-danger font-normal">−{fmtUsd((inv.refund_amount_cents ?? 0) / 100)} refunded</span>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-b border-line bg-surface/20">
                        <td colSpan={8} className="p-0"><ExpandedPanel invoice={inv} /></td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
