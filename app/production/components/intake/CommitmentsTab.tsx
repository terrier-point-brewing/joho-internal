"use client";

import React, { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  Recipe, ContractBrewingPartner, ContractBrewingRequest,
  ContractRequestStatus, CommitmentStage, CommitmentChannel, CommitmentAllocationSummary,
} from "../../types";
import { fmtDateLong } from "@/lib/utils/formatting";
import { Modal, Field, ModalActions } from "../shared";
import { fetchJson } from "../../hooks/queries";
import { DepositInvoiceModal } from "../DepositInvoiceModal";
import DepositCoverageLine from "../DepositCoverageLine";
import type { DepositCalculation } from "@/lib/square/square-invoices";
import { CATEGORY_BADGE_CLASS as CC } from "../../lib/categoryColors";
import { lockedFieldsChanged } from "@/lib/production/commitmentLock";
import { stageBucket, STAGE_EXPLANATION, type CommitmentBucket } from "@/lib/production/commitmentStage";
import { useTableControls } from "@/app/components/ui/useTableControls";
import FilterChips from "@/app/components/ui/FilterChips";
import FilterSelect from "@/app/components/ui/FilterSelect";
import FilterBar from "@/app/components/ui/FilterBar";
import SortableTh from "@/app/components/ui/SortableTh";
import ToggleChip from "@/app/components/ui/ToggleChip";
import type { ControlsConfig } from "@/lib/table/types";

// The stage is DERIVED from the deal's allocations (lib/production/
// commitmentStage) — where it actually is, not what status was last written.
// The stored status only carries the human decision (open / cancelled).
const BUCKET_META: Record<CommitmentBucket, { label: string; cls: string }> = {
  open:      { label: "Open",      cls: "bg-info-surface/50 text-info border-info-border" },
  closed:    { label: "Closed",    cls: "bg-success-surface/40 text-success border-success-border" },
  cancelled: { label: "Cancelled", cls: "bg-danger-surface/40 text-danger border-danger-border" },
};

/** Legacy rows from before the stage existed — map the stored status straight across. */
function stageOf(q: ContractBrewingRequest): CommitmentStage {
  if (q.stage) return q.stage;
  if (q.status === "cancelled") return "cancelled";
  if (q.status === "fulfilled") return "fulfilled";
  return (q.batch_allocations?.length ?? 0) > 0 ? "planned" : "unplanned";
}

const CHANNEL_META: Record<CommitmentChannel, { label: string; cls: string }> = {
  distribution:     { label: "Distribution",     cls: "bg-info-surface/40 text-info border-info-border" },
  contract_brewing: { label: "Contract Brewing", cls: CC.purple },
  // Amber category token (not `accent`, which the brand skin remaps to indigo)
  // so the pill stays amber and readable in both themes.
  wholesale:        { label: "Wholesale",        cls: CC.amber },
};

const CHANNEL_OPTIONS = [
  { value: "distribution", label: CHANNEL_META.distribution.label },
  { value: "contract_brewing", label: CHANNEL_META.contract_brewing.label, className: CC.purple },
  { value: "wholesale", label: CHANNEL_META.wholesale.label, className: CC.amber },
];

/** Open deals first, then closed, then cancelled; inside a bucket the finer stage keeps its pipeline order. */
const STAGE_SORT_RANK: Record<CommitmentStage, number> = {
  unplanned: 0, planned: 1, brewing: 2, packaged: 3, shipping: 4, delivered: 5, fulfilled: 6, written_off: 7, cancelled: 8,
};

const STAGE_OPTIONS = (["open", "closed", "cancelled"] as CommitmentBucket[]).map((k) => ({ value: k, label: BUCKET_META[k].label }));

const COMMITMENT_CONTROLS: ControlsConfig<SortableRow> = {
  filters: [
    { param: "channel", accessor: (r) => r.channel },
    { param: "stage", accessor: (r) => stageBucket(r.stage_key) },
    { param: "recipe", accessor: (r) => r.recipe_name },
    { param: "partner", accessor: (r) => r.partner_id ?? "" },
  ],
  sort: {
    default: { key: "default_order", dir: "asc" },
    columns: [
      // Composite default: status rank, then channel, then received date.
      { key: "default_order", accessor: (r) => `${STAGE_SORT_RANK[r.stage_key] ?? 9}|${r.channel}|${r.received_on ?? "9999"}` },
      { key: "channel", accessor: (r) => r.channel },
      { key: "status", accessor: (r) => STAGE_SORT_RANK[r.stage_key] ?? 9 },
      { key: "progress", accessor: (r) => r.progress_sort },
      { key: "recipe_name", accessor: (r) => r.recipe_name },
      { key: "partner_name", accessor: (r) => r.partner_name },
      { key: "volume_bbl", accessor: (r) => r.volume_bbl },
      { key: "schedule_sort", accessor: (r) => r.schedule_sort },
      { key: "received_on", accessor: (r) => r.received_on ?? "" },
    ],
  },
};

