"use client";

import React, { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  Recipe, ContractBrewingPartner, ContractBrewingRequest,
  ContractRequestStatus, CommitmentChannel, CommitmentAllocationSummary,
  PackagingVariation,
} from "../../types";
import { fmtDateLong } from "@/lib/utils/formatting";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import { Modal, Field, ModalActions } from "../shared";
import { fetchJson, useRecipePackagingVariationsQuery } from "../../hooks/queries";
import { useSort, SortTh } from "@/app/reports/components/SortControls";
import { DepositInvoiceModal } from "../DepositInvoiceModal";
import type { DepositCalculation } from "@/lib/square/square-invoices";

const STATUS_META: Record<ContractRequestStatus, { label: string; cls: string }> = {
  open:        { label: "Open",        cls: "bg-amber-900/50 text-amber-400 border-amber-800" },
  in_progress: { label: "In Progress", cls: "bg-blue-900/50 text-blue-400 border-blue-800" },
  fulfilled:   { label: "Fulfilled",   cls: "bg-green-900/50 text-green-400 border-green-800" },
  cancelled:   { label: "Cancelled",   cls: "bg-red-900/40 text-red-400 border-red-800" },
};

const CHANNEL_META: Record<CommitmentChannel, { label: string; cls: string }> = {
  distribution:     { label: "Distribution",     cls: "bg-blue-900/40 text-blue-300 border-blue-800" },
  contract_brewing: { label: "Contract Brewing", cls: "bg-purple-900/40 text-purple-300 border-purple-800" },
  wholesale:        { label: "Wholesale",        cls: "bg-amber-900/40 text-amber-300 border-amber-800" },
};

function StatusBadge({ status }: { status: ContractRequestStatus }) {
  const m = STATUS_META[status] ?? STATUS_META.open;
  return <span className={`text-xs px-1.5 py-0.5 rounded border font-medium whitespace-nowrap ${m.cls}`}>{m.label}</span>;
}

function ChannelBadge({ channel }: { channel: CommitmentChannel }) {
  const m = CHANNEL_META[channel] ?? CHANNEL_META.contract_brewing;
  return <span className={`text-xs px-1.5 py-0.5 rounded border font-medium whitespace-nowrap inline-block ${m.cls}`}>{m.label}</span>;
}

function InvoiceStatusBadge({ a }: { a: CommitmentAllocationSummary }) {
  const numSuffix = a.deposit_invoice_number
    ? <span className="ml-1 font-mono opacity-70">#{a.deposit_invoice_number}</span>
    : null;
  if (a.invoice_paid_at) {
    return <span className="inline-flex items-center gap-1 text-[10px] text-green-400 bg-green-900/30 border border-green-800/40 rounded px-1.5 py-0.5">✓ Deposit paid{numSuffix}</span>;
  }
  if (a.invoice_sent_at) {
    return <span className="inline-flex items-center gap-1 text-[10px] text-amber-400 bg-amber-900/30 border border-amber-800/40 rounded px-1.5 py-0.5">● Invoice sent{numSuffix}</span>;
  }
  if (a.invoice_generated_at) {
    return <span className="inline-flex items-center gap-1 text-[10px] text-zinc-400 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5">Draft ready{numSuffix}</span>;
  }
  return <span className="inline-flex items-center gap-1 text-[10px] text-zinc-600 bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5">Invoice pending</span>;
}

// ─── Invoicing controls for a commitment's linked contract_brewing allocation(s) ──

