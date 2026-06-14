"use client";
import { useState, use } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { Invoice, InvoiceLineItem, InvoiceBatchLink } from "@/types/finance";
import type { BrewBatch, ContractBrewingPartner } from "@/app/production/types";
import FinanceNav from "../../FinanceNav";

// ── Types ─────────────────────────────────────────────────────────────────────

interface InvoiceDetail extends Invoice {
  invoice_line_items: InvoiceLineItem[];
  invoice_batch_links: (InvoiceBatchLink & {
    brew_batches: { id: string; beer_name: string; batch_number: string | null; planned_brew_date: string; status: string };
  })[];
  contract_brewing_partners: ContractBrewingPartner | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(s: string | null) {
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  return new Date(Number(y), Number(m) - 1, Number(d))
    .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDollars(cents: number) {
  const neg = cents < 0;
  const s = "$" + Math.abs(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return <span className={neg ? "text-red-400" : undefined}>{neg ? `(${s})` : s}</span>;
}

const STATUS_CLS: Record<string, string> = {
  paid:    "bg-green-900/40 text-green-400",
  open:    "bg-amber-900/40 text-amber-400",
  partial: "bg-blue-900/40 text-blue-400",
  voided:  "bg-zinc-800 text-zinc-500",
  unknown: "bg-zinc-800 text-zinc-500",
};

const CATEGORY_LABEL: Record<string, string> = {
  materials_packaging: "Materials & Packaging",
  packaging_fees:      "Packaging Fees",
  other_services:      "Other Services",
  pass_through_taxes:  "Pass-Through Taxes",
  distribution_keg:    "Distribution — Keg",
  distribution_can:    "Distribution — Can",
  other:               "Other",
};

const CATEGORY_CLS: Record<string, string> = {
  materials_packaging: "bg-blue-900/40 text-blue-300",
  packaging_fees:      "bg-violet-900/40 text-violet-300",
  other_services:      "bg-cyan-900/40 text-cyan-300",
  pass_through_taxes:  "bg-orange-900/40 text-orange-300",
  distribution_keg:    "bg-emerald-900/40 text-emerald-300",
  distribution_can:    "bg-teal-900/40 text-teal-300",
  other:               "bg-zinc-800 text-zinc-400",
};

// ── Batch link panel ──────────────────────────────────────────────────────────

function BatchLinkPanel({ invoiceId, links, onChanged }: {
  invoiceId: string;
  links: InvoiceDetail["invoice_batch_links"];
  onChanged: () => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch]         = useState("");
  const [note, setNote]             = useState("");
  const [busy, setBusy]             = useState(false);
  const [err, setErr]               = useState<string | null>(null);

  const { data: batches } = useQuery({
    queryKey: queryKeys.production.batches(),
    queryFn:  () => fetchJson<BrewBatch[]>("/api/production/batches"),
    staleTime: 60_000,
  });

  const linkedIds = new Set(links.map((l) => l.batch_id));

  const filtered = (batches ?? []).filter((b) => {
    if (linkedIds.has(b.id)) return false;
    const q = search.toLowerCase();
    return (
      b.beer_name.toLowerCase().includes(q) ||
      (b.batch_number ?? "").toLowerCase().includes(q)
    );
  }).slice(0, 20);

  async function linkBatch(batchId: string) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/finance/ledger/invoice-batch-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id: invoiceId, batch_id: batchId, note: note || null }),
      });
      const json = await res.json();
      if (!res.ok) { setErr(json.error ?? "Failed"); return; }
      setSearch(""); setNote(""); setShowPicker(false);
      onChanged();
    } finally { setBusy(false); }
  }

  async function removeLink(linkId: string) {
    setBusy(true); setErr(null);
    try {
      await fetch(`/api/finance/ledger/invoice-batch-links/${linkId}`, { method: "DELETE" });
      onChanged();
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3">
      {links.length === 0 && (
        <p className="text-xs text-zinc-600 italic">No batches linked yet.</p>
      )}
      {links.map((link) => (
        <div key={link.id} className="flex items-center justify-between bg-zinc-800/50 rounded px-3 py-2">
          <div>
            <Link
              href={`/production/brewing/batch-log?batch=${link.brew_batches.id}`}
              className="text-xs font-medium text-amber-400 hover:text-amber-300"
            >
              {link.brew_batches.beer_name}
              {link.brew_batches.batch_number ? ` #${link.brew_batches.batch_number}` : ""}
            </Link>
            <div className="text-[10px] text-zinc-500 mt-0.5">
              Brewed {fmtDate(link.brew_batches.planned_brew_date)}
              {link.note && <> · {link.note}</>}
            </div>
          </div>
          <button
            onClick={() => removeLink(link.id)}
            disabled={busy}
            className="text-zinc-600 hover:text-red-400 transition-colors text-[10px] ml-4"
          >
            Remove
          </button>
        </div>
      ))}

      {err && <p className="text-xs text-red-400">{err}</p>}

      {showPicker ? (
        <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-3 space-y-3">
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search batches by name or number…"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-amber-600"
          />
          <div className="max-h-48 overflow-y-auto space-y-1">
            {filtered.length === 0
              ? <p className="text-xs text-zinc-600 px-1">No matching batches</p>
              : filtered.map((b) => (
                <button
                  key={b.id}
                  onClick={() => linkBatch(b.id)}
                  disabled={busy}
                  className="w-full text-left px-3 py-2 rounded hover:bg-zinc-700 transition-colors"
                >
                  <div className="text-xs font-medium text-zinc-200">
                    {b.beer_name}{b.batch_number ? ` #${b.batch_number}` : ""}
                  </div>
                  <div className="text-[10px] text-zinc-500">
                    {fmtDate(b.planned_brew_date)} · {b.status} · {b.volume_bbl} BBL
                  </div>
                </button>
              ))
            }
          </div>
          <div className="flex items-center gap-2">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional)"
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600"
            />
            <button
              onClick={() => { setShowPicker(false); setSearch(""); setNote(""); }}
              className="px-3 py-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowPicker(true)}
          className="text-xs text-amber-500 hover:text-amber-400 transition-colors"
        >
          + Link a batch
        </button>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();

  const { data: inv, isFetching, error, refetch } = useQuery({
    queryKey: queryKeys.finance.ledgerInvoice(id),
    queryFn:  () => fetchJson<InvoiceDetail>(`/api/finance/ledger/invoices/${id}`),
  });

  // Partner + notes edits
  const [editingPartner, setEditingPartner] = useState(false);
  const [editingNotes,   setEditingNotes]   = useState(false);
  const [noteDraft,      setNoteDraft]      = useState("");
  const [patchErr,       setPatchErr]       = useState<string | null>(null);

  const { data: partners } = useQuery({
    queryKey: queryKeys.partners.contractBrewing(),
    queryFn:  () => fetchJson<ContractBrewingPartner[]>("/api/partners/contract-brewing"),
    staleTime: 60_000,
    enabled: editingPartner,
  });

  const patchMutation = useMutation({
    mutationFn: async (patch: Record<string, string | null>) => {
      const res = await fetch(`/api/finance/ledger/invoices/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error ?? "Failed"); }
      return res.json() as Promise<InvoiceDetail>;
    },
    onSuccess: () => {
      void refetch();
      setEditingPartner(false);
      setEditingNotes(false);
      setPatchErr(null);
    },
    onError: (e) => setPatchErr(e instanceof Error ? e.message : "Failed"),
  });

  if (isFetching && !inv) {
    return (
      <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
        <FinanceNav mobile />
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-4 border-b border-zinc-800">
          <h1 className="text-base font-semibold text-zinc-100">Finance</h1>
          <p className="text-xs text-zinc-500 mt-0.5">Admin only</p>
        </div>
        <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">Loading…</div>
      </div>
    );
  }

  if (error || !inv) {
    return (
      <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
        <FinanceNav mobile />
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-4 border-b border-zinc-800">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h1 className="text-base font-semibold text-zinc-100">Finance</h1>
              <p className="text-xs text-zinc-500 mt-0.5">Admin only</p>
            </div>
          </div>
        </div>
        <div className="mx-4 sm:mx-6 mt-4 bg-red-900/30 border border-red-700 rounded p-3 text-sm text-red-300">
          {error instanceof Error ? error.message : "Invoice not found"}
        </div>
      </div>
    );
  }

  // Category subtotals for the summary sidebar
  const categoryTotals: Record<string, number> = {};
  for (const li of inv.invoice_line_items) {
    const k = li.category ?? "other";
    categoryTotals[k] = (categoryTotals[k] ?? 0) + li.total_cents;
  }

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      {/* Header */}
      <FinanceNav mobile />
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-4 border-b border-zinc-800">
        <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/finance/invoices" className="text-zinc-600 hover:text-zinc-400 transition-colors text-xs">
              ← Invoices
            </Link>
            <h1 className="text-base font-semibold text-zinc-100">
              {inv.invoice_number ?? inv.external_id}
            </h1>
            <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${STATUS_CLS[inv.status] ?? STATUS_CLS.unknown}`}>
              {inv.status}
            </span>
            <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
              inv.source === "square" ? "bg-blue-900/40 text-blue-400" : "bg-violet-900/40 text-violet-400"
            }`}>
              {inv.source === "square" ? "Square" : "QuickBooks"}
            </span>
          </div>
          <div className="text-right shrink-0">
            <div className="text-lg font-bold text-zinc-100 tabular-nums">
              {fmtDollars(inv.total_cents)}
            </div>
            <div className="text-[10px] text-zinc-500">{fmtDate(inv.invoice_date)}</div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-0 md:h-full">

          {/* Left: line items */}
          <div className="overflow-auto px-4 sm:px-6 py-4 sm:py-5 border-b md:border-b-0 md:border-r border-zinc-800">
            {/* Meta row */}
            <div className="flex flex-wrap items-start gap-6 mb-6">
              {/* Customer / Partner */}
              <div>
                <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1">Customer</div>
                <div className="text-sm text-zinc-200">
                  {inv.contract_brewing_partners?.company_name ?? inv.customer_name ?? "—"}
                </div>
                {editingPartner ? (
                  <div className="mt-2 flex items-center gap-2">
                    <select
                      defaultValue={inv.partner_id ?? ""}
                      onChange={(e) => patchMutation.mutate({ partner_id: e.target.value || null })}
                      className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
                    >
                      <option value="">— unlinked —</option>
                      {(partners ?? []).map((p) => (
                        <option key={p.id} value={p.id}>{p.company_name}</option>
                      ))}
                    </select>
                    <button onClick={() => setEditingPartner(false)}
                      className="text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setEditingPartner(true)}
                    className="mt-1 text-[10px] text-amber-600 hover:text-amber-400 transition-colors">
                    {inv.partner_id ? "Change partner" : "Link to partner"}
                  </button>
                )}
              </div>

              {/* Dates */}
              <div>
                <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1">Invoice date</div>
                <div className="text-sm text-zinc-300">{fmtDate(inv.invoice_date)}</div>
              </div>
              {inv.due_date && (
                <div>
                  <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1">Due</div>
                  <div className="text-sm text-zinc-300">{fmtDate(inv.due_date)}</div>
                </div>
              )}

              {/* Notes */}
              <div className="flex-1">
                <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1">Notes</div>
                {editingNotes ? (
                  <div className="flex items-start gap-2">
                    <textarea
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      rows={2}
                      className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 resize-none"
                    />
                    <div className="flex flex-col gap-1">
                      <button onClick={() => patchMutation.mutate({ notes: noteDraft || null })}
                        className="px-2 py-1 bg-amber-600 hover:bg-amber-500 text-white text-[10px] rounded">Save</button>
                      <button onClick={() => { setEditingNotes(false); setNoteDraft(""); }}
                        className="text-[10px] text-zinc-500 hover:text-zinc-300">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <span className="text-xs text-zinc-400">{inv.notes || <span className="text-zinc-600 italic">None</span>}</span>
                    <button onClick={() => { setEditingNotes(true); setNoteDraft(inv.notes ?? ""); }}
                      className="text-[10px] text-amber-600 hover:text-amber-400 shrink-0">Edit</button>
                  </div>
                )}
              </div>
            </div>

            {patchErr && <p className="text-xs text-red-400 mb-3">{patchErr}</p>}

            {/* Line items */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-zinc-800">
                    <th className="px-4 py-2 text-left text-zinc-500 font-medium">Description</th>
                    <th className="px-4 py-2 text-left text-zinc-500 font-medium">Category</th>
                    <th className="px-4 py-2 text-right text-zinc-500 font-medium">Qty</th>
                    <th className="px-4 py-2 text-right text-zinc-500 font-medium">Unit price</th>
                    <th className="px-4 py-2 text-right text-zinc-500 font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.invoice_line_items
                    .sort((a, b) => a.sort_order - b.sort_order)
                    .map((li) => (
                    <tr key={li.id} className="border-t border-zinc-800/40 hover:bg-zinc-800/20">
                      <td className="px-4 py-2 text-zinc-300">{li.description ?? "—"}</td>
                      <td className="px-4 py-2">
                        {li.category ? (
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${CATEGORY_CLS[li.category] ?? CATEGORY_CLS.other}`}>
                            {CATEGORY_LABEL[li.category] ?? li.category}
                          </span>
                        ) : (
                          <span className="text-zinc-600 text-[10px]">Unclassified</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right text-zinc-400 tabular-nums">{li.quantity}</td>
                      <td className="px-4 py-2 text-right font-mono text-zinc-400 tabular-nums">
                        {fmtDollars(li.unit_price_cents)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-zinc-200 tabular-nums">
                        {fmtDollars(li.total_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-zinc-700">
                    <td colSpan={4} className="px-4 py-2 text-right text-zinc-400 font-medium">Total</td>
                    <td className="px-4 py-2 text-right font-mono font-bold text-zinc-100 tabular-nums">
                      {fmtDollars(inv.total_cents)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Right sidebar */}
          <div className="overflow-auto px-4 py-5 space-y-6">

            {/* Category breakdown */}
            <div>
              <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-3">Category breakdown</div>
              <div className="space-y-2">
                {Object.entries(categoryTotals)
                  .sort(([, a], [, b]) => b - a)
                  .map(([cat, cents]) => (
                  <div key={cat} className="flex items-center justify-between">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${CATEGORY_CLS[cat] ?? CATEGORY_CLS.other}`}>
                      {CATEGORY_LABEL[cat] ?? cat}
                    </span>
                    <span className="text-xs font-mono text-zinc-300 tabular-nums">
                      {fmtDollars(cents)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Batch links */}
            <div>
              <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-3">Production batches</div>
              <BatchLinkPanel
                invoiceId={inv.id}
                links={inv.invoice_batch_links}
                onChanged={() => {
                  void refetch();
                  void qc.invalidateQueries({ queryKey: queryKeys.production.batches() });
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