function StageBadge({ stage }: { stage: CommitmentStage }) {
  const m = BUCKET_META[stageBucket(stage)];
  return <span className={`text-xs px-1.5 py-0.5 rounded border font-medium whitespace-nowrap ${m.cls}`} title={STAGE_EXPLANATION[stage]}>{m.label}</span>;
}

/** Shipped ÷ owed in bbl, with the batches the deal sits on. Owed is the
 *  allocation's share of what the batch has produced, capped at booked. */
function ProgressCell({ q }: { q: ContractBrewingRequest }) {
  const batches = q.batch_numbers ?? [];
  if (batches.length === 0) return <span className="text-faint text-xs">—</span>;
  const owed = q.owed_bbl ?? 0;
  const shipped = q.exported_bbl ?? 0;
  const over = owed > 0 && shipped > owed + 0.01;
  return (
    <div className="text-xs leading-4">
      <div className="tabular-nums">
        <span className={over ? "text-[var(--cat-amber-fg)] font-medium" : "text-body"}>{shipped.toFixed(2)}</span>
        <span className="text-faint"> / </span>
        <span className="text-body">{owed > 0 ? owed.toFixed(2) : "—"}</span>
        <span className="text-faint"> bbl</span>
      </div>
      <div className="text-muted">{batches.map((b) => `#${b}`).join(", ")}</div>
    </div>
  );
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
    return <span className="inline-flex items-center gap-1 text-[10px] text-success bg-success-surface/30 border border-success-border/40 rounded px-1.5 py-0.5">✓ Deposit paid{numSuffix}</span>;
  }
  if (a.deposit_backcharged_invoice_id) {
    // The deposit is being collected as a line on an export invoice instead of
    // its own deposit invoice; it flips to "Deposit paid" when that invoice pays.
    const exportNum = a.backcharge_invoice_number
      ? <span className="ml-1 font-mono opacity-70">#{a.backcharge_invoice_number}</span>
      : null;
    return <span className="inline-flex items-center gap-1 text-[10px] text-accent bg-accent-muted/30 border border-accent-border/40 rounded px-1.5 py-0.5">● On export invoice{exportNum}</span>;
  }
  if (a.invoice_sent_at) {
    return <span className="inline-flex items-center gap-1 text-[10px] text-accent bg-accent-muted/30 border border-accent-border/40 rounded px-1.5 py-0.5">● Invoice sent{numSuffix}</span>;
  }
  if (a.invoice_generated_at) {
    return <span className="inline-flex items-center gap-1 text-[10px] text-secondary bg-surface-mid border border-line-strong rounded px-1.5 py-0.5">Draft ready{numSuffix}</span>;
  }
  return <span className="inline-flex items-center gap-1 text-[10px] text-faint bg-surface border border-line rounded px-1.5 py-0.5">Invoice pending</span>;
}

// ─── Invoicing controls for a commitment's linked contract_brewing allocation(s) ──

