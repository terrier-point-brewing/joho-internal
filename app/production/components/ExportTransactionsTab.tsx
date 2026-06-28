"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, useContractPartnersQuery } from "../hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import InvoicePreviewModal from "./InvoicePreviewModal";

interface ExportTransactionRow {
  id: string;
  channel: "taproom" | "distribution" | "contract_brewing";
  recipient_id: string | null;
  variant_label: string;
  quantity: number;
  volume_bbl: number;
  total_excise_tax_usd: number;
  status: "invoice_required" | "unpaid" | "paid";
  square_invoice_id: string | null;
  invoice_number: string | null;
  created_at: string;
  brew_batches: { id: string; beer_name: string; batch_number: number } | null;
}

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function ViewInvoiceLink({ invoiceId }: { invoiceId: string }) {
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);
    try {
      const res = await fetch(`/api/production/export/invoice-status?invoiceId=${invoiceId}`);
      const data = await res.json();
      if (!res.ok || !data.publicUrl) {
        setError("Invoice link unavailable");
        return;
      }
      window.open(data.publicUrl, "_blank");
    } catch {
      setError("Failed to fetch invoice");
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <button onClick={handleClick} className="text-xs text-amber-400 hover:text-amber-300 underline">
        View Invoice →
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}

export default function ExportTransactionsTab() {
  const { data: exports = [] } = useQuery({
    queryKey: queryKeys.production.exports(),
    queryFn: () => fetchJson<ExportTransactionRow[]>("/api/production/exports"),
  });
  const { data: partners = [] } = useContractPartnersQuery();
  const qc = useQueryClient();

  const [selected, setSelected] = useState<{ customerId: string; ids: Set<string> } | null>(null);
  const [showModal, setShowModal] = useState(false);

  // ── Mark paid state ────────────────────────────────────────────────────────
  const [showMarkPaid, setShowMarkPaid] = useState(false);
  const [mpSource, setMpSource] = useState<"quickbooks" | "other">("quickbooks");
  const [mpRef, setMpRef] = useState("");
  const [mpPaidAt, setMpPaidAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [mpAmount, setMpAmount] = useState("");
  const [mpLoading, setMpLoading] = useState(false);
  const [mpError, setMpError] = useState<string | null>(null);

  function openMarkPaid() {
    setMpSource("quickbooks"); setMpRef(""); setMpPaidAt(new Date().toISOString().slice(0, 10));
    setMpAmount(""); setMpError(null); setShowMarkPaid(true);
  }

  async function submitMarkPaid() {
    if (!selected) return;
    const cents = Math.round(parseFloat(mpAmount) * 100);
    setMpError(null);
    setMpLoading(true);
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
    } catch (e: unknown) {
      setMpError(e instanceof Error ? e.message : "Failed to mark as paid");
    } finally {
      setMpLoading(false);
    }
  }

  const mpAmountCents = Math.round(parseFloat(mpAmount) * 100);
  const mpValid = !!mpPaidAt && !isNaN(mpAmountCents) && mpAmountCents >= 0 &&
    (mpSource === "other" || mpRef.trim().length > 0);

  const partnerNameById = new Map(partners.map((p) => [p.id, p.company_name]));
  const partnerById = new Map(partners.map((p) => [p.id, p]));

  const relevant = exports.filter((e) => e.channel === "distribution" || e.channel === "contract_brewing");

  const byCustomer = new Map<string, ExportTransactionRow[]>();
  for (const tx of relevant) {
    if (!tx.recipient_id) continue;
    const list = byCustomer.get(tx.recipient_id) ?? [];
    list.push(tx);
    byCustomer.set(tx.recipient_id, list);
  }

  // Group by square_invoice_id for the Send/Sync action bar — multiple
  // transactions can share one invoice (Spec 6's combined-invoice model).
  interface InvoiceGroup { invoiceId: string; invoiceNumber: string | null; txIds: string[]; status: ExportTransactionRow["status"] }
  function invoiceGroupsFor(txs: ExportTransactionRow[]): InvoiceGroup[] {
    const byInvoice = new Map<string, ExportTransactionRow[]>();
    for (const tx of txs) {
      if (!tx.square_invoice_id) continue;
      const list = byInvoice.get(tx.square_invoice_id) ?? [];
      list.push(tx);
      byInvoice.set(tx.square_invoice_id, list);
    }
    return [...byInvoice.entries()]
      .filter(([, group]) => group.some((t) => t.status !== "paid"))
      .map(([invoiceId, group]) => ({
        invoiceId,
        invoiceNumber: group.find((t) => t.invoice_number)?.invoice_number ?? null,
        txIds: group.map((t) => t.id),
        status: group[0].status,
      }));
  }

  const [invoiceActionLoading, setInvoiceActionLoading] = useState<string | null>(null); // invoiceId

  async function handleSendInvoice(group: InvoiceGroup) {
    if (!confirm("Send this invoice to the customer via email?")) return;
    setInvoiceActionLoading(group.invoiceId);
    try {
      const res = await fetch("/api/production/export/invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", transactionIds: group.txIds }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      qc.invalidateQueries({ queryKey: queryKeys.production.exports() });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to send invoice");
    } finally {
      setInvoiceActionLoading(null);
    }
  }

  async function handleSyncInvoice(group: InvoiceGroup) {
    setInvoiceActionLoading(group.invoiceId);
    try {
      const res = await fetch("/api/production/export/invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync", transactionIds: group.txIds }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      qc.invalidateQueries({ queryKey: queryKeys.production.exports() });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to sync invoice");
    } finally {
      setInvoiceActionLoading(null);
    }
  }

  function toggle(customerId: string, txId: string) {
    if (!selected || selected.customerId !== customerId) {
      setSelected({ customerId, ids: new Set([txId]) });
      return;
    }
    const next = new Set(selected.ids);
    if (next.has(txId)) next.delete(txId); else next.add(txId);
    setSelected(next.size > 0 ? { customerId, ids: next } : null);
  }

  function handleInvoiceCreated() {
    setShowModal(false);
    setSelected(null);
    qc.invalidateQueries({ queryKey: queryKeys.production.exports() });
  }

  return (
    <div className="space-y-6">
      {[...byCustomer.entries()].map(([customerId, txs]) => {
        const partner = partnerById.get(customerId);
        const hasSquareCustomer = !!partner?.square_customer_id;
        const selectedHere = selected?.customerId === customerId ? selected.ids : new Set<string>();

        return (
          <div key={customerId} className="rounded-lg border border-zinc-800 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-900/60 border-b border-zinc-800">
              <h3 className="text-sm font-medium text-zinc-200">{partnerNameById.get(customerId) ?? "Unknown customer"}</h3>
              {selectedHere.size > 0 && (
                <div className="flex items-center gap-2">
                  {!hasSquareCustomer && (
                    <span className="text-xs text-zinc-500">No Square customer linked</span>
                  )}
                  <button
                    onClick={() => setShowModal(true)}
                    className="text-xs px-2.5 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors"
                  >
                    Generate Invoice ({selectedHere.size})
                  </button>
                  <button
                    onClick={openMarkPaid}
                    className="text-xs px-2.5 py-1 bg-emerald-700 hover:bg-emerald-600 text-white rounded transition-colors"
                  >
                    Mark Paid ({selectedHere.size})
                  </button>
                </div>
              )}
            </div>
            {invoiceGroupsFor(txs).map((group) => (
              <div key={group.invoiceId} className="flex items-center justify-between px-4 py-1.5 bg-zinc-900/40 border-b border-zinc-800/60 text-xs">
                <span className="text-zinc-500">
                  Invoice #{group.invoiceNumber ?? group.invoiceId.replace(/^inv:/, '')} — {group.status === "invoice_required" ? "Draft, not yet sent" : "Sent, awaiting payment"}
                </span>
                <button
                  onClick={() => group.status === "invoice_required" ? handleSendInvoice(group) : handleSyncInvoice(group)}
                  disabled={invoiceActionLoading === group.invoiceId}
                  className="text-xs px-2 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors disabled:opacity-40"
                >
                  {invoiceActionLoading === group.invoiceId ? "Working…" : group.status === "invoice_required" ? "Send" : "Sync"}
                </button>
              </div>
            ))}
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left">
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500" />
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500">Date</th>
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500">Batch</th>
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500">Packaging</th>
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500 text-right">Qty</th>
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500">Status</th>
                </tr>
              </thead>
              <tbody>
                {txs.map((tx) => (
                  <tr key={tx.id} className="border-b border-zinc-800 last:border-0 hover:bg-zinc-900/30">
                    <td className="px-4 py-2">
                      {tx.status === "invoice_required" ? (
                        <input type="checkbox" checked={selectedHere.has(tx.id)} onChange={() => toggle(customerId, tx.id)} />
                      ) : tx.square_invoice_id ? (
                        <ViewInvoiceLink invoiceId={tx.square_invoice_id} />
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-zinc-400 whitespace-nowrap">{fmt(tx.created_at)}</td>
                    <td className="px-4 py-2 text-zinc-200">
                      {tx.brew_batches ? `#${tx.brew_batches.batch_number} ${tx.brew_batches.beer_name}` : "—"}
                    </td>
                    <td className="px-4 py-2"><span className="px-1.5 py-0.5 rounded text-xs bg-zinc-800 text-zinc-300">{tx.variant_label}</span></td>
                    <td className="px-4 py-2 text-right text-zinc-200">{tx.quantity}</td>
                    <td className="px-4 py-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        tx.status === "paid" ? "bg-emerald-900/40 text-emerald-400"
                        : tx.status === "unpaid" ? "bg-amber-900/40 text-amber-400"
                        : "bg-zinc-800 text-zinc-400"
                      }`}>
                        {tx.status === "invoice_required" ? "Invoice Required" : tx.status === "unpaid" ? "Unpaid" : "Paid"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      {byCustomer.size === 0 && <p className="text-sm text-zinc-600">No distribution or contract brewing exports recorded yet.</p>}

      {showModal && selected && (
        <InvoicePreviewModal
          transactionIds={[...selected.ids]}
          onClose={() => setShowModal(false)}
          onCreated={handleInvoiceCreated}
        />
      )}

      {showMarkPaid && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowMarkPaid(false)}>
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl w-full max-w-sm p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold text-zinc-100">Mark as Paid (External)</h2>
            <p className="text-xs text-zinc-500">Record payment for {selected.ids.size} transaction{selected.ids.size !== 1 ? "s" : ""} collected outside of Square.</p>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs text-zinc-400">Source</label>
                <select value={mpSource} onChange={(e) => setMpSource(e.target.value as "quickbooks" | "other")}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200">
                  <option value="quickbooks">QuickBooks</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-zinc-400">
                  {mpSource === "quickbooks" ? <>QB Invoice # <span className="text-red-400">*</span></> : "Reference # (optional)"}
                </label>
                <input type="text" value={mpRef} onChange={(e) => setMpRef(e.target.value)}
                  placeholder={mpSource === "quickbooks" ? "e.g. INV-1042" : "e.g. check #1234"}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-zinc-400">Date paid <span className="text-red-400">*</span></label>
                  <input type="date" value={mpPaidAt} onChange={(e) => setMpPaidAt(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-zinc-400">Total ($) <span className="text-red-400">*</span></label>
                  <input type="number" min="0.01" step="0.01" value={mpAmount} onChange={(e) => setMpAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600" />
                </div>
              </div>
            </div>

            {mpError && <p className="text-xs text-red-400">{mpError}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setShowMarkPaid(false)} className="text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
              <button onClick={submitMarkPaid} disabled={mpLoading || !mpValid}
                className="text-sm px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded transition-colors disabled:opacity-40">
                {mpLoading ? "Saving…" : "Mark Paid"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