function InvoicingCell({
  commitment, onPreview, onViewInSquare, actionLoading, onSend, onSync, onDelete,
}: {
  commitment: ContractBrewingRequest;
  onPreview: (a: CommitmentAllocationSummary) => void;
  onViewInSquare: (id: string) => void;
  actionLoading: string | null;
  onSend: (id: string) => void;
  onSync: (id: string) => void;
  onDelete: (id: string, sent: boolean) => void;
}) {
  if (commitment.channel !== "contract_brewing") return <span className="text-zinc-600 text-xs">— (Deposit invoices are only used for Contract Brewing)</span>;
  const allocs = commitment.batch_allocations ?? [];
  if (allocs.length === 0) return <span className="text-zinc-600 text-xs">No batch yet</span>;

  return (
    <div className="space-y-1.5">
      {allocs.map((a) => (
        <div key={a.id} className="flex items-center gap-1.5 flex-wrap">
          {a.brew_batches && <span className="text-[10px] text-zinc-500 whitespace-nowrap">#{a.brew_batches.batch_number}</span>}
          <InvoiceStatusBadge a={a} />
          {/* View in Square — available whenever an invoice exists, paid or not */}
          {a.square_deposit_invoice_id && (
            <button type="button" onClick={() => onViewInSquare(a.id)}
              disabled={actionLoading === a.id}
              className="text-[10px] text-zinc-500 hover:text-zinc-300 border border-zinc-700 rounded px-1.5 py-0.5 transition-colors disabled:opacity-40 whitespace-nowrap">
              View in Square ↗
            </button>
          )}
          {/* Action buttons only for unpaid allocations */}
          {!a.invoice_paid_at && (
            <>
              {!a.invoice_generated_at && (
                <button type="button"
                  onClick={() => onPreview({ ...a, commitments: { volume_bbl: commitment.volume_bbl } })}
                  disabled={actionLoading === a.id}
                  className="text-[10px] text-amber-500 hover:text-amber-400 border border-amber-800/50 hover:border-amber-600 rounded px-1.5 py-0.5 transition-colors disabled:opacity-40 whitespace-nowrap">
                  Generate Invoice
                </button>
              )}
              {a.invoice_generated_at && !a.invoice_sent_at && (
                <>
                  <button type="button" onClick={() => onSend(a.id)} disabled={actionLoading === a.id}
                    className="text-[10px] text-amber-500 hover:text-amber-400 border border-amber-800/50 hover:border-amber-600 rounded px-1.5 py-0.5 transition-colors disabled:opacity-40 whitespace-nowrap">
                    {actionLoading === a.id ? "Sending…" : "Send Invoice"}
                  </button>
                  <button type="button" onClick={() => onDelete(a.id, false)} disabled={actionLoading === a.id}
                    className="text-[10px] text-red-700 hover:text-red-500 border border-red-900/50 hover:border-red-700 rounded px-1.5 py-0.5 transition-colors disabled:opacity-40 whitespace-nowrap">
                    Delete
                  </button>
                </>
              )}
              {a.invoice_sent_at && (
                <>
                  <button type="button" onClick={() => onSync(a.id)} disabled={actionLoading === a.id}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 border border-zinc-700 rounded px-1.5 py-0.5 transition-colors disabled:opacity-40 whitespace-nowrap">
                    {actionLoading === a.id ? "Syncing…" : "Sync Status"}
                  </button>
                  <button type="button" onClick={() => onDelete(a.id, true)} disabled={actionLoading === a.id}
                    className="text-[10px] text-red-700 hover:text-red-500 border border-red-900/50 hover:border-red-700 rounded px-1.5 py-0.5 transition-colors disabled:opacity-40 whitespace-nowrap">
                    Delete
                  </button>
                </>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Form state ──────────────────────────────────────────────────────────────

interface PackagingRow {
  variation_id: string;
  qty: string;
}

interface FormState {
  channel: CommitmentChannel;
  recipe_id: string;
  partner_id: string;
  volume_bbl: string;
  desired_delivery_date: string;
  cadence: "one_time" | "recurring";
  recurrence: "weekly" | "biweekly" | "monthly";
  start_date: string;
  end_date: string;
  packaging: PackagingRow[];
  status: ContractRequestStatus;
  notes: string;
  received_on: string;
  locked_on: string;
}

const EMPTY_PACKAGING_ROW: PackagingRow = { variation_id: "", qty: "" };

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

const FORM_EMPTY: FormState = {
  channel: "contract_brewing",
  recipe_id: "", partner_id: "", volume_bbl: "",
  desired_delivery_date: "", cadence: "one_time",
  recurrence: "weekly", start_date: "", end_date: "",
  packaging: [{ ...EMPTY_PACKAGING_ROW }],
  status: "open", notes: "",
  received_on: todayIso(), locked_on: "",
};

function CommitmentModal({
  recipes, partners, existing, onClose, onDone,
}: {
  recipes: Recipe[];
  partners: ContractBrewingPartner[];
  existing?: ContractBrewingRequest;
  onClose: () => void;
  onDone: () => void;
}) {
  const isEdit = !!existing;
  const { data: recipePackagingVariations = [] } = useRecipePackagingVariationsQuery();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<FormState>(existing ? {
    channel: existing.channel,
    recipe_id: existing.recipe_id ?? "",
    partner_id: existing.partner_id ?? "",
    volume_bbl: String(existing.volume_bbl),
    desired_delivery_date: existing.desired_delivery_date ?? "",
    cadence: existing.cadence,
    recurrence: existing.recurrence ?? "weekly",
    start_date: existing.start_date ?? "",
    end_date: existing.end_date ?? "",
    packaging: existing.packaging_preferences && existing.packaging_preferences.length > 0
      ? existing.packaging_preferences.map((p) => ({ variation_id: p.variation_id, qty: String(p.qty) }))
      : [{ ...EMPTY_PACKAGING_ROW }],
    status: existing.status,
    notes: existing.notes ?? "",
    received_on: existing.received_on ?? "",
    locked_on: existing.locked_on ?? "",
  } : FORM_EMPTY);
  const set = (k: keyof FormState, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const recipeVariations = recipePackagingVariations
    .filter((rv) => rv.recipe_id === form.recipe_id)
    .map((rv) => rv.packaging_variations)
    .filter((v): v is PackagingVariation => v != null && v.is_active);
  const kegs = recipeVariations.filter((v) => v.container?.type === "keg");
  const cans = recipeVariations.filter((v) => v.container?.type === "can");

  useEffect(() => {
    const validIds = new Set(recipeVariations.map((v) => v.id));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears stale variation picks when the recipe (and its declared-variation set) changes.
    setForm((f) => {
      const next = f.packaging.map((row) =>
        row.variation_id && !validIds.has(row.variation_id) ? { ...row, variation_id: "" } : row
      );
      return next.some((row, i) => row.variation_id !== f.packaging[i].variation_id) ? { ...f, packaging: next } : f;
    });
    // Only re-run when the recipe (and therefore the declared-variation set) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.recipe_id]);

  const isDistribution = form.channel === "distribution";
  const isRecurring = isDistribution && form.cadence === "recurring";

  function setPackagingRow(i: number, patch: Partial<PackagingRow>) {
    setForm((f) => ({ ...f, packaging: f.packaging.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) }));
  }
  function addPackagingRow() {
    setForm((f) => ({ ...f, packaging: [...f.packaging, { ...EMPTY_PACKAGING_ROW }] }));
  }
  function removePackagingRow(i: number) {
    setForm((f) => ({ ...f, packaging: f.packaging.filter((_, idx) => idx !== i) }));
  }

  function rowBbl(row: PackagingRow): number | null {
    const variation = recipeVariations.find((v) => v.id === row.variation_id);
    const qty = parseFloat(row.qty);
    if (!variation?.total_volume_fl_oz || !qty) return null;
    return (qty * variation.total_volume_fl_oz) / BBL_TO_FL_OZ;
  }
  const totalPackagingBbl = form.packaging.reduce((sum, r) => sum + (rowBbl(r) ?? 0), 0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.recipe_id) { alert("Please select a recipe."); return; }
    setSubmitting(true);
    try {
      const packagingPayload = form.packaging
        .filter((r) => r.variation_id && r.qty)
        .map((r) => ({ variation_id: r.variation_id, qty: parseFloat(r.qty) }));
      const body = {
        channel: form.channel,
        recipe_id: form.recipe_id,
        partner_id: form.partner_id || null,
        volume_bbl: parseFloat(form.volume_bbl),
        desired_delivery_date: !isRecurring ? (form.desired_delivery_date || null) : null,
        cadence: isDistribution ? form.cadence : "one_time",
        recurrence: isRecurring ? form.recurrence : null,
        start_date: isRecurring ? (form.start_date || null) : null,
        end_date: isRecurring ? (form.end_date || null) : null,
        packaging: packagingPayload,
        status: form.status,
        notes: form.notes || null,
        received_on: form.received_on || null,
        locked_on: form.locked_on || null,
      };
      const url = isEdit ? `/api/production/contract-requests?id=${existing!.id}` : "/api/production/contract-requests";
      const res = await fetch(url, { method: isEdit ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      onDone(); onClose();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally { setSubmitting(false); }
  }

  return (
    <Modal title={isEdit ? "Edit Commitment" : "New Commitment"} onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Channel selector */}
        <Field label="Channel" required>
          <div className="grid grid-cols-3 gap-2">
            {(["contract_brewing", "distribution", "wholesale"] as CommitmentChannel[]).map((c) => (
              <button key={c} type="button" onClick={() => set("channel", c)}
                className={`px-3 py-2 rounded border text-sm transition-colors ${form.channel === c ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-500"}`}>
                {CHANNEL_META[c].label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Recipe" required>
          <select className="inp" value={form.recipe_id} onChange={(e) => set("recipe_id", e.target.value)} required>
            <option value="">— select a recipe —</option>
            {recipes.map((r) => <option key={r.id} value={r.id}>{r.beer_name}</option>)}
          </select>
        </Field>

        <Field label={isDistribution ? "Distributor (Partner)" : "Requestor (Partner)"}>
          <select className="inp" value={form.partner_id} onChange={(e) => set("partner_id", e.target.value)}>
            <option value="">— none —</option>
            {partners.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
          </select>
        </Field>

        <Field label="Volume (BBL)" required>
          <input type="number" step="0.01" min="0" className="inp" required
            value={form.volume_bbl} onChange={(e) => set("volume_bbl", e.target.value)} />
        </Field>

        {/* Scheduling: cadence for distribution, single date otherwise */}
        {isDistribution ? (
          <>
            <Field label="Cadence" required>
              <div className="grid grid-cols-2 gap-2">
                {(["one_time", "recurring"] as const).map((c) => (
                  <button key={c} type="button" onClick={() => set("cadence", c)}
                    className={`px-3 py-2 rounded border text-sm transition-colors ${form.cadence === c ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-500"}`}>
                    {c === "one_time" ? "One-time" : "Recurring"}
                  </button>
                ))}
              </div>
            </Field>
            {isRecurring ? (
              <div className="grid grid-cols-3 gap-3">
                <Field label="Start Date" required>
                  <input type="date" className="inp" required value={form.start_date}
                    onChange={(e) => set("start_date", e.target.value)} />
                </Field>
                <Field label="Frequency">
                  <select className="inp" value={form.recurrence}
                    onChange={(e) => set("recurrence", e.target.value as typeof form.recurrence)}>
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Biweekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </Field>
                <Field label="End Date">
                  <input type="date" className="inp" value={form.end_date}
                    onChange={(e) => set("end_date", e.target.value)} />
                </Field>
              </div>
            ) : (
              <Field label="Delivery Date" required>
                <input type="date" className="inp" required value={form.desired_delivery_date}
                  onChange={(e) => set("desired_delivery_date", e.target.value)} />
              </Field>
            )}
          </>
        ) : (
          <Field label="Desired Delivery">
            <input type="date" className="inp" value={form.desired_delivery_date}
              onChange={(e) => set("desired_delivery_date", e.target.value)} />
          </Field>
        )}

        {/* Packaging preferences — multiple rows allowed */}
        <div className="rounded border border-zinc-800 px-3 py-3 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-zinc-400">Packaging Preferences</p>
            {totalPackagingBbl > 0 && (
              <p className="text-xs text-zinc-500">Total: <span className="text-zinc-300 tabular-nums">{totalPackagingBbl.toFixed(2)} BBL</span></p>
            )}
          </div>
          <div className="space-y-2">
            {form.packaging.map((row, i) => {
              const bbl = rowBbl(row);
              return (
                <div key={i} className="grid grid-cols-[1fr_120px_80px_24px] gap-2 items-center">
                  <select className="inp" value={row.variation_id} onChange={(e) => setPackagingRow(i, { variation_id: e.target.value })}>
                    <option value="">— not specified —</option>
                    {kegs.length > 0 && (
                      <optgroup label="Kegs">
                        {kegs.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </optgroup>
                    )}
                    {cans.length > 0 && (
                      <optgroup label="Cans">
                        {cans.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </optgroup>
                    )}
                  </select>
                  <input type="number" step="1" min="0" className="inp" placeholder="# of containers"
                    value={row.qty} onChange={(e) => setPackagingRow(i, { qty: e.target.value })} />
                  <span className="text-xs text-zinc-500 tabular-nums text-right">{bbl != null ? `${bbl.toFixed(2)} BBL` : ""}</span>
                  <button type="button" onClick={() => removePackagingRow(i)} disabled={form.packaging.length === 1}
                    className="text-zinc-600 hover:text-red-400 disabled:opacity-30 text-sm leading-none">✕</button>
                </div>
              );
            })}
          </div>
          <button type="button" onClick={addPackagingRow} className="text-xs text-amber-500 hover:text-amber-400 transition-colors">
            + Add another preference
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">
            <select className="inp" value={form.status} onChange={(e) => set("status", e.target.value as ContractRequestStatus)}>
              {(["open", "in_progress", "fulfilled", "cancelled"] as ContractRequestStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_META[s].label}</option>
              ))}
            </select>
          </Field>
          <Field label="Notes">
            <input className="inp" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Received On" hint={!isEdit ? "auto-filled to today" : undefined}>
            <input type="date" className="inp" value={form.received_on}
              onChange={(e) => set("received_on", e.target.value)} />
          </Field>
          <Field label="Locked On">
            <input type="date" className="inp" value={form.locked_on}
              onChange={(e) => set("locked_on", e.target.value)} />
          </Field>
        </div>

        <ModalActions submitting={submitting} onCancel={onClose} label={isEdit ? "Save Changes" : "Create"} />
      </form>
    </Modal>
  );
}

// ─── Sortable row shape ──────────────────────────────────────────────────────

interface SortableRow extends ContractBrewingRequest {
  partner_name: string;
  packaging_total_bbl: number;
  schedule_sort: string;
  /** Derived from the joined recipe (commitments.beer_style was dropped). */
  beer_style: string;
}

function packagingTotalBbl(q: ContractBrewingRequest): number {
  return (q.packaging_preferences ?? []).reduce((sum, p) => {
    const flOz = p.packaging_variations?.total_volume_fl_oz;
    if (!flOz) return sum;
    return sum + (p.qty * flOz) / BBL_TO_FL_OZ;
  }, 0);
}

export default function CommitmentsTab({ recipes, partners }: { recipes: Recipe[]; partners: ContractBrewingPartner[] }) {
  const qc = useQueryClient();
  const { data: rows = [] } = useQuery({
    queryKey: queryKeys.production.commitments(),
    queryFn: () => fetchJson<ContractBrewingRequest[]>("/api/production/contract-requests"),
  });
  const load = () => qc.invalidateQueries({ queryKey: queryKeys.production.commitments() });
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<ContractBrewingRequest | null>(null);
  const [channelFilter, setChannelFilter] = useState<CommitmentChannel | "all">("all");
  const [filterStyle, setFilterStyle] = useState("");
  const [filterPartner, setFilterPartner] = useState("");

  // ── Invoicing actions (shared with Batch Log > Allocations) ──────────────
  const [invoiceModalAlloc, setInvoiceModalAlloc] = useState<CommitmentAllocationSummary | null>(null);
  const [invoicePreview, setInvoicePreview] = useState<{ calculation: DepositCalculation } | null>(null);
  const [invoicePreviewLoading, setInvoicePreviewLoading] = useState(false);
  const [invoiceActionLoading, setInvoiceActionLoading] = useState<string | null>(null);

  async function openInvoicePreview(a: CommitmentAllocationSummary) {
    setInvoiceModalAlloc(a);
    setInvoicePreview(null);
    setInvoicePreviewLoading(true);
    try {
      const data = await fetchJson<{ calculation: DepositCalculation }>(`/api/production/allocations/${a.id}/invoice`);
      setInvoicePreview(data);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to load invoice preview");
      setInvoiceModalAlloc(null);
    } finally {
      setInvoicePreviewLoading(false);
    }
  }

  async function handleGenerateInvoice(allocId: string) {
    setInvoiceActionLoading(allocId);
    try {
      const res = await fetch(`/api/production/allocations/${allocId}/invoice`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "generate" }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setInvoiceModalAlloc(null);
      await load();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to generate invoice");
    } finally {
      setInvoiceActionLoading(null);
    }
  }

  async function handleMarkPaid(allocId: string, data: import("../DepositInvoiceModal").MarkPaidData) {
    setInvoiceActionLoading(allocId);
    try {
      const res = await fetch(`/api/production/allocations/${allocId}/invoice`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "mark_paid", ...data }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setInvoiceModalAlloc(null);
      await load();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to mark as paid");
    } finally {
      setInvoiceActionLoading(null);
    }
  }

  async function handleSendInvoice(allocId: string) {
    if (!confirm("Send this invoice to the partner via email?")) return;
    setInvoiceActionLoading(allocId);
    try {
      const res = await fetch(`/api/production/allocations/${allocId}/invoice`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send" }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await load();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to send invoice");
    } finally {
      setInvoiceActionLoading(null);
    }
  }

  async function handleViewInSquare(allocId: string) {
    setInvoiceActionLoading(allocId);
    try {
      const data = await fetchJson<{ invoiceUrl: string | null }>(`/api/production/allocations/${allocId}/invoice`);
      if (data.invoiceUrl) {
        window.open(data.invoiceUrl, "_blank", "noopener,noreferrer");
      } else {
        alert("No public URL available for this invoice yet.");
      }
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to fetch invoice URL");
    } finally {
      setInvoiceActionLoading(null);
    }
  }

  async function handleSyncInvoice(allocId: string) {
    setInvoiceActionLoading(allocId);
    try {
      const res = await fetch(`/api/production/allocations/${allocId}/invoice`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync" }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await load();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to sync invoice");
    } finally {
      setInvoiceActionLoading(null);
    }
  }

  async function handleDeleteInvoice(allocId: string, sent: boolean) {
    const msg = sent
      ? "Cancel and delete this sent invoice? The partner may receive a cancellation notice. A new invoice can then be generated."
      : "Delete this draft invoice? A new one can be generated.";
    if (!confirm(msg)) return;
    setInvoiceActionLoading(allocId);
    try {
      const res = await fetch(`/api/production/allocations/${allocId}/invoice`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete" }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await load();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to delete invoice");
    } finally {
      setInvoiceActionLoading(null);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this commitment?")) return;
    const r = await fetch(`/api/production/contract-requests?id=${id}`, { method: "DELETE" });
    if (r.ok) load();
  }

  function pkgLabel(q: ContractBrewingRequest): React.ReactNode {
    const prefs = q.packaging_preferences ?? [];
    if (prefs.length === 0) return "—";
    const total = packagingTotalBbl(q);
    return (
      <div className="space-y-0.5">
        {prefs.map((p) => (
          <div key={p.id}>{p.qty} × {p.packaging_variations?.name ?? "—"}</div>
        ))}
        {total > 0 && <div className="text-zinc-600">{total.toFixed(2)} BBL total</div>}
      </div>
    );
  }

  function scheduleLabel(q: ContractBrewingRequest): string {
    if (q.cadence === "recurring") {
      const freq = q.recurrence ?? "—";
      const from = q.start_date ? fmtDateLong(q.start_date) : "—";
      const to = q.end_date ? ` → ${fmtDateLong(q.end_date)}` : "";
      return `${freq.charAt(0).toUpperCase() + freq.slice(1)} from ${from}${to}`;
    }
    return q.desired_delivery_date ? fmtDateLong(q.desired_delivery_date) : "—";
  }

  const uniqueStyles = Array.from(new Set(rows.map((r) => r.recipes?.beer_name).filter(Boolean))).sort() as string[];
  const uniquePartners = Array.from(
    new Map(
      rows
        .filter((r) => r.partner_id && r.contract_brewing_partners)
        .map((r) => [r.partner_id!, r.contract_brewing_partners!.company_name])
    ).entries()
  ).sort((a, b) => a[1].localeCompare(b[1]));

  const filtered = rows.filter((r) => {
    if (channelFilter !== "all" && r.channel !== channelFilter) return false;
    if (filterStyle && r.recipes?.beer_name !== filterStyle) return false;
    if (filterPartner && r.partner_id !== filterPartner) return false;
    return true;
  });

  const sortableRows: SortableRow[] = filtered.map((q) => ({
    ...q,
    partner_name: q.contract_brewing_partners?.company_name ?? "",
    packaging_total_bbl: packagingTotalBbl(q),
    schedule_sort: q.cadence === "recurring" ? (q.start_date ?? "") : (q.desired_delivery_date ?? ""),
    beer_style: q.recipes?.beer_name ?? "",
  }));
  const { sorted, sortKey, sortDir, handleSort } = useSort(sortableRows);
  const displayRows = sorted ?? [];

  return (
    <div>
      <p className="text-sm text-zinc-500 mb-3">Distribution allocations and contract brewing requests. All are outflows from cold storage.</p>
      <div className="flex items-center gap-2 mb-4">
        {(["all", "distribution", "contract_brewing", "wholesale"] as const).map((f) => (
          <button key={f} onClick={() => setChannelFilter(f)}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors border shrink-0 ${channelFilter === f ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 text-zinc-500 hover:text-zinc-300"}`}>
            {f === "all" ? "All" : CHANNEL_META[f].label}
          </button>
        ))}
        <div className="w-px h-4 bg-zinc-700 shrink-0" />
        <select
          className="inp text-sm py-1.5 px-2"
          value={filterStyle}
          onChange={(e) => setFilterStyle(e.target.value)}
        >
          <option value="">All styles</option>
          {uniqueStyles.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          className="inp text-sm py-1.5 px-2"
          value={filterPartner}
          onChange={(e) => setFilterPartner(e.target.value)}
        >
          <option value="">All partners</option>
          {uniquePartners.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        {(filterStyle || filterPartner) && (
          <button
            onClick={() => { setFilterStyle(""); setFilterPartner(""); }}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors shrink-0"
          >
            Clear
          </button>
        )}
        <button onClick={() => setShowModal(true)} className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium rounded transition-colors ml-auto shrink-0">+ New</button>
      </div>

      {displayRows.length === 0 ? (
        <p className="text-zinc-600 text-sm py-10 text-center">No commitments recorded yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                <SortTh label="Channel" col="channel" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-xs !text-zinc-500 !py-2.5 whitespace-nowrap" />
                <SortTh label="Status" col="status" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-xs !text-zinc-500 !py-2.5" />
                <SortTh label="Style" col="beer_style" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-xs !text-zinc-500 !py-2.5" />
                <SortTh label="Partner" col="partner_name" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-xs !text-zinc-500 !py-2.5" />
                <SortTh label="Volume (BBL)" col="volume_bbl" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-xs !text-zinc-500 !py-2.5 whitespace-nowrap" />
                <SortTh label="Packaging" col="packaging_total_bbl" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-xs !text-zinc-500 !py-2.5" />
                <SortTh label="Delivery" col="schedule_sort" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-xs !text-zinc-500 !py-2.5" />
                <SortTh label="Received" col="received_on" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-xs !text-zinc-500 !py-2.5" />
                <SortTh label="Locked" col="locked_on" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-xs !text-zinc-500 !py-2.5" />
                <SortTh label="Edited" col="last_edited_on" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-xs !text-zinc-500 !py-2.5" />
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 whitespace-nowrap">Invoicing</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Notes</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500" />
              </tr>
            </thead>
            <tbody>
              {displayRows.map((q, i) => (
                <tr key={q.id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                  <td className="px-4 py-2.5 whitespace-nowrap"><ChannelBadge channel={q.channel} /></td>
                  <td className="px-4 py-2.5"><StatusBadge status={q.status} /></td>
                  <td className="px-4 py-2.5 text-zinc-100 font-medium">{q.beer_style}</td>
                  <td className="px-4 py-2.5 text-zinc-300">{q.contract_brewing_partners?.company_name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-300 tabular-nums">{Number(q.volume_bbl)}</td>
                  <td className="px-4 py-2.5 text-zinc-400 text-xs">{pkgLabel(q)}</td>
                  <td className="px-4 py-2.5 text-zinc-400 text-xs whitespace-nowrap">{scheduleLabel(q)}</td>
                  <td className="px-4 py-2.5 text-zinc-500 text-xs whitespace-nowrap">{q.received_on ? fmtDateLong(q.received_on) : "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-500 text-xs whitespace-nowrap">{q.locked_on ? fmtDateLong(q.locked_on) : "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-500 text-xs whitespace-nowrap">{q.last_edited_on ? fmtDateLong(q.last_edited_on.slice(0, 10)) : "—"}</td>
                  <td className="px-4 py-2.5 min-w-[180px]">
                    <InvoicingCell
                      commitment={q}
                      onPreview={openInvoicePreview}
                      onViewInSquare={handleViewInSquare}
                      actionLoading={invoiceActionLoading}
                      onSend={handleSendInvoice}
                      onSync={handleSyncInvoice}
                      onDelete={handleDeleteInvoice}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500 text-xs">
                    <div className="max-w-[160px] truncate" title={q.notes ?? undefined}>{q.notes ?? "—"}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3 whitespace-nowrap">
                      <button onClick={() => setEditing(q)} className="text-xs text-zinc-400 hover:text-zinc-200">Edit</button>
                      <button onClick={() => handleDelete(q.id)} className="text-xs text-red-400/80 hover:text-red-400">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && <CommitmentModal recipes={recipes} partners={partners} onClose={() => setShowModal(false)} onDone={load} />}
      {editing && <CommitmentModal recipes={recipes} partners={partners} existing={editing} onClose={() => setEditing(null)} onDone={load} />}

      {invoiceModalAlloc && (
        <DepositInvoiceModal
          allocation={invoiceModalAlloc}
          preview={invoicePreview}
          loading={invoicePreviewLoading}
          generating={invoiceActionLoading === invoiceModalAlloc.id}
          onGenerate={() => handleGenerateInvoice(invoiceModalAlloc.id)}
          onMarkPaid={(data) => handleMarkPaid(invoiceModalAlloc.id, data)}
          markingPaid={invoiceActionLoading === invoiceModalAlloc.id}
          onClose={() => setInvoiceModalAlloc(null)}
        />
      )}
    </div>
  );
}
