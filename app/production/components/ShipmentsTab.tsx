"use client";

import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, useContractPartnersQuery } from "../hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import InvoicePreviewModal from "./InvoicePreviewModal";

interface ShipmentRow {
  id: string;
  channel: "taproom" | "distribution" | "contract_brewing" | "wholesale";
  recipient_id: string | null;
  recipient_name: string | null;
  variant_label: string;
  quantity: number;
  volume_bbl: number;
  total_excise_tax_usd: number;
  status: "invoice_required" | "unpaid" | "paid";
  invoice_id: string | null;
  invoice_number: string | null;
  created_at: string;
  brew_batches: { id: string; beer_name: string; batch_number: number } | null;
}

interface ShipmentsTabProps {
  onNavigateToInvoice?: (invoiceId: string) => void;
}

type ChannelFilter = "all" | "taproom" | "distribution" | "contract_brewing" | "wholesale";
type StatusFilter = "all" | "invoice_required" | "unpaid" | "paid";

const CHANNEL_LABELS: Record<string, string> = {
  taproom: "Taproom",
  distribution: "Distribution",
  contract_brewing: "Contract",
  wholesale: "Wholesale",
};

const CHANNEL_BADGE: Record<string, string> = {
  taproom: "bg-blue-900/40 text-blue-300",
  distribution: "bg-purple-900/40 text-purple-300",
  contract_brewing: "bg-orange-900/40 text-orange-300",
  wholesale: "bg-teal-900/40 text-teal-300",
};

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function ShipmentsTab({ onNavigateToInvoice }: ShipmentsTabProps) {
  const { data: shipments = [] } = useQuery({
    queryKey: queryKeys.production.exports(),
    queryFn: () => fetchJson<ShipmentRow[]>("/api/production/exports"),
  });
  const { data: partners = [] } = useContractPartnersQuery();
  const qc = useQueryClient();

  // ── Filters ────────────────────────────────────────────────────────────────
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [customerFilter, setCustomerFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // ── Selection ──────────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<{ customerId: string; ids: Set<string> } | null>(null);
  const [showModal, setShowModal] = useState(false);

  // ── Mark Paid ──────────────────────────────────────────────────────────────
  const [showMarkPaid, setShowMarkPaid] = useState(false);
  const [mpSource, setMpSource] = useState<"quickbooks" | "other">("quickbooks");
  const [mpRef, setMpRef] = useState("");
  const [mpPaidAt, setMpPaidAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [mpAmount, setMpAmount] = useState("");
  const [mpLoading, setMpLoading] = useState(false);
  const [mpError, setMpError] = useState<string | null>(null);

  const partnerById = useMemo(() => new Map(partners.map((p) => [p.id, p])), [partners]);
  const partnerNameById = useMemo(() => new Map(partners.map((p) => [p.id, p.company_name])), [partners]);

  const filtered = useMemo(() => {
    return shipments.filter((row) => {
      if (channelFilter !== "all" && row.channel !== channelFilter) return false;
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (customerFilter !== "all" && row.recipient_id !== customerFilter) return false;
      if (dateFrom && row.created_at < dateFrom) return false;
      if (dateTo && row.created_at.slice(0, 10) > dateTo) return false;
      return true;
    });
  }, [shipments, channelFilter, statusFilter, customerFilter, dateFrom, dateTo]);

  const lockedCustomerId = selected?.customerId ?? null;

  function toggle(row: ShipmentRow) {
    if (row.channel === "taproom") return;
    if (row.status !== "invoice_required") return;
    const cid = row.recipient_id!;
    if (!selected || selected.customerId !== cid) {
      setSelected({ customerId: cid, ids: new Set([row.id]) });
      return;
    }
    const next = new Set(selected.ids);
    if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
    setSelected(next.size > 0 ? { customerId: cid, ids: next } : null);
  }

  function clearSelection() { setSelected(null); }

  function handleInvoiceCreated() {
    setShowModal(false);
    setSelected(null);
    qc.invalidateQueries({ queryKey: queryKeys.production.exports() });
    qc.invalidateQueries({ queryKey: queryKeys.production.exportInvoices() });
  }

  function openMarkPaid() {
    setMpSource("quickbooks"); setMpRef(""); setMpPaidAt(new Date().toISOString().slice(0, 10));
    setMpAmount(""); setMpError(null); setShowMarkPaid(true);
  }

  async function submitMarkPaid() {
    if (!selected) return;
    const cents = Math.round(parseFloat(mpAmount) * 100);
    setMpError(null); setMpLoading(true);
    try {
      const res = await fetch("/api/production/export/invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "mark_paid",
          transactionIds: [...selected.ids],
          source: mpSource,
          external_ref: mpRef.trim() || undefined,
          paid_at: mpPaidAt,
          total_cents: cents,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowMarkPaid(false);
      setSelected(null);
      qc.invalidateQueries({ queryKey: queryKeys.production.exports() });
      qc.invalidateQueries({ queryKey: queryKeys.production.exportInvoices() });
    } catch (e: unknown) {
      setMpError(e instanceof Error ? e.message : "Failed to mark as paid");
    } finally { setMpLoading(false); }
  }

  const mpAmountCents = Math.round(parseFloat(mpAmount) * 100);
  const mpValid = !!mpPaidAt && !isNaN(mpAmountCents) && mpAmountCents >= 0 &&
    (mpSource === "other" || mpRef.trim().length > 0);

  const selectedCustomerName = selected ? (partnerNameById.get(selected.customerId) ?? "Unknown") : "";
  const hasSquareCustomer = selected ? !!partnerById.get(selected.customerId)?.square_customer_id : false;

  // Unique invoiceable customers for the customer filter dropdown
  const invoiceablePartners = useMemo(() => {
    const seen = new Set<string>();
    return shipments
      .filter((r) => r.recipient_id && !seen.has(r.recipient_id) && seen.add(r.recipient_id))
      .map((r) => ({ id: r.recipient_id!, name: partnerNameById.get(r.recipient_id!) ?? r.recipient_name ?? "Unknown" }));
  }, [shipments, partnerNameById]);

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Channel pills */}
        <div className="flex gap-1">
          {(["all", "taproom", "distribution", "contract_brewing", "wholesale"] as ChannelFilter[]).map((ch) => (
            <button
              key={ch}
              onClick={() => setChannelFilter(ch)}
              className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                channelFilter === ch
                  ? "border-amber-500 bg-amber-900/30 text-amber-300"
                  : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {ch === "all" ? "All" : CHANNEL_LABELS[ch]}
            </button>
          ))}
        </div>

        {/* Status */}
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
        >
          <option value="all">All Statuses</option>
          <option value="invoice_required">Invoice Required</option>
          <option value="unpaid">Unpaid</option>
          <option value="paid">Paid</option>
        </select>

        {/* Customer */}
        <select
          value={customerFilter}
          onChange={(e) => setCustomerFilter(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
        >
          <option value="all">All Customers</option>
          {invoiceablePartners.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        {/* Date range */}
        <label htmlFor="shipments-date-from" className="sr-only">From date</label>
        <input
          id="shipments-date-from"
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
        />
        <span className="text-xs text-zinc-600">–</span>
        <label htmlFor="shipments-date-to" className="sr-only">To date</label>
        <input
          id="shipments-date-to"
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
        />
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <p className="text-sm text-zinc-600">No shipments match the current filters.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                <th className="px-4 py-2.5 w-6" aria-label="Select" />
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Date</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Channel</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Customer</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Batch</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Packaging</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Qty</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Status</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Invoice #</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const isTaproom = row.channel === "taproom";
                const isInvoiceable = !isTaproom && row.status === "invoice_required";
                const isLocked = !!lockedCustomerId && row.recipient_id !== lockedCustomerId;
                const isChecked = !!selected?.ids.has(row.id);
                const canCheck = isInvoiceable && !isLocked;

                return (
                  <tr
                    key={row.id}
                    className={`border-b border-zinc-800 last:border-0 transition-colors ${
                      isLocked ? "opacity-40" : "hover:bg-zinc-900/30"
                    }`}
                  >
                    <td className="px-4 py-2.5">
                      {canCheck && (
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggle(row)}
                          className="accent-amber-500"
                          aria-label={`Select shipment ${row.id}`}
                        />
                      )}
                      {isInvoiceable && isLocked && (
                        <input
                          type="checkbox"
                          disabled
                          className="opacity-30"
                          aria-label="Selection locked to another customer"
                        />
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-400 whitespace-nowrap">{fmt(row.created_at)}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${CHANNEL_BADGE[row.channel] ?? "bg-zinc-800 text-zinc-400"}`}>
                        {CHANNEL_LABELS[row.channel] ?? row.channel}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-300">
                      {isTaproom ? <span className="text-zinc-600">—</span>
                        : (partnerNameById.get(row.recipient_id!) ?? row.recipient_name ?? "Unknown")}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-200">
                      {row.brew_batches ? `#${row.brew_batches.batch_number} ${row.brew_batches.beer_name}` : "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="px-1.5 py-0.5 rounded text-xs bg-zinc-800 text-zinc-300">{row.variant_label}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-zinc-200">{row.quantity}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        row.status === "paid" ? "bg-emerald-900/40 text-emerald-400"
                        : row.status === "unpaid" ? "bg-amber-900/40 text-amber-400"
                        : "bg-zinc-800 text-zinc-400"
                      }`}>
                        {row.status === "invoice_required" ? "Invoice Required"
                          : row.status === "unpaid" ? "Unpaid" : "Paid"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {row.invoice_id && row.invoice_number ? (
                        <button
                          onClick={() => onNavigateToInvoice?.(row.invoice_id!)}
                          className="text-xs text-amber-400 hover:text-amber-300 underline"
                        >
                          #{row.invoice_number}
                        </button>
                      ) : isTaproom ? (
                        <span className="text-zinc-600">—</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Sticky action bar */}
      {selected && selected.ids.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2.5 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl text-sm">
          <span className="text-zinc-400">
            {selected.ids.size} row{selected.ids.size !== 1 ? "s" : ""} selected
            {selectedCustomerName && <> — <span className="text-zinc-200">{selectedCustomerName}</span></>}
          </span>
          {!hasSquareCustomer && (
            <span className="text-xs text-zinc-500">No Square customer linked</span>
          )}
          <button
            onClick={() => setShowModal(true)}
            className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors"
          >
            Generate Invoice
          </button>
          <button
            onClick={openMarkPaid}
            className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded transition-colors"
          >
            Mark Paid
          </button>
          <button onClick={clearSelection} className="px-3 py-1.5 text-zinc-400 hover:text-zinc-200 transition-colors">
            Clear
          </button>
        </div>
      )}

      {/* Invoice Preview Modal */}
      {showModal && selected && (
        <InvoicePreviewModal
          transactionIds={[...selected.ids]}
          onClose={() => setShowModal(false)}
          onCreated={handleInvoiceCreated}
        />
      )}

      {/* Mark Paid Modal */}
      {showMarkPaid && selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowMarkPaid(false)}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl w-full max-w-sm p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-zinc-100">Mark as Paid (External)</h2>
            <p className="text-xs text-zinc-500">
              Record payment for {selected.ids.size} transaction{selected.ids.size !== 1 ? "s" : ""} collected outside of Square.
            </p>
            <div className="space-y-3">
              <div className="space-y-1">
                <label htmlFor="mp-source" className="text-xs text-zinc-400">Source</label>
                <select
                  id="mp-source"
                  value={mpSource}
                  onChange={(e) => setMpSource(e.target.value as "quickbooks" | "other")}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200"
                >
                  <option value="quickbooks">QuickBooks</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor="mp-ref" className="text-xs text-zinc-400">
                  {mpSource === "quickbooks" ? <>QB Invoice # <span className="text-red-400">*</span></> : "Reference # (optional)"}
                </label>
                <input
                  id="mp-ref"
                  type="text"
                  value={mpRef}
                  onChange={(e) => setMpRef(e.target.value)}
                  placeholder={mpSource === "quickbooks" ? "e.g. INV-1042" : "e.g. check #1234"}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="mp-paid-at" className="text-xs text-zinc-400">
                    Date paid <span className="text-red-400">*</span>
                  </label>
                  <input
                    id="mp-paid-at"
                    type="date"
                    value={mpPaidAt}
                    onChange={(e) => setMpPaidAt(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="mp-amount" className="text-xs text-zinc-400">
                    Total ($) <span className="text-red-400">*</span>
                  </label>
                  <input
                    id="mp-amount"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={mpAmount}
                    onChange={(e) => setMpAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600"
                  />
                </div>
              </div>
            </div>
            {mpError && <p className="text-xs text-red-400">{mpError}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setShowMarkPaid(false)}
                className="text-sm text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                onClick={submitMarkPaid}
                disabled={mpLoading || !mpValid}
                className="text-sm px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded transition-colors disabled:opacity-40"
              >
                {mpLoading ? "Saving…" : "Mark Paid"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