function InvoicingCell({
  commitment, onPreview, onViewInSquare, actionLoading, onSend, onDelete,
}: {
  commitment: ContractBrewingRequest;
  onPreview: (a: CommitmentAllocationSummary) => void;
  onViewInSquare: (id: string) => void;
  actionLoading: string | null;
  onSend: (id: string) => void;
  onDelete: (id: string, sent: boolean) => void;
}) {
  if (commitment.channel !== "contract_brewing") return <span className="text-faint text-xs">— (Deposit invoices are only used for Contract Brewing)</span>;
  const allocs = commitment.batch_allocations ?? [];
  if (allocs.length === 0) return <span className="text-faint text-xs">No batch yet</span>;

  return (
    <div className="space-y-1.5">
      {allocs.map((a) => (
        <div key={a.id} className="flex items-center gap-1.5 flex-wrap">
          {a.brew_batches && <span className="text-[10px] text-muted whitespace-nowrap">#{a.brew_batches.batch_number}</span>}
          <InvoiceStatusBadge a={a} />
          <DepositCoverageLine allocation={a} />
          {/* View in Square — available whenever an invoice exists, paid or not */}
          {a.square_deposit_invoice_id && (
            <button type="button" onClick={() => onViewInSquare(a.id)}
              disabled={actionLoading === a.id}
              className="btn-secondary btn-xxs whitespace-nowrap">
              View in Square ↗
            </button>
          )}
          {/* Action buttons only for unpaid allocations. A back-charged deposit
              is being collected on an export invoice, so a NEW deposit invoice
              must not be raised — but a standing one can still be deleted to
              avoid double-billing. */}
          {!a.invoice_paid_at && (
            <>
              {!a.invoice_generated_at && !a.deposit_backcharged_invoice_id && (
                <button type="button"
                  onClick={() => onPreview({ ...a, commitments: { volume_bbl: commitment.volume_bbl } })}
                  disabled={actionLoading === a.id}
                  className="btn-primary btn-xxs whitespace-nowrap">
                  Generate Invoice
                </button>
              )}
              {a.invoice_generated_at && !a.invoice_sent_at && (
                <>
                  {!a.deposit_backcharged_invoice_id && (
                    <button type="button" onClick={() => onSend(a.id)} disabled={actionLoading === a.id}
                      className="btn-primary btn-xxs whitespace-nowrap">
                      {actionLoading === a.id ? "Sending…" : "Send Invoice"}
                    </button>
                  )}
                  <button type="button" onClick={() => onDelete(a.id, false)} disabled={actionLoading === a.id}
                    className="btn-danger btn-xxs whitespace-nowrap">
                    Delete
                  </button>
                </>
              )}
              {a.invoice_sent_at && (
                <>
                  <button type="button" onClick={() => onDelete(a.id, true)} disabled={actionLoading === a.id}
                    className="btn-danger btn-xxs whitespace-nowrap">
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

interface FormState {
  channel: CommitmentChannel;
  recipe_id: string;
  partner_id: string;
  volume_bbl: string;
  desired_delivery_date: string;
  status: ContractRequestStatus;
  notes: string;
  received_on: string;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

const FORM_EMPTY: FormState = {
  channel: "contract_brewing",
  recipe_id: "", partner_id: "", volume_bbl: "",
  desired_delivery_date: "",
  status: "open", notes: "",
  received_on: todayIso(),
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
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<FormState>(existing ? {
    channel: existing.channel,
    recipe_id: existing.recipe_id ?? "",
    partner_id: existing.partner_id ?? "",
    volume_bbl: String(existing.volume_bbl),
    desired_delivery_date: existing.desired_delivery_date ?? "",
    status: existing.status,
    notes: existing.notes ?? "",
    received_on: existing.received_on ?? "",
  } : FORM_EMPTY);
  const set = (k: keyof FormState, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const isDistribution = form.channel === "distribution";

  // A locked deal (deposit paid) can still change beer, partner, channel or
  // volume — with a reason the server keeps on the notes.
  const [unlockReason, setUnlockReason] = useState("");
  const lockedChanges = existing?.locked_on
    ? lockedFieldsChanged(
        { recipe_id: existing.recipe_id, partner_id: existing.partner_id, channel: existing.channel, volume_bbl: existing.volume_bbl },
        { recipe_id: form.recipe_id, partner_id: form.partner_id || null, channel: form.channel, volume_bbl: form.volume_bbl },
      )
    : [];
  const needsUnlockReason = lockedChanges.length > 0 && !unlockReason.trim();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.recipe_id) { alert("Please select a recipe."); return; }
    if (needsUnlockReason) { alert("This commitment is locked — give a reason for the change."); return; }
    setSubmitting(true);
    try {
      const body = {
        channel: form.channel,
        recipe_id: form.recipe_id,
        partner_id: form.partner_id || null,
        volume_bbl: parseFloat(form.volume_bbl),
        desired_delivery_date: form.desired_delivery_date || null,
        status: form.status,
        notes: form.notes || null,
        received_on: form.received_on || null,
        unlock_reason: lockedChanges.length > 0 ? unlockReason.trim() : undefined,
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
          <div className="flex gap-2">
            {(["contract_brewing", "distribution", "wholesale"] as CommitmentChannel[]).map((c) => (
              <ToggleChip key={c} active={form.channel === c} onClick={() => set("channel", c)}>
                {CHANNEL_META[c].label}
              </ToggleChip>
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

        <Field label="Desired Delivery">
          <input type="date" className="inp" value={form.desired_delivery_date}
            onChange={(e) => set("desired_delivery_date", e.target.value)} />
        </Field>

        {lockedChanges.length > 0 && (
          <div className="rounded border border-accent-border bg-accent-muted/30 px-3 py-2 space-y-1.5">
            <p className="text-xs text-accent-soft">
              This commitment locked on {existing?.locked_on ? fmtDateLong(existing.locked_on) : "deposit payment"}. You are changing its{" "}
              {lockedChanges.map((f) => ({ recipe_id: "recipe", partner_id: "partner", channel: "channel", volume_bbl: "volume" })[f]).join(", ")}.
            </p>
            <Field label="Reason" required>
              <input className="inp" value={unlockReason} onChange={(e) => setUnlockReason(e.target.value)}
                placeholder="e.g. partner asked for 2 fewer bbl; deposit difference refunded" />
            </Field>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Notes">
            <input className="inp" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
          <Field label="Received On" hint={!isEdit ? "auto-filled to today" : undefined}>
            <input type="date" className="inp" value={form.received_on}
              onChange={(e) => set("received_on", e.target.value)} />
          </Field>
        </div>

        {/* The stage is derived from the allocations; the only decision that
            lives on the commitment itself is whether it is cancelled. Locking
            happens when the deposit is paid — it is shown, never typed. */}
        {isEdit && (
          <div className="flex items-center justify-between gap-3 rounded border border-line px-3 py-2">
            <p className="text-xs text-muted">
              {existing?.locked_on
                ? <>Locked on {fmtDateLong(existing.locked_on)} when the deposit was paid.</>
                : <>Not locked yet — it locks when the deposit is paid.</>}
            </p>
            {form.status === "cancelled" ? (
              <button type="button" className="btn-secondary btn-xxs" onClick={() => set("status", "open")}>Reopen commitment</button>
            ) : (
              <button type="button" className="btn-danger btn-xxs" onClick={() => set("status", "cancelled")}>Cancel commitment</button>
            )}
          </div>
        )}
        {isEdit && form.status === "cancelled" && (
          <p className="text-xs text-danger">Saving will mark this commitment cancelled.</p>
        )}

        <ModalActions submitting={submitting} onCancel={onClose} label={isEdit ? "Save Changes" : "Create"} />
      </form>
    </Modal>
  );
}

// ─── Sortable row shape ──────────────────────────────────────────────────────

interface SortableRow extends ContractBrewingRequest {
  stage_key: CommitmentStage;
  progress_sort: number;
  partner_name: string;
  schedule_sort: string;
  /** Derived from the joined recipe (commitments.beer_style was dropped). */
  recipe_name: string;
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

  async function handleDelete(q: ContractBrewingRequest) {
    const batches = q.batch_numbers ?? [];
    if (batches.length > 0) {
      alert(`This commitment is allocated on ${batches.map((b) => `#${b}`).join(", ")}. Set its status to Cancelled instead, or remove the allocation from the batch first.`);
      return;
    }
    if (!confirm("Delete this commitment? Nothing is allocated against it.")) return;
    const r = await fetch(`/api/production/contract-requests?id=${q.id}`, { method: "DELETE" });
    if (r.ok) { load(); return; }
    const body = await r.json().catch(() => ({}));
    alert(body.error ?? "Couldn't delete this commitment");
  }

  function scheduleLabel(q: ContractBrewingRequest): string {
    return q.desired_delivery_date ? fmtDateLong(q.desired_delivery_date) : "—";
  }

  const uniqueRecipes = Array.from(new Set(rows.map((r) => r.recipes?.beer_name).filter(Boolean))).sort() as string[];
  const uniquePartners = Array.from(
    new Map(
      rows
        .filter((r) => r.partner_id && r.contract_brewing_partners)
        .map((r) => [r.partner_id!, r.contract_brewing_partners!.company_name])
    ).entries()
  ).sort((a, b) => a[1].localeCompare(b[1]));

  const sortableRows: SortableRow[] = useMemo(
    () => rows.map((q) => ({
      ...q,
      stage_key: stageOf(q),
      progress_sort: (q.owed_bbl ?? 0) > 0 ? (q.exported_bbl ?? 0) / (q.owed_bbl ?? 1) : -1,
      partner_name: q.contract_brewing_partners?.company_name ?? "",
      schedule_sort: q.desired_delivery_date ?? "",
      recipe_name: q.recipes?.beer_name ?? "",
    })),
    [rows],
  );

  const { rows: displayRows, filters, sort, setFilter, toggleSort, reset, activeCount } =
    useTableControls(sortableRows, COMMITMENT_CONTROLS, { prefix: "commit_" });

  return (
    <div>
      <p className="text-sm text-muted mb-3">Distribution allocations and contract brewing requests. All are outflows from cold storage.</p>
      <div className="flex items-start gap-3 mb-4">
        <FilterBar activeCount={activeCount} onClear={reset}>
          <FilterChips label="Channel" options={CHANNEL_OPTIONS}
            value={filters.channel ?? []} onChange={(v) => setFilter("channel", v)} />
          <FilterChips label="Stage" options={STAGE_OPTIONS}
            value={filters.stage ?? []} onChange={(v) => setFilter("stage", v)} />
          <FilterSelect label="Recipe"
            options={uniqueRecipes.map((s) => ({ value: s, label: s }))}
            value={filters.recipe ?? []} onChange={(v) => setFilter("recipe", v)} />
          <FilterSelect label="Partner"
            options={uniquePartners.map(([id, name]) => ({ value: id, label: name }))}
            value={filters.partner ?? []} onChange={(v) => setFilter("partner", v)} />
        </FilterBar>
        <button onClick={() => setShowModal(true)} className="btn-primary ml-auto shrink-0">+ New</button>
      </div>

      {displayRows.length === 0 ? (
        <p className="text-faint text-sm py-10 text-center">No commitments recorded yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface/50 text-left">
                <SortableTh label="Channel" sortKey="channel" sort={sort} onSort={toggleSort} className="text-xs !text-muted !py-2.5 whitespace-nowrap" />
                <SortableTh label="Stage" sortKey="status" sort={sort} onSort={toggleSort} className="text-xs !text-muted !py-2.5" />
                <SortableTh label="Recipe" sortKey="recipe_name" sort={sort} onSort={toggleSort} className="text-xs !text-muted !py-2.5" />
                <SortableTh label="Partner" sortKey="partner_name" sort={sort} onSort={toggleSort} className="text-xs !text-muted !py-2.5" />
                <SortableTh label="Volume (BBL)" sortKey="volume_bbl" sort={sort} onSort={toggleSort} className="text-xs !text-muted !py-2.5 whitespace-nowrap" />
                <SortableTh label="Shipped / Owed" sortKey="progress" sort={sort} onSort={toggleSort} className="text-xs !text-muted !py-2.5 whitespace-nowrap" />
                <SortableTh label="Delivery" sortKey="schedule_sort" sort={sort} onSort={toggleSort} className="text-xs !text-muted !py-2.5" />
                <SortableTh label="Received" sortKey="received_on" sort={sort} onSort={toggleSort} className="text-xs !text-muted !py-2.5" />
                <th className="px-4 py-2.5 text-xs font-medium text-muted whitespace-nowrap">Invoicing</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Notes</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted" />
              </tr>
            </thead>
            <tbody>
              {displayRows.map((q, i) => (
                <tr key={q.id} className={`border-b border-line/60 ${i % 2 !== 0 ? "bg-surface/30" : ""}`}>
                  <td className="px-4 py-2.5 whitespace-nowrap"><ChannelBadge channel={q.channel} /></td>
                  <td className="px-4 py-2.5"><StageBadge stage={stageOf(q)} /></td>
                  <td className="px-4 py-2.5 text-primary font-medium">{q.recipe_name || "—"}</td>
                  <td className="px-4 py-2.5 text-body">{q.contract_brewing_partners?.company_name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-body tabular-nums">{Number(q.volume_bbl)}</td>
                  <td className="px-4 py-2.5"><ProgressCell q={q} /></td>
                  <td className="px-4 py-2.5 text-secondary text-xs whitespace-nowrap">{scheduleLabel(q)}</td>
                  <td className="px-4 py-2.5 text-muted text-xs whitespace-nowrap">
                    {q.received_on ? fmtDateLong(q.received_on) : "—"}
                    {q.locked_on && <span className="ml-1 text-faint" title={`Locked ${fmtDateLong(q.locked_on)} — deposit paid`}>· locked</span>}
                  </td>
                  <td className="px-4 py-2.5 min-w-[180px]">
                    <InvoicingCell
                      commitment={q}
                      onPreview={openInvoicePreview}
                      onViewInSquare={handleViewInSquare}
                      actionLoading={invoiceActionLoading}
                      onSend={handleSendInvoice}
                      onDelete={handleDeleteInvoice}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-muted text-xs">
                    <div className="max-w-[160px] truncate" title={q.notes ?? undefined}>{q.notes ?? "—"}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1 whitespace-nowrap">
                      <button onClick={() => setEditing(q)} className="btn-secondary btn-xxs">Edit</button>
                      <button onClick={() => handleDelete(q)} className="btn-danger btn-xxs">Delete</button>
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
