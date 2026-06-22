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
                hasSquareCustomer ? (
                  <button
                    onClick={() => setShowModal(true)}
                    className="text-xs px-2.5 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors"
                  >
                    Generate Invoice ({selectedHere.size})
                  </button>
                ) : (
                  <span className="text-xs text-red-400">
                    No linked Square customer — add one in Partners before invoicing
                  </span>
                )
              )}
            </div>
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
    </div>
  );
}
