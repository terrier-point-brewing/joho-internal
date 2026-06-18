"use client";

import React, { useState } from "react";
import { addDays, parseISO } from "date-fns";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { useUserRole } from "@/lib/hooks/useUserRole";
import { BrewBatch, BatchTransfer, BrewActivityEntry, BatchAllocation, AllocationChannel, AllocationLockReason, ContractBrewingRequest } from "../types";
import { BREWHOUSE_BBL, StatusBadge, Modal, Field, ModalActions } from "./shared";
import { fmtDateLong, fmtBbl2 } from "@/lib/utils/formatting";
import { EQ } from "../equipmentMeta";
import { computeLocationBreakdown } from "../lib/volumeLedger";
import { fetchJson } from "../hooks/queries";
import type { DepositCalculation } from "@/lib/square/deposit-invoices";
import {
  useBatchesQuery, useRecipesQuery, useTransfersQuery, useContractPartnersQuery,
  useAssignmentsQuery, useEquipmentQuery, useBatchScheduleQuery, productionKeys,
  useIngredientShortfallsQuery,
  type ScheduleEntry,
} from "../hooks/queries";

const fmtDate = fmtDateLong;

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Compute expected delivery ISO date string from brew date + weeks.
 *  Anchors to T12:00:00 to avoid UTC-midnight off-by-one in UTC-behind timezones. */
function calcDelivery(brewDate: string, weeks: number | null | undefined): string {
  if (!brewDate || !weeks) return "";
  const base = new Date(brewDate.slice(0, 10) + "T12:00:00");
  base.setDate(base.getDate() + Math.round(weeks * 7));
  return base.toISOString().slice(0, 10);
}

type SortCol = "batch_number" | "beer_name" | "planned_brew_date" | "expected_delivery_date" | "volume_bbl" | "status";

const BATCH_EMPTY = {
  recipe_id: "",
  beer_name: "",
  planned_brew_date: new Date().toISOString().slice(0, 10),
  expected_delivery_date: "",
  turns: "1",
  notes: "",
  ibu: "",
  color_srm: "",
  original_gravity: "",
  final_gravity: "",
  dissolved_oxygen_ppb: "",
};

export default function BatchLogTab() {
  const { role } = useUserRole();
  const isAdmin = role === "admin";
  const qc = useQueryClient();
  const { data: batches = [] } = useBatchesQuery();
  const { data: recipes = [] } = useRecipesQuery();
  const { data: transfers = [] } = useTransfersQuery();
  const { data: assignments = [] } = useAssignmentsQuery();
  const { data: tanks = [] } = useEquipmentQuery();
  const { data: scheduleEntries = [] } = useBatchScheduleQuery();
  // Batch CRUD changes the batches list (and allocations nested within it).
  const refresh = () => qc.invalidateQueries({ queryKey: productionKeys.batches });

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(BATCH_EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBatch, setEditingBatch] = useState<BrewBatch | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sort, setSort] = useState<{ col: SortCol; dir: "asc" | "desc" }>({ col: "planned_brew_date", dir: "desc" });

  // Derive computed volume from form state
  const selectedRecipe = recipes.find((r) => r.id === form.recipe_id);
  const computedVolume = (BREWHOUSE_BBL * (parseInt(form.turns) || 1)).toFixed(2);

  function autoDelivery(brewDate: string, r: typeof selectedRecipe): string {
    const leadDays = r ? ((r.days_brewhouse ?? 0) + (r.days_fermenter ?? 0) + (r.days_brite ?? 0)) : 0;
    if (!leadDays || !brewDate) return "";
    const d = new Date(brewDate);
    d.setDate(d.getDate() + leadDays);
    return d.toISOString().slice(0, 10);
  }

  function handleRecipeChange(recipeId: string) {
    const r = recipes.find((r) => r.id === recipeId);
    const delivery = autoDelivery(form.planned_brew_date, r);
    setForm((f) => ({
      ...f,
      recipe_id: recipeId,
      beer_name: r?.beer_name ?? f.beer_name,
      turns: "1",
      expected_delivery_date: delivery || f.expected_delivery_date,
    }));
  }

  function handleBrewDateChange(date: string) {
    const delivery = autoDelivery(date, selectedRecipe);
    setForm((f) => ({
      ...f,
      planned_brew_date: date,
      expected_delivery_date: delivery || f.expected_delivery_date,
    }));
  }

  function openNew() { setForm(BATCH_EMPTY); setEditingId(null); setShowModal(true); }

  function openEdit(b: BrewBatch) {
    setForm({
      recipe_id:              b.recipe_id ?? "",
      beer_name:              b.beer_name,
      planned_brew_date:      b.planned_brew_date,
      expected_delivery_date: b.expected_delivery_date ?? "",
      turns:                  String(b.turns),
      notes:                  b.notes ?? "",
      ibu:                    b.ibu != null ? String(b.ibu) : "",
      color_srm:              b.color_srm != null ? String(b.color_srm) : "",
      original_gravity:       b.original_gravity != null ? String(b.original_gravity) : "",
      final_gravity:          b.final_gravity != null ? String(b.final_gravity) : "",
      dissolved_oxygen_ppb:   b.dissolved_oxygen_ppb != null ? String(b.dissolved_oxygen_ppb) : "",
    });
    setEditingId(b.id);
    setEditingBatch(b);
    setShowModal(true);
  }

  function toggleSort(col: SortCol) {
    setSort((s) => s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: "asc" });
  }

  function sortBatches(list: BrewBatch[]): BrewBatch[] {
    return [...list].sort((a, b) => {
      let av: string | number = "", bv: string | number = "";
      if (sort.col === "batch_number")          { av = a.batch_number ?? ""; bv = b.batch_number ?? ""; }
      else if (sort.col === "beer_name")        { av = a.beer_name; bv = b.beer_name; }
      else if (sort.col === "planned_brew_date"){ av = a.planned_brew_date; bv = b.planned_brew_date; }
      else if (sort.col === "expected_delivery_date") {
        av = a.expected_delivery_date ?? ""; bv = b.expected_delivery_date ?? "";
      }
      else if (sort.col === "volume_bbl")       { av = Number(a.volume_bbl); bv = Number(b.volume_bbl); }
      else if (sort.col === "status")           { av = a.status; bv = b.status; }
      if (av < bv) return sort.dir === "asc" ? -1 : 1;
      if (av > bv) return sort.dir === "asc" ? 1 : -1;
      return 0;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.recipe_id) { alert("Please select a recipe."); return; }
    if (!editingId && !form.expected_delivery_date) { alert("Expected delivery date is required."); return; }
    const turns = parseInt(form.turns) || 1;
    const volume_bbl = BREWHOUSE_BBL * turns;

    setSubmitting(true);
    try {
      const payload = {
        recipe_id:              form.recipe_id,
        beer_name:              form.beer_name,
        planned_brew_date:      form.planned_brew_date,
        expected_delivery_date: form.expected_delivery_date || null,
        volume_bbl,
        turns,
        notes: form.notes || null,
        ibu:               form.ibu !== "" ? parseFloat(form.ibu) : null,
        color_srm:         form.color_srm !== "" ? parseFloat(form.color_srm) : null,
        original_gravity:  form.original_gravity !== "" ? parseFloat(form.original_gravity) : null,
        final_gravity:     form.final_gravity !== "" ? parseFloat(form.final_gravity) : null,
        dissolved_oxygen_ppb: form.dissolved_oxygen_ppb !== "" ? parseFloat(form.dissolved_oxygen_ppb) : null,
      };
      const res = editingId
        ? await fetch(`/api/production/batches/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch("/api/production/batches",              { method: "POST",  headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowModal(false);
      setEditingBatch(null);
      await refresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error saving batch");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleArchive(id: string, name: string) {
    if (!confirm(`Archive batch "${name}"? Equipment will be released and scheduled work cancelled. Financial records will be preserved.`)) return;
    await fetch(`/api/production/batches/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    await refresh();
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Permanently delete batch "${name}" and ALL related records? This cannot be undone.`)) return;
    const res = await fetch(`/api/production/batches/${id}`, { method: "DELETE" });
    if (!res.ok) { alert("Delete failed — you may not have permission."); return; }
    await refresh();
  }

  const allBatches = sortBatches(batches);
  const tankTypeById = Object.fromEntries(tanks.map((t) => [t.id, t.type]));
  const assignedBatchIds = new Set(assignments.map((a) => a.batch_id));

  return (
    <>
      <div className="flex justify-end mb-4">
        <button onClick={openNew} className="btn-amber">+ New Batch</button>
      </div>

      {recipes.length === 0 && (
        <div className="mb-4 p-3 bg-amber-900/20 border border-amber-800 rounded text-amber-300 text-sm">
          Create at least one recipe in the Recipes tab before logging a batch.
        </div>
      )}

      {allBatches.length === 0 ? (
        <p className="text-zinc-600 text-sm">No batches yet.</p>
      ) : (
        <BatchTable
          batches={allBatches}
          transfers={transfers}
          scheduleEntries={scheduleEntries}
          equipment={tanks}
          expandedId={expandedId}
          sort={sort}
          onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
          onEdit={openEdit}
          onArchive={handleArchive}
          onDelete={handleDelete}
          isAdmin={isAdmin}
          onSort={toggleSort}
          tankTypeById={tankTypeById}
          assignedBatchIds={assignedBatchIds}
          recipes={recipes}
        />
      )}

      {showModal && (
        <Modal title={editingId ? "Edit Batch" : "New Batch"} onClose={() => { setShowModal(false); setEditingBatch(null); }} wide={!!editingId}>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field label="Recipe" required>
              <select className="inp" value={form.recipe_id} onChange={(e) => handleRecipeChange(e.target.value)} required>
                <option value="">— select a recipe —</option>
                {recipes.map((r) => (
                  <option key={r.id} value={r.id}>{r.beer_name}{r.brewery ? ` · ${r.brewery}` : ""}</option>
                ))}
              </select>
            </Field>
            <Field label="Beer Name" required>
              <input className="inp" value={form.beer_name} required
                onChange={(e) => setForm((f) => ({ ...f, beer_name: e.target.value }))} />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Planned Brew Date" required>
                <input type="date" className="inp" value={form.planned_brew_date} required
                  onChange={(e) => handleBrewDateChange(e.target.value)} />
              </Field>
              <Field label="Expected Delivery Date" required={!editingId}>
                <input type="date" className="inp" value={form.expected_delivery_date}
                  required={!editingId}
                  onChange={(e) => setForm((f) => ({ ...f, expected_delivery_date: e.target.value }))} />
                {!editingId && selectedRecipe && (() => {
                  const leadDays = (selectedRecipe.days_brewhouse ?? 0) + (selectedRecipe.days_fermenter ?? 0) + (selectedRecipe.days_brite ?? 0);
                  return leadDays > 0
                    ? <p className="text-xs text-zinc-600 mt-1">Auto-set from recipe lead time: {leadDays} days</p>
                    : null;
                })()}
              </Field>
            </div>
            <Field label={`Turns (${BREWHOUSE_BBL} BBL brewhouse)`} required>
              <input type="number" min="1" step="1" className="inp" value={form.turns} required
                onChange={(e) => setForm((f) => ({ ...f, turns: e.target.value }))} />
              <p className="text-xs text-zinc-500 mt-1">
                Brew volume: <span className="text-zinc-300 font-medium">{computedVolume} BBL</span>
                {selectedRecipe?.expected_yield_bbl && (
                  <span className="text-zinc-600 ml-1">· expected yield {(selectedRecipe.expected_yield_bbl * (parseInt(form.turns) || 1)).toFixed(2)} BBL after shrinkage</span>
                )}
              </p>
            </Field>
            <Field label="Notes">
              <textarea className="inp resize-none" rows={2} value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            </Field>

            {/* Brew Stats — edit only */}
            {editingBatch && (
              <div>
                <p className="text-xs text-zinc-400 mb-2">Brew Stats</p>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  <Field label="IBU">
                    <input type="number" step="0.1" min="0" className="inp" placeholder="e.g. 45"
                      value={form.ibu} onChange={(e) => setForm((f) => ({ ...f, ibu: e.target.value }))} />
                  </Field>
                  <Field label="Color (SRM)">
                    <input type="number" step="0.1" min="0" className="inp" placeholder="e.g. 8"
                      value={form.color_srm} onChange={(e) => setForm((f) => ({ ...f, color_srm: e.target.value }))} />
                  </Field>
                  <Field label="OG">
                    <input type="number" step="0.001" min="0" className="inp" placeholder="e.g. 1.065"
                      value={form.original_gravity} onChange={(e) => setForm((f) => ({ ...f, original_gravity: e.target.value }))} />
                  </Field>
                  <Field label="FG">
                    <input type="number" step="0.001" min="0" className="inp" placeholder="e.g. 1.012"
                      value={form.final_gravity} onChange={(e) => setForm((f) => ({ ...f, final_gravity: e.target.value }))} />
                  </Field>
                  <Field label="DO (ppb)">
                    <input type="number" step="0.1" min="0" className="inp" placeholder="e.g. 50"
                      value={form.dissolved_oxygen_ppb} onChange={(e) => setForm((f) => ({ ...f, dissolved_oxygen_ppb: e.target.value }))} />
                  </Field>
                </div>
              </div>
            )}

            {editingBatch && (
              <>
                <div className="pt-4 border-t border-zinc-800">
                  <AllocationManager batch={editingBatch} />
                </div>
                <div className="pt-4 border-t border-zinc-800">
                  <EquipmentScheduleSection
                    batchId={editingBatch.id}
                    entries={scheduleEntries.filter((e) => e.batch_id === editingBatch.id)}
                    equipment={tanks}
                    batch={editingBatch}
                    recipes={recipes}
                  />
                </div>
                <div className="pt-4 border-t border-zinc-800">
                  <BrewActivityLogManager batch={editingBatch} />
                </div>
              </>
            )}

            <ModalActions submitting={submitting} onCancel={() => { setShowModal(false); setEditingBatch(null); }}
              label={editingId ? "Save Changes" : "Create Batch"} />
          </form>
        </Modal>
      )}
    </>
  );
}

// ─── Allocation manager (batch_allocations) ──────────────────────────────────

const CHANNEL_OPTIONS: { value: AllocationChannel; label: string }[] = [
  { value: "taproom",          label: "Taproom" },
  { value: "distribution",     label: "Distribution" },
  { value: "contract_brewing", label: "Contract Brewing" },
  { value: "safety_stock",     label: "Safety Stock" },
];

const LOCK_REASON_OPTIONS: { value: AllocationLockReason; label: string }[] = [
  { value: "deposit_paid",    label: "Deposit Paid" },
  { value: "contract_signed", label: "Contract Signed" },
];

// Color per channel for badges + stacked bar
const CHANNEL_COLOR: Record<AllocationChannel, { bg: string; text: string; bar: string }> = {
  taproom:          { bg: "bg-blue-900/50",    text: "text-blue-300",   bar: "#3b82f6" },
  distribution:     { bg: "bg-emerald-900/50", text: "text-emerald-300",bar: "#10b981" },
  contract_brewing: { bg: "bg-purple-900/50",  text: "text-purple-300", bar: "#8b5cf6" },
  safety_stock:     { bg: "bg-zinc-800",        text: "text-zinc-400",  bar: "#52525b" },
};

function ChannelBadge({ channel }: { channel: AllocationChannel }) {
  const c = CHANNEL_COLOR[channel] ?? { bg: "bg-zinc-800", text: "text-zinc-400" };
  const label = CHANNEL_OPTIONS.find(o => o.value === channel)?.label ?? channel;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border border-white/5 ${c.bg} ${c.text}`}>
      {label}
    </span>
  );
}

function InvoiceStatusBadge({ allocation }: { allocation: BatchAllocation }) {
  if (allocation.channel !== "contract_brewing") return null;

  if (allocation.invoice_paid_at) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-green-400 bg-green-900/30 border border-green-800/40 rounded px-1.5 py-0.5">
        ✓ Deposit paid
      </span>
    );
  }
  if (allocation.invoice_sent_at) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-amber-400 bg-amber-900/30 border border-amber-800/40 rounded px-1.5 py-0.5">
        ● Invoice sent
      </span>
    );
  }
  if (allocation.invoice_generated_at) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-zinc-400 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5">
        Draft invoice ready
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-zinc-600 bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5">
      Invoice pending
    </span>
  );
}

function AllocationManager({ batch }: { batch: BrewBatch }) {
  const qc = useQueryClient();

  const allocKey = queryKeys.production.allocationsByBatch(batch.id);
  const { data: allocations = [] } = useQuery({
    queryKey: allocKey,
    queryFn: () => fetchJson<BatchAllocation[]>(`/api/production/allocations?batch_id=${batch.id}`),
  });

  const { data: allCommitments = [] } = useQuery({
    queryKey: queryKeys.production.commitments(),
    queryFn: () => fetchJson<ContractBrewingRequest[]>("/api/production/contract-requests"),
  });
  const recipeCommitments = allCommitments.filter(
    (c) => c.recipe_id === batch.recipe_id && (c.status === "open" || c.status === "in_progress")
  );

  const refresh = () => qc.invalidateQueries({ queryKey: allocKey });
  const batchVol = Number(batch.volume_bbl);
  const totalPct = allocations.reduce((s, a) => s + Number(a.percentage), 0);
  const remaining = 100 - totalPct;
  const overAllocated = totalPct > 100;

  // ── Deposit invoice state ──────────────────────────────────────────────────
  const [invoiceModalAlloc, setInvoiceModalAlloc] = useState<BatchAllocation | null>(null);
  const [invoicePreview, setInvoicePreview] = useState<{ calculation: DepositCalculation } | null>(null);
  const [invoicePreviewLoading, setInvoicePreviewLoading] = useState(false);
  const [invoiceActionLoading, setInvoiceActionLoading] = useState<string | null>(null); // alloc ID

  async function openInvoiceModal(a: BatchAllocation) {
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate" }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setInvoiceModalAlloc(null);
      await refresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to generate invoice");
    } finally {
      setInvoiceActionLoading(null);
    }
  }

  async function handleSendInvoice(allocId: string) {
    if (!confirm("Send this invoice to the partner via email?")) return;
    setInvoiceActionLoading(allocId);
    try {
      const res = await fetch(`/api/production/allocations/${allocId}/invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send" }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await refresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to send invoice");
    } finally {
      setInvoiceActionLoading(null);
    }
  }

  async function handleSyncInvoice(allocId: string) {
    setInvoiceActionLoading(allocId);
    try {
      const res = await fetch(`/api/production/allocations/${allocId}/invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error");
      await refresh();
      if (data.squareStatus === "PAID") {
        // Allocation auto-locked by server
      }
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to sync invoice");
    } finally {
      setInvoiceActionLoading(null);
    }
  }

  // ── Inline % editing ──────────────────────────────────────────────────────
  const [editingPct, setEditingPct] = useState<Record<string, string>>({});

  async function savePct(a: BatchAllocation) {
    const raw = editingPct[a.id];
    if (raw === undefined) return;
    const pct = parseFloat(raw);
    if (isNaN(pct) || pct === Number(a.percentage)) {
      setEditingPct(p => { const n = { ...p }; delete n[a.id]; return n; });
      return;
    }
    const res = await fetch(`/api/production/allocations/${a.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ percentage: pct }),
    });
    if (!res.ok) { alert((await res.json()).error ?? "Error"); return; }
    setEditingPct(p => { const n = { ...p }; delete n[a.id]; return n; });
    await refresh();
  }

  async function handleDelete(id: string, locked: boolean) {
    if (locked) { alert("Cannot delete a locked allocation."); return; }
    if (!confirm("Remove this allocation?")) return;
    const res = await fetch(`/api/production/allocations/${id}`, { method: "DELETE" });
    if (!res.ok) alert((await res.json()).error ?? "Error");
    await refresh();
  }

  async function handleLock(id: string, reason: AllocationLockReason) {
    const res = await fetch(`/api/production/allocations/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locked: true, lock_reason: reason }),
    });
    if (!res.ok) alert((await res.json()).error ?? "Error");
    await refresh();
  }

  async function handleUnlock(id: string) {
    if (!confirm("Unlock this allocation?")) return;
    const res = await fetch(`/api/production/allocations/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locked: false }),
    });
    if (!res.ok) alert((await res.json()).error ?? "Error");
    await refresh();
  }

  // ── Add new allocation ──────────────────────────────────────────────────────
  const [showAddForm, setShowAddForm] = useState(false);
  const [newChannel, setNewChannel] = useState<AllocationChannel>("taproom");
  const [newCommitmentId, setNewCommitmentId] = useState("");
  const [newPct, setNewPct] = useState("");
  const [saving, setSaving] = useState(false);

  const isTaproomChannel = (ch: AllocationChannel) => ch === "taproom" || ch === "safety_stock";

  const newChannelCommitments = recipeCommitments.filter(c =>
    c.channel === (newChannel === "distribution" ? "distribution" : "contract_brewing")
  );
  const selectedNewCommitment = recipeCommitments.find(c => c.id === newCommitmentId) ?? null;

  function handleNewChannelChange(ch: AllocationChannel) {
    setNewChannel(ch);
    setNewCommitmentId("");
    setNewPct("");
  }
  function handleNewCommitmentChange(cid: string) {
    setNewCommitmentId(cid);
    const c = recipeCommitments.find(x => x.id === cid);
    if (c && batchVol > 0) {
      const pct = Math.round((Number(c.volume_bbl) / batchVol) * 1000) / 10;
      setNewPct(String(pct));
    }
  }

  async function handleAdd() {
    if (!newPct) return;
    setSaving(true);
    try {
      const res = await fetch("/api/production/allocations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batch_id: batch.id,
          channel: newChannel,
          percentage: parseFloat(newPct),
          partner_id: selectedNewCommitment?.partner_id ?? null,
          contract_request_id: newCommitmentId || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setNewPct(""); setNewCommitmentId(""); setNewChannel("taproom"); setShowAddForm(false);
      await refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Allocation Plan</p>
        <button type="button" onClick={() => setShowAddForm(v => !v)}
          className="text-xs text-amber-500 hover:text-amber-400 transition-colors">
          {showAddForm ? "Cancel" : "+ Add allocation"}
        </button>
      </div>

      {/* Stacked allocation bar */}
      {allocations.length > 0 && (
        <div className="space-y-1.5">
          <div className="w-full h-3 rounded-full bg-zinc-800 overflow-hidden flex">
            {allocations.map(a => {
              const pct = Math.min(Number(a.percentage), 100);
              const color = (CHANNEL_COLOR[a.channel as AllocationChannel] ?? CHANNEL_COLOR.safety_stock).bar;
              return (
                <div key={a.id} style={{ width: `${pct}%`, background: color }} title={`${CHANNEL_OPTIONS.find(o => o.value === a.channel)?.label ?? a.channel}: ${pct}%`} />
              );
            })}
            {/* Unallocated remainder */}
            {remaining > 0.1 && (
              <div style={{ width: `${Math.min(remaining, 100)}%` }} className="bg-zinc-700/40" />
            )}
          </div>
          <div className="flex items-center justify-between">
            <div className="flex flex-wrap gap-2">
              {allocations.map(a => (
                <span key={a.id} className="text-[10px] text-zinc-500 flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-sm flex-none" style={{ background: (CHANNEL_COLOR[a.channel as AllocationChannel] ?? CHANNEL_COLOR.safety_stock).bar }} />
                  {CHANNEL_OPTIONS.find(o => o.value === a.channel)?.label ?? a.channel}
                  {" "}<span className="tabular-nums text-zinc-400">{Number(a.percentage).toFixed(1)}%</span>
                </span>
              ))}
            </div>
            <span className={`text-xs tabular-nums whitespace-nowrap ${overAllocated ? "text-red-400" : "text-zinc-500"}`}>
              {totalPct.toFixed(1)}% · {((totalPct / 100) * batchVol).toFixed(1)} BBL
              {overAllocated && <span className="ml-1">⚠ over 100%</span>}
              {!overAllocated && remaining > 0.1 && <span className="ml-1 text-zinc-600">({remaining.toFixed(1)}% open)</span>}
            </span>
          </div>
        </div>
      )}

      {/* Allocation rows */}
      {allocations.length === 0 && !showAddForm && (
        <p className="text-xs text-zinc-600 py-1">No allocations yet. Click &quot;+ Add allocation&quot; to start.</p>
      )}

      {allocations.length > 0 && (
        <div className="rounded-lg border border-zinc-800 divide-y divide-zinc-800/60 overflow-hidden">
          {allocations.map(a => {
            const req = a.commitments;
            const partner = a.contract_brewing_partners;
            const allocBbl = batchVol > 0 ? (Number(a.percentage) / 100) * batchVol : null;
            const pctVal = editingPct[a.id] ?? String(Number(a.percentage).toFixed(1));
            const pctNum = parseFloat(pctVal) || 0;
            const barColor = (CHANNEL_COLOR[a.channel as AllocationChannel] ?? CHANNEL_COLOR.safety_stock).bar;

            return (
              <div key={a.id} className="px-3 py-2.5 hover:bg-zinc-900/40 transition-colors">
                {/* Top line: channel badge + partner/commitment + right-side controls */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <ChannelBadge channel={a.channel as AllocationChannel} />
                    {partner && (
                      <span className="text-xs text-zinc-300 font-medium">{partner.company_name}</span>
                    )}
                    {req && (
                      <span className="text-xs text-zinc-500">
                        {Number(req.volume_bbl)} BBL
                        {req.desired_delivery_date && <span className="ml-1">· due {fmtDateLong(req.desired_delivery_date)}</span>}
                      </span>
                    )}
                    {a.locked && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-blue-400 bg-blue-900/30 border border-blue-800/40 rounded px-1.5 py-0.5">
                        🔒 {a.lock_reason === "deposit_paid" ? "Deposit paid" : "Contract signed"}
                      </span>
                    )}
                    {a.fulfilled && (
                      <span className="text-[10px] text-emerald-400">✓ Fulfilled</span>
                    )}
                    <InvoiceStatusBadge allocation={a} />
                  </div>

                  {/* Controls: % input + BBL + lock + delete */}
                  <div className="flex items-center gap-2 flex-none">
                    {/* Inline % */}
                    <div className="flex items-center gap-1">
                      <input
                        type="number" step="0.1" min="0" max="100"
                        className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-right tabular-nums text-zinc-200 focus:outline-none focus:border-amber-600 disabled:opacity-40"
                        value={pctVal}
                        disabled={a.locked || !!a.invoice_paid_at}
                        onChange={e => setEditingPct(p => ({ ...p, [a.id]: e.target.value }))}
                        onBlur={() => savePct(a)}
                        onKeyDown={e => { if (e.key === "Enter") savePct(a); }}
                      />
                      <span className="text-xs text-zinc-500">%</span>
                    </div>
                    {allocBbl != null && (
                      <span className="text-xs tabular-nums text-zinc-400 w-16 text-right">{allocBbl.toFixed(1)} BBL</span>
                    )}
                    {/* Invoice controls for contract_brewing allocations */}
                    {a.channel === "contract_brewing" && !a.invoice_paid_at && (
                      <div className="flex items-center gap-1">
                        {!a.invoice_generated_at && (
                          <button type="button"
                            onClick={() => openInvoiceModal(a)}
                            disabled={invoiceActionLoading === a.id}
                            className="text-[10px] text-amber-500 hover:text-amber-400 border border-amber-800/50 hover:border-amber-600 rounded px-1.5 py-1 transition-colors disabled:opacity-40 whitespace-nowrap">
                            Generate Invoice
                          </button>
                        )}
                        {a.invoice_generated_at && !a.invoice_sent_at && (
                          <>
                            <button type="button"
                              onClick={() => openInvoiceModal(a)}
                              className="text-[10px] text-zinc-500 hover:text-zinc-300 border border-zinc-700 rounded px-1.5 py-1 transition-colors whitespace-nowrap">
                              Preview
                            </button>
                            <button type="button"
                              onClick={() => handleSendInvoice(a.id)}
                              disabled={invoiceActionLoading === a.id}
                              className="text-[10px] text-amber-500 hover:text-amber-400 border border-amber-800/50 hover:border-amber-600 rounded px-1.5 py-1 transition-colors disabled:opacity-40 whitespace-nowrap">
                              {invoiceActionLoading === a.id ? "Sending…" : "Send Invoice"}
                            </button>
                          </>
                        )}
                        {a.invoice_sent_at && (
                          <button type="button"
                            onClick={() => handleSyncInvoice(a.id)}
                            disabled={invoiceActionLoading === a.id}
                            className="text-[10px] text-zinc-500 hover:text-zinc-300 border border-zinc-700 rounded px-1.5 py-1 transition-colors disabled:opacity-40 whitespace-nowrap">
                            {invoiceActionLoading === a.id ? "Syncing…" : "Sync Status"}
                          </button>
                        )}
                      </div>
                    )}
                    {/* Lock / unlock — only show manual lock for non-CB or unpaid allocations */}
                    {!a.locked && !a.invoice_paid_at && (
                      <select
                        className="text-[10px] bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-zinc-500 cursor-pointer hover:border-zinc-500"
                        defaultValue=""
                        onChange={e => { if (e.target.value) handleLock(a.id, e.target.value as AllocationLockReason); e.target.value = ""; }}>
                        <option value="">Lock…</option>
                        {LOCK_REASON_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    )}
                    {a.locked && !a.invoice_paid_at && (
                      <button type="button" onClick={() => handleUnlock(a.id)}
                        className="text-[10px] text-zinc-500 hover:text-zinc-300 border border-zinc-700 rounded px-1.5 py-1 transition-colors">
                        Unlock
                      </button>
                    )}
                    <button type="button" onClick={() => handleDelete(a.id, a.locked)}
                      className="text-zinc-600 hover:text-red-400 text-sm leading-none transition-colors px-1">✕</button>
                  </div>
                </div>

                {/* Mini allocation bar for this row */}
                <div className="mt-2 h-1 rounded-full bg-zinc-800 overflow-hidden">
                  <div style={{ width: `${Math.min(pctNum, 100)}%`, background: barColor }} className="h-full rounded-full transition-all" />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add allocation form */}
      {showAddForm && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-900/60 p-3 space-y-3">
          <p className="text-xs font-medium text-zinc-400">New Allocation</p>

          {/* Channel selector — horizontal chips */}
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">Channel</label>
            <div className="flex flex-wrap gap-1.5">
              {CHANNEL_OPTIONS.map(o => {
                const active = newChannel === o.value;
                const c = CHANNEL_COLOR[o.value as AllocationChannel];
                return (
                  <button key={o.value} type="button" onClick={() => handleNewChannelChange(o.value as AllocationChannel)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                      active
                        ? `${c.bg} ${c.text} border-white/10`
                        : "bg-zinc-800 text-zinc-500 border-zinc-700 hover:border-zinc-500 hover:text-zinc-300"
                    }`}>
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Commitment (for dist/contract channels) */}
          {!isTaproomChannel(newChannel) && (
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Commitment</label>
              {newChannelCommitments.length === 0 ? (
                <p className="text-xs text-zinc-600 italic">No open commitments for this recipe &amp; channel.</p>
              ) : (
                <select className="inp text-xs w-full" value={newCommitmentId} onChange={e => handleNewCommitmentChange(e.target.value)}>
                  <option value="">— select commitment —</option>
                  {newChannelCommitments.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.contract_brewing_partners?.company_name
                        ? `${c.contract_brewing_partners.company_name} · `
                        : ""}{Number(c.volume_bbl)} BBL
                      {c.desired_delivery_date ? ` · due ${fmtDateLong(c.desired_delivery_date)}` : ""}
                    </option>
                  ))}
                </select>
              )}
              {selectedNewCommitment?.contract_brewing_partners && (
                <p className="text-xs text-zinc-500 mt-1">
                  Partner: <span className="text-zinc-300">{selectedNewCommitment.contract_brewing_partners.company_name}</span>
                  {selectedNewCommitment.received_on && (
                    <span className="ml-2 text-zinc-600">· received {fmtDateLong(selectedNewCommitment.received_on)}</span>
                  )}
                </p>
              )}
            </div>
          )}

          {/* % and BBL */}
          <div className="flex items-end gap-3">
            <div className="flex-none">
              <label className="block text-xs text-zinc-500 mb-1">Allocation %</label>
              <div className="flex items-center gap-1">
                <input type="number" step="0.1" min="0.1" max="100" className="inp w-24 text-xs text-right"
                  placeholder="0.0" value={newPct} onChange={e => setNewPct(e.target.value)} />
                <span className="text-xs text-zinc-500">%</span>
              </div>
            </div>
            {newPct && batchVol > 0 && (
              <div className="pb-1 text-xs text-zinc-400 tabular-nums">
                = <span className="text-zinc-200 font-medium">{((parseFloat(newPct) / 100) * batchVol).toFixed(2)} BBL</span>
              </div>
            )}
            {remaining > 0.1 && !newPct && (
              <button type="button" onClick={() => setNewPct(remaining.toFixed(1))}
                className="pb-1 text-xs text-zinc-600 hover:text-zinc-400 underline underline-offset-2 transition-colors">
                Fill remaining ({remaining.toFixed(1)}%)
              </button>
            )}
          </div>

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={handleAdd} disabled={saving || !newPct}
              className="px-4 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded font-medium transition-colors">
              {saving ? "Adding…" : "Add"}
            </button>
            <button type="button" onClick={() => { setShowAddForm(false); setNewPct(""); setNewCommitmentId(""); setNewChannel("taproom"); }}
              className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Deposit invoice preview modal */}
      {invoiceModalAlloc && (
        <DepositInvoiceModal
          allocation={invoiceModalAlloc}
          preview={invoicePreview}
          loading={invoicePreviewLoading}
          generating={invoiceActionLoading === invoiceModalAlloc.id}
          onGenerate={() => handleGenerateInvoice(invoiceModalAlloc.id)}
          onClose={() => setInvoiceModalAlloc(null)}
        />
      )}
    </div>
  );
}

// ─── Deposit Invoice Preview Modal ───────────────────────────────────────────

function DepositInvoiceModal({
  allocation,
  preview,
  loading,
  generating,
  onGenerate,
  onClose,
}: {
  allocation: BatchAllocation;
  preview: { calculation: DepositCalculation } | null;
  loading: boolean;
  generating: boolean;
  onGenerate: () => void;
  onClose: () => void;
}) {
  const partner = allocation.contract_brewing_partners;
  const calc = preview?.calculation;
  const isRevision = !!allocation.invoice_generated_at;

  return (
    <Modal title={isRevision ? "Revise Deposit Invoice" : "Generate Deposit Invoice"} onClose={onClose}>
      <div className="space-y-4">
        {/* Invoice summary */}
        <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-zinc-500">Partner</span>
            <span className="text-zinc-200 font-medium">{partner?.company_name ?? "—"}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-zinc-500">Batch</span>
            <span className="text-zinc-200">{allocation.brew_batches?.beer_name ?? "—"}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-zinc-500">Allocation</span>
            <span className="text-zinc-200 tabular-nums">{Number(allocation.percentage).toFixed(1)}%</span>
          </div>
        </div>

        {/* Deposit calculation */}
        {loading && (
          <p className="text-xs text-zinc-500 text-center py-4">Calculating deposit…</p>
        )}

        {calc && !loading && (
          <div className="space-y-3">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Ingredient Cost Breakdown</p>
            <div className="rounded-lg border border-zinc-800 overflow-hidden">
              <div className="max-h-48 overflow-y-auto divide-y divide-zinc-800/60">
                {calc.breakdown.map((item, i) => (
                  <div key={i} className="flex justify-between px-3 py-1.5 text-xs">
                    <span className="text-zinc-400">{item.name}</span>
                    <span className="text-zinc-500 tabular-nums ml-4">
                      {item.quantity_per_bbl.toFixed(2)} {item.unit}/BBL × ${item.cost_per_unit.toFixed(2)} = <span className="text-zinc-300">${item.line_total_usd.toFixed(2)}</span>
                    </span>
                  </div>
                ))}
                {calc.breakdown.length === 0 && (
                  <p className="text-xs text-zinc-600 px-3 py-3">No ingredients with costs found on this recipe.</p>
                )}
              </div>

              <div className="border-t border-zinc-700 px-3 py-2 bg-zinc-900/60 space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-500">Total ingredient cost (batch)</span>
                  <span className="text-zinc-300 tabular-nums">${calc.total_ingredient_cost_usd.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-500">Allocation share ({Number(allocation.percentage).toFixed(1)}%)</span>
                  <span className="text-zinc-300 tabular-nums">× {(Number(allocation.percentage) / 100).toFixed(4)}</span>
                </div>
                <div className="flex justify-between text-sm font-semibold border-t border-zinc-700 pt-2 mt-1">
                  <span className="text-zinc-300">Ingredient Deposit</span>
                  <span className="text-amber-400 tabular-nums">${calc.deposit_usd.toFixed(2)}</span>
                </div>
                <p className="text-[10px] text-zinc-600 mt-1">No sales tax charged · payment by card or bank transfer</p>
              </div>
            </div>

            {isRevision && (
              <div className="rounded bg-amber-900/20 border border-amber-800/40 px-3 py-2 text-xs text-amber-300">
                This will cancel the existing draft invoice and create a revised one. The invoice will need to be re-sent.
              </div>
            )}
          </div>
        )}

        {calc && calc.deposit_cents === 0 && (
          <div className="rounded bg-red-900/20 border border-red-800/40 px-3 py-2 text-xs text-red-300">
            Deposit amount is $0. Ensure recipe ingredients have costs set before generating.
          </div>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose}
            className="px-4 py-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
            Cancel
          </button>
          <button
            type="button"
            onClick={onGenerate}
            disabled={generating || loading || !calc || calc.deposit_cents === 0}
            className="px-4 py-1.5 text-sm bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded font-medium transition-colors">
            {generating ? "Generating…" : isRevision ? "Revise Draft Invoice" : "Create Draft Invoice"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Equipment Schedule Section ──────────────────────────────────────────────

const STAGE_LABELS: Record<string, string> = {
  brewhouse:    "Brewing",
  fermenter:    "Fermenting",
  fermenting:   "Fermenting",
  conditioning: "Conditioning",
  kegging:      "Kegging",
  canning:      "Canning",
  cold_storage: "Cold Storage",
};
const STAGE_TO_EQ_TYPE: Record<string, string> = {
  brewhouse:    "brewhouse",
  fermenter:    "fermenter",
  fermenting:   "fermenter",
  conditioning: "brite",
  kegging:      "kegging",
  canning:      "canning",
  cold_storage: "cold_storage",
};
const STAGE_OPTIONS = ["brewhouse", "fermenting", "conditioning", "kegging", "canning", "cold_storage"] as const;

function fmtD(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso.slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtShort(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso.slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function stageDuration(entry: ScheduleEntry): number {
  const s = (entry.actual_start ?? entry.planned_start).slice(0, 10);
  const e = (entry.actual_end   ?? entry.planned_end).slice(0, 10);
  return Math.max(1, Math.round(
    (new Date(e + "T12:00:00").getTime() - new Date(s + "T12:00:00").getTime()) / 86400000
  ));
}

const STAGE_CARD_STYLE: Record<string, { border: string; activeBorder: string; bg: string; label: string; dot: string }> = {
  brewhouse:    { border: "border-amber-700/50",  activeBorder: "border-amber-500",  bg: "bg-amber-950/30",  label: "text-amber-400",  dot: "bg-amber-500"  },
  fermenting:   { border: "border-blue-700/50",   activeBorder: "border-blue-500",   bg: "bg-blue-950/30",   label: "text-blue-400",   dot: "bg-blue-500"   },
  conditioning: { border: "border-teal-700/50",   activeBorder: "border-teal-500",   bg: "bg-teal-950/30",   label: "text-teal-400",   dot: "bg-teal-500"   },
  kegging:      { border: "border-purple-700/50", activeBorder: "border-purple-500", bg: "bg-purple-950/30", label: "text-purple-400", dot: "bg-purple-500" },
  canning:      { border: "border-violet-700/50", activeBorder: "border-violet-500", bg: "bg-violet-950/30", label: "text-violet-400", dot: "bg-violet-500" },
  cold_storage: { border: "border-zinc-600/50",   activeBorder: "border-zinc-400",   bg: "bg-zinc-900/50",   label: "text-zinc-400",   dot: "bg-zinc-400"   },
};

// ── Flow tree types ───────────────────────────────────────────────────────────

type FlowItem =
  | { kind: "entry"; entry: ScheduleEntry; children: FlowItem[] }
  | { kind: "conversion"; toBatch: { id: string; beer_name: string; batch_number: string | null }; volumeBbl: number; children: FlowItem[] }
  | { kind: "ghost"; stage: string; label: string; isRequired: boolean; children: FlowItem[] };

const REQUIRED_PIPELINE: { dbStage: string; label: string }[] = [
  { dbStage: "brewhouse",    label: "Brewing" },
  { dbStage: "fermenting",   label: "Fermenting" },
  { dbStage: "conditioning", label: "Conditioning" },
];

function nextRequiredStageAfter(stage: string): { dbStage: string; label: string } | null {
  const norm = stage === "fermenter" ? "fermenting" : stage;
  const idx = REQUIRED_PIPELINE.findIndex(s => s.dbStage === norm);
  return (idx >= 0 && idx < REQUIRED_PIPELINE.length - 1) ? REQUIRED_PIPELINE[idx + 1] : null;
}

function buildFlowTree(
  entries: ScheduleEntry[],
  batchTransfers: BatchTransfer[],
  allTransfers: BatchTransfer[],
  allBatches: BrewBatch[],
  batch?: BrewBatch,
): FlowItem | null {
  const active = entries.filter(e => !e.cancelled_at);
  if (!active.length) return null;

  const packagingEntries = active.filter(e => e.stage === "kegging" || e.stage === "canning");
  const mainEntries = active.filter(e => e.stage !== "kegging" && e.stage !== "canning");

  const entryByTank = new Map<string, ScheduleEntry>();
  for (const e of mainEntries) {
    if (e.equipment_id) entryByTank.set(e.equipment_id, e);
  }

  // Tank→child-tanks from this batch's transfers
  const childTanks = new Map<string, Set<string>>();
  for (const t of batchTransfers) {
    if (t.from_tank_id && t.to_tank_id) {
      if (!childTanks.has(t.from_tank_id)) childTanks.set(t.from_tank_id, new Set());
      childTanks.get(t.from_tank_id)!.add(t.to_tank_id);
    }
  }

  // Conversion children: batches where converted_from_batch_id = this batch
  const batchTankIds = new Set(entryByTank.keys());
  const convsByTank = new Map<string, Array<{ toBatch: BrewBatch; volumeBbl: number }>>();
  for (const cb of allBatches.filter(b => b.converted_from_batch_id === batch?.id)) {
    const sourceTx = allTransfers
      .filter(t => t.batch_id === cb.id && t.from_tank_id && batchTankIds.has(t.from_tank_id))
      .sort((a, b) => new Date(a.transferred_at).getTime() - new Date(b.transferred_at).getTime())[0];
    if (sourceTx?.from_tank_id) {
      const src = sourceTx.from_tank_id;
      if (!convsByTank.has(src)) convsByTank.set(src, []);
      convsByTank.get(src)!.push({ toBatch: cb, volumeBbl: Number(sourceTx.volume_bbl) });
    }
  }

  // Root = brewhouse entry, else first entry with no inbound transfer
  const tanksWithInflow = new Set(batchTransfers.filter(t => t.to_tank_id).map(t => t.to_tank_id!));
  let rootEntry = mainEntries.find(e => e.stage === "brewhouse")
    ?? mainEntries.find(e => e.equipment_id && !tanksWithInflow.has(e.equipment_id))
    ?? mainEntries[0];
  if (!rootEntry) return null;

  const visitedIds = new Set<string>();

  function buildNode(entry: ScheduleEntry): FlowItem {
    visitedIds.add(entry.id);
    const tankId = entry.equipment_id ?? "";
    const children: FlowItem[] = [];

    // Children via tank transfers
    for (const childTankId of childTanks.get(tankId) ?? []) {
      const childEntry = entryByTank.get(childTankId);
      if (childEntry && !visitedIds.has(childEntry.id)) {
        children.push(buildNode(childEntry));
      }
    }

    // Conversion terminal nodes
    for (const conv of convsByTank.get(tankId) ?? []) {
      children.push({ kind: "conversion", toBatch: conv.toBatch, volumeBbl: conv.volumeBbl, children: [] });
    }

    // Packaging entries attached to conditioning leaf
    if (entry.stage === "conditioning") {
      const kEntry = packagingEntries.filter(e => e.stage === "kegging" && !visitedIds.has(e.id));
      const cEntry = packagingEntries.filter(e => e.stage === "canning" && !visitedIds.has(e.id));
      for (const pe of [...kEntry, ...cEntry]) {
        visitedIds.add(pe.id);
        // Multiple kegging entries chain as siblings
        children.push({ kind: "entry", entry: pe, children: [] });
      }
      // Ghost optional slots if not yet scheduled
      if (!kEntry.length) children.push({ kind: "ghost", stage: "kegging", label: "Kegging", isRequired: false, children: [] });
      if (!cEntry.length) children.push({ kind: "ghost", stage: "canning", label: "Canning", isRequired: false, children: [] });
    }

    // Ghost next required stage if this is a leaf and not complete
    if (children.length === 0 && !entry.actual_end) {
      const next = nextRequiredStageAfter(entry.stage);
      if (next) children.push({ kind: "ghost", stage: next.dbStage, label: next.label, isRequired: true, children: [] });
    }

    return { kind: "entry", entry, children };
  }

  return buildNode(rootEntry);
}

// ── Flow tree renderer ────────────────────────────────────────────────────────

function FlowNode({
  item,
  onEdit,
  onBuild,
  editing,
  onRemove,
}: {
  item: FlowItem;
  onEdit: (e: ScheduleEntry) => void;
  onBuild: () => void;
  editing: ScheduleEntry | null;
  onRemove: (id: string) => void;
}) {
  const card = (() => {
    if (item.kind === "conversion") {
      return (
        <div className="flex-none w-44 rounded-lg border border-dashed border-amber-700/50 bg-amber-950/20 select-none">
          <div className="h-0.5 w-full rounded-t-lg bg-amber-700/40" />
          <div className="p-3 min-h-[96px] flex flex-col justify-center gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-500">Converted →</span>
            <p className="text-xs font-semibold text-amber-300 truncate">{item.toBatch.beer_name}</p>
            {item.toBatch.batch_number && (
              <p className="text-[10px] font-mono text-amber-600">#{item.toBatch.batch_number}</p>
            )}
            <p className="text-[10px] text-amber-700 mt-0.5">{fmtBbl2(item.volumeBbl)}</p>
          </div>
        </div>
      );
    }
    if (item.kind === "ghost") {
      const isRequired = item.isRequired;
      return (
        <div
          onClick={onBuild}
          className={`flex-none w-44 rounded-lg border border-dashed cursor-pointer transition-all select-none
            ${isRequired
              ? "border-zinc-600 hover:border-amber-600/60 bg-zinc-900/20 hover:bg-amber-950/10"
              : "border-zinc-700 hover:border-zinc-500 bg-zinc-900/10 hover:bg-zinc-800/20"}`}
        >
          <div className={`h-0.5 w-full rounded-t-lg ${isRequired ? "bg-zinc-700/50" : "bg-zinc-800/30"}`} />
          <div className="p-3 flex flex-col items-start justify-center min-h-[96px] gap-1">
            <span className={`text-[10px] font-bold uppercase tracking-wider ${isRequired ? "text-zinc-500" : "text-zinc-600"}`}>
              {item.label}
            </span>
            <span className={`text-xs ${isRequired ? "text-zinc-500" : "text-zinc-600"}`}>
              {isRequired ? "Not scheduled" : `+ Add ${item.label.toLowerCase()}`}
            </span>
            {isRequired && <span className="text-[10px] text-amber-600/70 mt-0.5">⚠ Schedule needed</span>}
          </div>
        </div>
      );
    }
    // entry
    const e = item.entry;
    const style = STAGE_CARD_STYLE[e.stage === "fermenter" ? "fermenting" : e.stage] ?? STAGE_CARD_STYLE.cold_storage;
    const isEditingThis = editing?.id === e.id;
    const isDone   = !!e.actual_end;
    const isActive = !!e.actual_start && !isDone;
    const days     = stageDuration(e);
    return (
      <div
        onClick={() => onEdit(e)}
        className={`relative group flex-none w-44 rounded-lg border cursor-pointer transition-all select-none
          ${style.bg}
          ${isEditingThis ? style.activeBorder + " ring-2 ring-amber-600/40 border-2" : style.border + " border hover:border-opacity-100"}`}
      >
        <div className={`h-0.5 w-full rounded-t-lg ${isDone ? "bg-emerald-500" : isActive ? "bg-amber-400" : "bg-zinc-700"}`} />
        <div className="p-3">
          <div className="flex items-center justify-between mb-2">
            <span className={`text-[10px] font-bold uppercase tracking-wider ${style.label}`}>
              {STAGE_LABELS[e.stage] ?? e.stage}
            </span>
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
              isDone ? "bg-emerald-900/50 text-emerald-400" : isActive ? "bg-amber-900/50 text-amber-400" : "bg-zinc-800 text-zinc-500"
            }`}>{isDone ? "Done" : isActive ? "Active" : "Planned"}</span>
          </div>
          <p className="text-xs font-semibold text-zinc-200 truncate mb-2 min-h-[1rem]">
            {e.equipment?.name ?? <span className="text-zinc-600 font-normal italic">No tank assigned</span>}
          </p>
          <div className="text-[11px] text-zinc-400 space-y-0.5">
            {e.actual_start ? (
              <div className="flex items-center gap-1">
                <span className="text-emerald-500">●</span>
                <span>{fmtShort(e.actual_start)}</span>
                {e.actual_end && <><span className="text-zinc-600">→</span><span>{fmtShort(e.actual_end)}</span></>}
              </div>
            ) : (
              <div className="flex items-center gap-1 text-zinc-500">
                <span className="text-zinc-700">○</span>
                <span>{fmtShort(e.planned_start)}</span>
                <span className="text-zinc-700">→</span>
                <span>{fmtShort(e.planned_end)}</span>
              </div>
            )}
            <div className="text-zinc-600">{days}d</div>
          </div>
        </div>
        <button type="button" onClick={ev => { ev.stopPropagation(); onRemove(e.id); }}
          className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 text-xs transition-opacity leading-none"
          title="Remove">×</button>
      </div>
    );
  })();

  const { children } = item;

  if (!children.length) return <div className="flex-none">{card}</div>;

  const childProps = { onEdit, onBuild, editing, onRemove };

  if (children.length === 1) {
    return (
      <div className="flex items-center gap-0">
        <div className="flex-none">{card}</div>
        <div className="flex-none flex items-center w-10">
          <div className="flex-1 border-t border-dashed border-zinc-600" />
          <span className="text-zinc-500 text-sm">›</span>
        </div>
        <FlowNode item={children[0]} {...childProps} />
      </div>
    );
  }

  // Fork: multiple children branch downward
  return (
    <div className="flex items-center gap-0">
      <div className="flex-none">{card}</div>
      <div className="flex-none w-6 flex items-center self-stretch">
        <div className="w-full border-t border-dashed border-zinc-600" />
      </div>
      <div className="flex-none self-stretch border-l border-dashed border-zinc-600" />
      <div className="flex flex-col gap-3 py-1">
        {children.map((child, i) => (
          <div key={i} className="flex items-center">
            <div className="w-6 border-t border-dashed border-zinc-600" />
            <span className="text-zinc-500 text-sm mr-0.5">›</span>
            <FlowNode item={child} {...childProps} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── EquipmentScheduleSection ──────────────────────────────────────────────────

function EquipmentScheduleSection({
  batchId,
  entries,
  equipment,
  batch,
  recipes,
}: {
  batchId: string;
  entries: ScheduleEntry[];
  equipment: import("../types").Equipment[];
  batch?: BrewBatch;
  recipes?: import("../types").Recipe[];
}) {
  const qc = useQueryClient();
  const reload = () => qc.invalidateQueries({ queryKey: productionKeys.batchSchedule });
  const { data: allScheduleEntries = [] } = useBatchScheduleQuery();
  const { data: allTransfers = [] } = useTransfersQuery();
  const { data: allBatches = [] } = useBatchesQuery();

  const [editing, setEditing] = useState<ScheduleEntry | null>(null);
  const [showBuildPanel, setShowBuildPanel] = useState(false);
  const [saving, setSaving] = useState(false);

  const blankForm = () => ({
    equipment_id: "", stage: "fermenting" as string,
    planned_start: "", planned_end: "",
    actual_start: "", actual_end: "", notes: "",
  });
  const [form, setForm] = useState(blankForm());
  const f = (k: keyof typeof form, v: string) => setForm((p) => ({ ...p, [k]: v }));

  function openEdit(entry: ScheduleEntry) {
    setEditing(entry);
    setShowBuildPanel(false);
    setForm({
      equipment_id: entry.equipment_id ?? "",
      stage: entry.stage,
      planned_start: entry.planned_start?.slice(0, 10) ?? "",
      planned_end: entry.planned_end?.slice(0, 10) ?? "",
      actual_start: entry.actual_start?.slice(0, 10) ?? "",
      actual_end: entry.actual_end?.slice(0, 10) ?? "",
      notes: entry.notes ?? "",
    });
  }

  async function save() {
    if (form.equipment_id && form.planned_start && form.planned_end) {
      const conflict = allScheduleEntries.find(e =>
        e.id !== editing?.id && e.batch_id !== batchId &&
        e.equipment_id === form.equipment_id && !e.cancelled_at &&
        e.planned_start.slice(0, 10) < form.planned_end &&
        e.planned_end.slice(0, 10) > form.planned_start
      );
      if (conflict) {
        const name = conflict.brew_batches
          ? `#${conflict.brew_batches.batch_number} ${conflict.brew_batches.beer_name}`
          : "another batch";
        if (!confirm(`Warning: this equipment is already scheduled for ${name} during the selected dates. Save anyway?`)) return;
      }
    }
    setSaving(true);
    try {
      const payload = {
        batch_id: batchId,
        equipment_id: form.equipment_id || null,
        stage: form.stage,
        planned_start: form.planned_start ? form.planned_start + "T12:00:00" : null,
        planned_end: form.planned_end ? form.planned_end + "T12:00:00" : null,
        actual_start: form.actual_start ? form.actual_start + "T12:00:00" : null,
        actual_end: form.actual_end ? form.actual_end + "T12:00:00" : null,
        notes: form.notes || null,
      };
      const url = editing ? `/api/production/batch-schedule/${editing.id}` : "/api/production/batch-schedule";
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");

      const isPackaging = form.stage === "kegging" || form.stage === "canning";
      if (isPackaging && form.planned_end) {
        const otherEnds = entries
          .filter(e => !e.cancelled_at && (e.stage === "kegging" || e.stage === "canning") && e.id !== editing?.id)
          .map(e => e.planned_end.slice(0, 10));
        const latestEnd = [...otherEnds, form.planned_end].sort().at(-1)!;
        const cond = entries.find(e => !e.cancelled_at && e.stage === "conditioning");
        if (cond) {
          await fetch(`/api/production/batch-schedule/${cond.id}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ planned_end: latestEnd + "T12:00:00" }),
          });
        }
      }

      await reload();
      setEditing(null);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this schedule entry?")) return;
    const removed = entries.find(e => e.id === id);
    await fetch(`/api/production/batch-schedule/${id}`, { method: "DELETE" });

    if (removed && (removed.stage === "kegging" || removed.stage === "canning")) {
      const remaining = entries
        .filter(e => !e.cancelled_at && (e.stage === "kegging" || e.stage === "canning") && e.id !== id)
        .map(e => e.planned_end.slice(0, 10)).sort();
      const cond = entries.find(e => !e.cancelled_at && e.stage === "conditioning");
      if (cond && remaining.length > 0) {
        await fetch(`/api/production/batch-schedule/${cond.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ planned_end: remaining.at(-1)! + "T12:00:00" }),
        });
      }
    }

    await reload();
    setEditing(null);
  }

  // Build flow tree from transfers + schedule entries
  const batchTransfers = allTransfers.filter(t => t.batch_id === batchId);
  const flowRoot = buildFlowTree(entries, batchTransfers, allTransfers, allBatches, batch);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Equipment Schedule</p>
      </div>

      {/* ── Transfer-graph flow tree ──────────────────────────────────── */}
      <div className="overflow-x-auto pb-2 mb-3">
        <div className="flex items-center min-w-max">
          {flowRoot ? (
            <FlowNode
              item={flowRoot}
              onEdit={openEdit}
              onBuild={() => { setEditing(null); setShowBuildPanel(true); }}
              editing={editing}
              onRemove={remove}
            />
          ) : (
            <button
              type="button"
              onClick={() => { setEditing(null); setShowBuildPanel(true); }}
              className="w-44 min-h-[96px] rounded-lg border border-dashed border-zinc-700 hover:border-zinc-500 bg-zinc-900/30 hover:bg-zinc-800/30 transition-colors flex flex-col items-center justify-center gap-1 text-zinc-600 hover:text-zinc-400"
            >
              <span className="text-lg leading-none">+</span>
              <span className="text-[10px]">Build schedule</span>
            </button>
          )}
          {/* Extra stage button */}
          {flowRoot && (
            <div className="flex-none flex items-center ml-3">
              <button
                type="button"
                onClick={() => { setEditing(null); setShowBuildPanel(true); }}
                className="w-20 min-h-[64px] rounded-lg border border-dashed border-zinc-700 hover:border-zinc-500 bg-zinc-900/20 hover:bg-zinc-800/20 transition-colors flex flex-col items-center justify-center gap-1 text-zinc-600 hover:text-zinc-400"
              >
                <span className="text-base leading-none">+</span>
                <span className="text-[10px] text-center leading-tight">Add extra stage</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Inline edit form */}
      {editing !== null && (
        <div className="rounded border border-zinc-700 bg-zinc-900/60 p-3 mb-3 space-y-3">
          <p className="text-xs text-zinc-400 font-medium">Edit entry</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Stage</label>
              <select className="inp text-xs" value={form.stage} onChange={e => { f("stage", e.target.value); f("equipment_id", ""); }}>
                {STAGE_OPTIONS.map(s => <option key={s} value={s}>{STAGE_LABELS[s] ?? s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Equipment</label>
              <select className="inp text-xs" value={form.equipment_id} onChange={e => f("equipment_id", e.target.value)}>
                <option value="">— none —</option>
                {equipment.filter(eq => eq.type === STAGE_TO_EQ_TYPE[form.stage]).map(eq => (
                  <option key={eq.id} value={eq.id}>{eq.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Planned Start</label>
              <input type="date" className="inp text-xs" value={form.planned_start} onChange={e => f("planned_start", e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Planned End</label>
              <input type="date" className="inp text-xs" value={form.planned_end} onChange={e => f("planned_end", e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Actual Start</label>
              <input type="date" className="inp text-xs" value={form.actual_start} onChange={e => f("actual_start", e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Actual End</label>
              <input type="date" className="inp text-xs" value={form.actual_end} onChange={e => f("actual_end", e.target.value)} />
            </div>
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Notes</label>
            <input type="text" className="inp text-xs" value={form.notes} onChange={e => f("notes", e.target.value)} placeholder="Optional" />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={save} disabled={saving || !form.planned_start || !form.planned_end}
              className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded font-medium">
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button type="button" onClick={() => remove(editing.id)}
              className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-red-800 text-zinc-300 rounded">Delete</button>
            <button type="button" onClick={() => setEditing(null)}
              className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
          </div>
        </div>
      )}

      {/* Build panel */}
      {showBuildPanel && batch && recipes && (
        <BuildScheduleSection
          batchId={batchId}
          batch={batch}
          recipes={recipes}
          equipment={equipment}
          entries={entries}
          onSaved={reload}
          onClose={() => setShowBuildPanel(false)}
        />
      )}
    </div>
  );
}

// ─── Build-Schedule helper (for manually-created batches) ────────────────────

interface BuildSlot {
  stage: "brewhouse" | "fermenter" | "brite" | "kegging" | "canning";
  equipment_id: string;
  scheduled_start: string;
  scheduled_end: string;
  volume_bbl?: string; // kegging/canning only — partial batch barrelage
}

const BUILD_STAGE_LABELS: Record<string, string> = {
  brewhouse: "Brewing",
  fermenter: "Fermenting",
  brite:     "Conditioning",
  kegging:   "Kegging",
  canning:   "Canning",
};
const BUILD_STAGE_COLORS: Record<string, string> = {
  brewhouse: "bg-amber-900/50 text-amber-300 border-amber-700",
  fermenter:  "bg-blue-900/50 text-blue-300 border-blue-700",
  brite:      "bg-teal-900/50 text-teal-300 border-teal-700",
  kegging:    "bg-purple-900/50 text-purple-300 border-purple-700",
  canning:    "bg-violet-900/50 text-violet-300 border-violet-700",
};

// Required stages — also determines when the "Build schedule" button appears
const PIPELINE: { slot: BuildSlot["stage"]; dbStage: string }[] = [
  { slot: "brewhouse", dbStage: "brewhouse"    },
  { slot: "fermenter", dbStage: "fermenting"   },
  { slot: "brite",     dbStage: "conditioning" },
];
// Optional packaging stages — added on demand in the build panel
const OPTIONAL_PIPELINE: { slot: BuildSlot["stage"]; dbStage: string; label: string }[] = [
  { slot: "kegging", dbStage: "kegging", label: "+ Add Kegging" },
  { slot: "canning", dbStage: "canning", label: "+ Add Canning" },
];

// Shows upcoming kegging/canning days already scheduled for OTHER batches,
// so users can pick an existing day to aggregate onto rather than creating a new one.
function PackagingDaysSummary({
  stage,
  excludeBatchId,
  onPickDate,
}: {
  stage: "kegging" | "canning";
  excludeBatchId: string;
  onPickDate: (date: string) => void;
}) {
  const { data: allEntries = [] } = useBatchScheduleQuery();
  const today = new Date().toISOString().slice(0, 10);

  // Group by planned_start date, summing volume_bbl across batches
  const dayMap = new Map<string, { totalBbl: number; batchCount: number }>();
  for (const e of allEntries) {
    if (e.stage !== stage) continue;
    if (e.batch_id === excludeBatchId) continue;
    if (e.cancelled_at) continue;
    const date = e.planned_start.slice(0, 10);
    if (date < today) continue; // skip past days
    const existing = dayMap.get(date) ?? { totalBbl: 0, batchCount: 0 };
    dayMap.set(date, {
      totalBbl:    existing.totalBbl + Number(e.volume_bbl ?? 0),
      batchCount:  existing.batchCount + 1,
    });
  }

  const days = [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 5); // show next 5 upcoming days

  if (days.length === 0) return null;

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-2 space-y-1">
      <p className="text-[10px] text-zinc-600 uppercase tracking-wide">
        Upcoming {stage === "kegging" ? "keg" : "can"} days — click to join
      </p>
      {days.map(([date, { totalBbl, batchCount }]) => (
        <button
          key={date}
          type="button"
          onClick={() => onPickDate(date)}
          className="w-full flex items-center justify-between text-[11px] px-2 py-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <span>{new Date(date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
          <span className="text-zinc-600">
            {batchCount} batch{batchCount !== 1 ? "es" : ""}
            {totalBbl > 0 ? ` · ${totalBbl.toFixed(2)} BBL planned` : ""}
          </span>
        </button>
      ))}
    </div>
  );
}

function BuildScheduleSection({
  batchId,
  batch,
  recipes,
  equipment,
  entries,
  onSaved,
  onClose,
}: {
  batchId: string;
  batch: BrewBatch;
  recipes: import("../types").Recipe[];
  equipment: import("../types").Equipment[];
  entries: ScheduleEntry[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const recipe = recipes.find((r) => r.id === batch.recipe_id);
  const stageDays: Record<BuildSlot["stage"], number> = {
    brewhouse: recipe?.days_brewhouse ?? 1,
    fermenter:  recipe?.days_fermenter ?? 14,
    brite:      recipe?.days_brite ?? 7,
    kegging:    1,
    canning:    1,
  };

  // Only create slots for stages that have no existing uncancelled entry
  const activeEntryByDbStage = Object.fromEntries(
    entries.filter((e) => !e.cancelled_at).map((e) => [e.stage, e])
  );
  const missingPipeline = PIPELINE.filter(({ dbStage }) => !activeEntryByDbStage[dbStage]);

  const defaultSlots = (): BuildSlot[] =>
    missingPipeline.map(({ slot }) => ({ stage: slot, equipment_id: "", scheduled_start: "", scheduled_end: "" }));

  const [slots, setSlots] = useState<BuildSlot[]>(defaultSlots);
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const EQ_TYPE_FOR_SLOT: Record<BuildSlot["stage"], string> = {
    brewhouse: "brewhouse", fermenter: "fermenter", brite: "brite",
    kegging: "kegging", canning: "canning",
  };
  const poolFor = (stage: BuildSlot["stage"]) =>
    equipment.filter((e) => e.type === EQ_TYPE_FOR_SLOT[stage]);

  function computeStartsForSlots(currentSlots: BuildSlot[]): Partial<Record<BuildSlot["stage"], Date>> {
    if (!batch.planned_brew_date) return {};
    let cursor = parseISO(batch.planned_brew_date.slice(0, 10) + "T12:00:00");

    const startForSlot: Partial<Record<BuildSlot["stage"], Date>> = {};

    // Brewing and Fermenting share the same start date (pitch day).
    // Only Fermenting's duration advances the cursor to Conditioning.
    for (const { slot, dbStage } of PIPELINE) {
      const existing = activeEntryByDbStage[dbStage];
      if (existing) {
        // Only advance cursor past fermenter's end (not brewhouse — it's same-day)
        if (slot !== "brewhouse") {
          cursor = parseISO(existing.planned_end.slice(0, 10) + "T12:00:00");
        }
      } else {
        startForSlot[slot] = cursor;
        // Brewhouse occupies the same start day — don't advance cursor
        if (slot !== "brewhouse") {
          cursor = addDays(cursor, stageDays[slot]);
        }
      }
    }
    // Optional slots chain from conditioning's end
    for (const { slot, dbStage } of OPTIONAL_PIPELINE) {
      const existing = activeEntryByDbStage[dbStage];
      if (existing) {
        cursor = parseISO(existing.planned_end.slice(0, 10) + "T12:00:00");
      } else if (currentSlots.some((s) => s.stage === slot)) {
        startForSlot[slot] = cursor;
        cursor = addDays(cursor, stageDays[slot]);
      }
    }
    return startForSlot;
  }

  function autoFill() {
    const starts = computeStartsForSlots(slots);
    setSlots((prev) => prev.map((s) => {
      const start = starts[s.stage];
      if (!start) return s;
      const end = addDays(start, stageDays[s.stage]);
      return { ...s, scheduled_start: start.toISOString().slice(0, 10), scheduled_end: end.toISOString().slice(0, 10) };
    }));
  }

  function addOptionalSlot(slot: "kegging" | "canning", pinDate?: string) {
    if (slots.some((s) => s.stage === slot)) return;
    const newSlots = [...slots, { stage: slot, equipment_id: "", scheduled_start: "", scheduled_end: "" }];
    const starts = computeStartsForSlots(newSlots);
    const autoStart = starts[slot];
    setSlots(newSlots.map((s) => {
      if (s.stage !== slot) return s;
      const startDate = pinDate ? parseISO(pinDate + "T12:00:00") : autoStart;
      if (!startDate) return s;
      const end = addDays(startDate, stageDays[slot]);
      return { ...s, scheduled_start: startDate.toISOString().slice(0, 10), scheduled_end: end.toISOString().slice(0, 10) };
    }));
  }

  function removeOptionalSlot(slot: "kegging" | "canning") {
    setSlots((prev) => prev.filter((s) => s.stage !== slot));
  }

  async function suggest() {
    if (!batch.recipe_id) return;
    setSuggesting(true);
    try {
      const res = await fetch("/api/production/batch-scheduler/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipe_id: batch.recipe_id,
          earliest_start: batch.planned_brew_date || undefined,
          volume_bbl: Number(batch.volume_bbl) || undefined,
          turns: batch.turns || 1,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Suggestion failed");
      const result = await res.json() as {
        equipment_sequence: { stage: "brewhouse" | "fermenter" | "brite"; equipment_id: string; scheduled_start: string; scheduled_end: string }[];
      };
      // Only apply suggestions for missing stages
      const missingStageSlugs = new Set(missingPipeline.map((p) => p.slot));
      setSlots(
        result.equipment_sequence
          .filter((s) => missingStageSlugs.has(s.stage))
          .map((s) => ({ stage: s.stage, equipment_id: s.equipment_id, scheduled_start: s.scheduled_start, scheduled_end: s.scheduled_end }))
      );
    } catch (e) {
      alert(e instanceof Error ? e.message : "Suggestion failed");
    } finally {
      setSuggesting(false);
    }
  }

  async function save() {
    if (slots.some((s) => !s.scheduled_start || !s.scheduled_end)) {
      alert("Fill in start and end dates for all stages before saving."); return;
    }
    setSaving(true);
    try {
      // Resolve IDs for all pipeline stages (existing + newly saved)
      const resolvedIds: Partial<Record<BuildSlot["stage"], string>> = {};

      // Seed with already-existing entry IDs for required and optional stages
      const allPipelineStages = [...PIPELINE, ...OPTIONAL_PIPELINE];
      for (const { slot, dbStage } of allPipelineStages) {
        const existing = activeEntryByDbStage[dbStage];
        if (existing) resolvedIds[slot] = existing.id;
      }

      // Save each slot (POST new entries, PATCH existing ones)
      for (const slot of slots) {
        const pipelineDef = [...PIPELINE, ...OPTIONAL_PIPELINE].find((p) => p.slot === slot.stage);
        if (!pipelineDef) continue;
        const existing = activeEntryByDbStage[pipelineDef.dbStage];
        const isPackaging = slot.stage === "kegging" || slot.stage === "canning";
        const payload: Record<string, unknown> = {
          batch_id:      batchId,
          equipment_id:  slot.equipment_id || null,
          stage:         pipelineDef.dbStage,
          planned_start: slot.scheduled_start + "T12:00:00",
          planned_end:   slot.scheduled_end   + "T12:00:00",
          ...(isPackaging && slot.volume_bbl ? { volume_bbl: Number(slot.volume_bbl) } : {}),
        };
        const url    = existing ? `/api/production/batch-schedule/${existing.id}` : "/api/production/batch-schedule";
        const method = existing ? "PATCH" : "POST";
        const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
        const saved = await res.json();
        resolvedIds[slot.stage] = saved.id;
      }

      // Conditioning's planned_end = latest packaging planned_end across ALL kegging/canning
      // entries for this batch (existing + newly saved). Brite isn't free until the last pull.
      const existingPackagingEnds = entries
        .filter((e) => !e.cancelled_at && (e.stage === "kegging" || e.stage === "canning"))
        .map((e) => e.planned_end.slice(0, 10));
      const newPackagingEnds = slots
        .filter((s) => s.stage === "kegging" || s.stage === "canning")
        .map((s) => s.scheduled_end)
        .filter(Boolean);
      const allPackagingEnds = [...existingPackagingEnds, ...newPackagingEnds].sort();
      const latestPackagingEnd = allPackagingEnds[allPackagingEnds.length - 1];
      if (latestPackagingEnd) {
        const conditioningEntryId = resolvedIds["brite"] ?? activeEntryByDbStage["conditioning"]?.id;
        if (conditioningEntryId) {
          await fetch(`/api/production/batch-schedule/${conditioningEntryId}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ planned_end: latestPackagingEnd + "T12:00:00" }),
          });
        }
      }

      // Build the full ordered chain: required pipeline + any optional stages that were saved
      const activeOptionalSlots = OPTIONAL_PIPELINE.filter(({ slot }) => resolvedIds[slot]);
      const fullChain = [...PIPELINE, ...activeOptionalSlots];

      // Wire downstream chain across the full pipeline (existing + new)
      for (let i = 0; i < fullChain.length - 1; i++) {
        const fromId = resolvedIds[fullChain[i].slot];
        const toId   = resolvedIds[fullChain[i + 1].slot];
        if (fromId && toId) {
          await fetch(`/api/production/batch-schedule/${fromId}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ downstream_entry_id: toId }),
          });
        }
      }

      onSaved();
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const hasExisting = missingPipeline.length < PIPELINE.length;
  const sectionTitle = hasExisting
    ? `Add stages (${missingPipeline.map((p) => BUILD_STAGE_LABELS[p.slot]).join(", ")} missing)`
    : "Build Equipment Schedule";

  return (
    <div className="mt-2 rounded border border-zinc-700 bg-zinc-900/60 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400">{sectionTitle}</span>
        <div className="flex gap-2">
          <button type="button" onClick={suggest} disabled={suggesting || !batch.recipe_id}
            className="text-xs text-amber-500 hover:text-amber-400 disabled:opacity-40">
            {suggesting ? "Suggesting…" : "✦ Auto-suggest"}
          </button>
          <button type="button" onClick={autoFill} disabled={!batch.planned_brew_date}
            className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-40">
            Auto-fill dates
          </button>
          <button type="button" onClick={onClose} className="text-xs text-zinc-600 hover:text-zinc-400">✕</button>
        </div>
      </div>
      {slots.map((slot, idx) => {
        const pool = poolFor(slot.stage);
        const isOptional = OPTIONAL_PIPELINE.some((p) => p.slot === slot.stage);
        return (
          <div key={slot.stage} className={`rounded border px-2.5 py-2 space-y-1.5 ${BUILD_STAGE_COLORS[slot.stage]}`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-medium">{BUILD_STAGE_LABELS[slot.stage]}</span>
              {isOptional && (
                <button type="button" onClick={() => removeOptionalSlot(slot.stage as "kegging" | "canning")}
                  className="text-[10px] text-zinc-500 hover:text-red-400 transition-colors">✕ Remove</button>
              )}
            </div>
            <div className={`grid gap-2 ${isOptional ? "grid-cols-4" : "grid-cols-3"}`}>
              <div>
                <label className="block text-[10px] mb-0.5 opacity-70">Tank</label>
                <select className="inp text-xs w-full" value={slot.equipment_id}
                  onChange={(e) => setSlots((prev) => prev.map((s, i) => i === idx ? { ...s, equipment_id: e.target.value } : s))}>
                  <option value="">— select —</option>
                  {pool.map((eq) => <option key={eq.id} value={eq.id}>{eq.name}{eq.capacity_bbl ? ` (${eq.capacity_bbl} BBL)` : ""}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] mb-0.5 opacity-70">Start</label>
                <input type="date" className="inp text-xs w-full" value={slot.scheduled_start}
                  onChange={(e) => setSlots((prev) => prev.map((s, i) => i === idx ? { ...s, scheduled_start: e.target.value } : s))} />
              </div>
              <div>
                <label className="block text-[10px] mb-0.5 opacity-70">End</label>
                <input type="date" className="inp text-xs w-full" value={slot.scheduled_end}
                  onChange={(e) => setSlots((prev) => prev.map((s, i) => i === idx ? { ...s, scheduled_end: e.target.value } : s))} />
              </div>
              {isOptional && (
                <div>
                  <label className="block text-[10px] mb-0.5 opacity-70">Planned BBL</label>
                  <input type="number" step="0.01" min="0" placeholder="e.g. 3.5"
                    className="inp text-xs w-full" value={slot.volume_bbl ?? ""}
                    onChange={(e) => setSlots((prev) => prev.map((s, i) => i === idx ? { ...s, volume_bbl: e.target.value } : s))} />
                </div>
              )}
            </div>
          </div>
        );
      })}
      {/* Optional stage toggle buttons + existing packaging days */}
      {OPTIONAL_PIPELINE.filter(({ slot, dbStage }) =>
        !slots.some((s) => s.stage === slot) && !activeEntryByDbStage[dbStage]
      ).map(({ slot, label }) => (
        <div key={slot} className="space-y-1">
          <button type="button" onClick={() => addOptionalSlot(slot as "kegging" | "canning")}
            className="text-xs text-zinc-500 hover:text-zinc-300 border border-dashed border-zinc-700 hover:border-zinc-500 px-2 py-1 rounded transition-colors w-full text-left">
            {label}
          </button>
          <PackagingDaysSummary stage={slot as "kegging" | "canning"} excludeBatchId={batchId}
            onPickDate={(date) => addOptionalSlot(slot as "kegging" | "canning", date)} />
        </div>
      ))}
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={save} disabled={saving}
          className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded font-medium">
          {saving ? "Saving…" : "Save schedule"}
        </button>
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
      </div>
    </div>
  );
}

// ─── Batch table ─────────────────────────────────────────────────────────────

function SortTh({
  col, label, sort, onSort, className = "",
}: {
  col: SortCol; label: string; sort: { col: SortCol; dir: "asc" | "desc" }; onSort: (c: SortCol) => void; className?: string;
}) {
  const active = sort.col === col;
  return (
    <th
      className={`px-4 py-2.5 text-xs font-medium text-zinc-500 cursor-pointer select-none hover:text-zinc-300 transition-colors ${className}`}
      onClick={() => onSort(col)}
    >
      {label}{active ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
    </th>
  );
}

function BatchTable({
  batches,
  transfers,
  scheduleEntries,
  equipment,
  expandedId,
  sort,
  onToggle,
  onEdit,
  onArchive,
  onDelete,
  isAdmin,
  onSort,
  tankTypeById,
  assignedBatchIds,
  recipes,
}: {
  batches: BrewBatch[];
  transfers: BatchTransfer[];
  scheduleEntries: ScheduleEntry[];
  equipment: import("../types").Equipment[];
  expandedId: string | null;
  sort: { col: SortCol; dir: "asc" | "desc" };
  onToggle: (id: string) => void;
  onEdit: (b: BrewBatch) => void;
  onArchive: (id: string, name: string) => void;
  onDelete: (id: string, name: string) => void;
  isAdmin: boolean;
  onSort: (col: SortCol) => void;
  tankTypeById: Record<string, string>;
  assignedBatchIds: Set<string>;
  recipes: import("../types").Recipe[];
}) {
  if (!batches.length) return null;

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-sm min-w-[700px]">
        <thead>
          <tr className="border-b border-zinc-800 text-left bg-zinc-900/50">
            <th className="px-3 py-2.5 text-xs font-medium text-zinc-500 w-6"></th>
            <SortTh col="batch_number"          label="Batch #"           sort={sort} onSort={onSort} />
            <SortTh col="beer_name"             label="Beer"              sort={sort} onSort={onSort} />
            <SortTh col="planned_brew_date"     label="Planned Brew Date" sort={sort} onSort={onSort} />
            <SortTh col="expected_delivery_date" label="Expected Delivery" sort={sort} onSort={onSort} />
            <SortTh col="volume_bbl"            label="Volume"            sort={sort} onSort={onSort} className="text-right" />
            <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Available</th>
            <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Turns</th>
            <SortTh col="status"                label="Status"            sort={sort} onSort={onSort} />
            <th className="px-4 py-2.5 text-xs font-medium text-zinc-500"></th>
          </tr>
        </thead>
        <tbody>
          {batches.map((b, i) => {
            const isExpanded    = expandedId === b.id;
            const batchTransfers = transfers.filter((t) => t.batch_id === b.id);
            const batchSchedule = scheduleEntries.filter((e) => e.batch_id === b.id && !e.cancelled_at);
            const schedStages = new Set(batchSchedule.map(e => e.stage === "fermenter" ? "fermenting" : e.stage));
            const isConversion = !!b.converted_from_batch_id;
            const scheduleMissing = (!isConversion && !schedStages.has("brewhouse")) || !schedStages.has("fermenting") || !schedStages.has("conditioning");

            // Delivery: use stored field if set, else calculate from recipe
            const deliveryDate = b.expected_delivery_date
              ?? (b.recipes?.brew_time_weeks
                  ? calcDelivery(b.planned_brew_date, b.recipes.brew_time_weeks)
                  : null);

            return (
              <React.Fragment key={b.id}>
                <tr className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""} ${isExpanded ? "border-b-0" : ""}`}>
                  <td className="px-3 py-2.5">
                    <button
                      onClick={() => onToggle(b.id)}
                      className="text-zinc-600 hover:text-zinc-400 transition-colors text-xs"
                      title="Show details"
                    >
                      {isExpanded ? "▼" : "▶"}
                    </button>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">
                    <span className="flex items-center gap-1.5">
                      {b.batch_number ?? "—"}
                      {scheduleMissing && b.status !== "archived" && (
                        <span className="text-amber-500/80" title="Schedule incomplete — missing required stages">⚠</span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-zinc-100 font-medium">
                    {b.beer_name}
                    {b.recipes?.brewery && (
                      <span className="ml-1.5 text-xs text-zinc-500">{b.recipes.brewery}</span>
                    )}
                    {b.converted_from_batch && (
                      <span className="ml-1.5 px-1.5 py-px rounded border border-amber-700/50 bg-amber-950/40 text-amber-400 text-[10px] font-normal whitespace-nowrap">
                        converted from {b.converted_from_batch.beer_name}
                      </span>
                    )}
                    <ShortfallBadge batchId={b.id} status={b.status} />
                  </td>
                  <td className="px-4 py-2.5 text-zinc-400">{fmtDate(b.planned_brew_date)}</td>
                  <td className="px-4 py-2.5 text-zinc-400">
                    {deliveryDate ? fmtDate(deliveryDate) : <span className="text-zinc-700">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-300 text-right tabular-nums">{Number(b.volume_bbl).toFixed(2)} BBL</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {(() => {
                      const bd = computeLocationBreakdown(b.id, Number(b.volume_bbl), transfers, tankTypeById, assignedBatchIds.has(b.id));
                      const avail = bd.backlog + bd.brewhouse + bd.fermenter + bd.brite + bd.packaging + bd.coldStorage;
                      return <span className={avail > 0 ? "text-green-400" : "text-zinc-700"}>{avail.toFixed(2)} BBL</span>;
                    })()}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-400 text-right">{b.turns}</td>
                  <td className="px-4 py-2.5"><StatusBadge status={b.status} /></td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-3 justify-end">
                      <button onClick={() => onEdit(b)} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Edit</button>
                      {b.status !== "archived" && (
                        <button onClick={() => onArchive(b.id, b.beer_name)} className="text-xs text-zinc-500 hover:text-amber-400 transition-colors">Archive</button>
                      )}
                      {isAdmin && (
                        <button onClick={() => onDelete(b.id, b.beer_name)} className="text-xs text-zinc-600 hover:text-red-400 transition-colors">Delete</button>
                      )}
                    </div>
                  </td>
                </tr>

                {isExpanded && (
                  <tr className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                    <td colSpan={10} className="px-6 pb-6 pt-3">
                      {/* Brew stats row */}
                      {(b.ibu != null || b.color_srm != null || b.original_gravity != null || b.final_gravity != null || b.dissolved_oxygen_ppb != null) && (
                        <div className="flex gap-6 pb-4 mb-4 border-b border-zinc-800/60">
                          {b.ibu != null && <div><p className="text-xs text-zinc-600 mb-0.5">IBU</p><p className="text-sm text-zinc-300 tabular-nums">{b.ibu}</p></div>}
                          {b.color_srm != null && <div><p className="text-xs text-zinc-600 mb-0.5">Color (SRM)</p><p className="text-sm text-zinc-300 tabular-nums">{b.color_srm}</p></div>}
                          {b.original_gravity != null && <div><p className="text-xs text-zinc-600 mb-0.5">OG</p><p className="text-sm text-zinc-300 tabular-nums">{b.original_gravity}</p></div>}
                          {b.final_gravity != null && <div><p className="text-xs text-zinc-600 mb-0.5">FG</p><p className="text-sm text-zinc-300 tabular-nums">{b.final_gravity}</p></div>}
                          {b.dissolved_oxygen_ppb != null && <div><p className="text-xs text-zinc-600 mb-0.5">DO (ppb)</p><p className="text-sm text-zinc-300 tabular-nums">{b.dissolved_oxygen_ppb}</p></div>}
                        </div>
                      )}

                      {/* 1 — Allocations */}
                      <div className="mb-5">
                        <AllocationManager batch={b} />
                      </div>

                      {/* 2 — Equipment Schedule */}
                      <div className="mb-5 pt-4 border-t border-zinc-800/60">
                        <EquipmentScheduleSection
                          batchId={b.id}
                          entries={scheduleEntries.filter((e) => e.batch_id === b.id)}
                          equipment={equipment}
                          batch={b}
                          recipes={recipes}
                        />
                      </div>

                      {/* 3 — Volume Breakdown */}
                      <div className="mb-5 pt-4 border-t border-zinc-800/60">
                        <BatchVolumeBreakdown
                          batch={b}
                          transfers={batchTransfers}
                          tankTypeById={tankTypeById}
                          isAssigned={assignedBatchIds.has(b.id)}
                        />
                      </div>

                      {/* 4 — Transfer Log */}
                      <div className="pt-4 border-t border-zinc-800/60">
                        <TransferLog transfers={batchTransfers} batchVol={Number(b.volume_bbl)} />
                      </div>

                      {/* 5 — Admin: Reassign Tank */}
                      {isAdmin && (
                        <div className="pt-4 border-t border-zinc-800/60">
                          <ReassignTankSection batchId={b.id} equipment={equipment} />
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Brew Activity Log (read view) ───────────────────────────────────────────

function BrewActivityLogDisplay({ entries }: { entries: BrewActivityEntry[] }) {
  if (!entries.length) return null;
  const sorted = [...entries].sort((a, b) => a.sort_order - b.sort_order);
  return (
    <div>
      <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">Brew Activity Log</p>
      <div className="overflow-x-auto rounded border border-zinc-800/60">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/40 text-left">
              <th className="px-3 py-2 font-medium text-zinc-500 w-8">#</th>
              <th className="px-3 py-2 font-medium text-zinc-500">Activity</th>
              <th className="px-3 py-2 font-medium text-zinc-500">Time</th>
              <th className="px-3 py-2 font-medium text-zinc-500 text-right">Temp (°F)</th>
              <th className="px-3 py-2 font-medium text-zinc-500 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((e, i) => (
              <tr key={e.id} className={`border-b border-zinc-800/40 ${i % 2 !== 0 ? "bg-zinc-900/20" : ""}`}>
                <td className="px-3 py-2 text-zinc-600 tabular-nums">{i + 1}</td>
                <td className="px-3 py-2 text-zinc-300">{e.activity}</td>
                <td className="px-3 py-2 text-zinc-500">{e.time_label ?? "—"}</td>
                <td className="px-3 py-2 text-zinc-500 text-right tabular-nums">{e.temp != null ? `${e.temp}` : "—"}</td>
                <td className="px-3 py-2 text-zinc-500 text-right tabular-nums">{e.amount != null ? Number(e.amount).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Brew Activity Log Manager (edit view) ────────────────────────────────────

interface ActivityEditRow {
  id: string;
  sort_order: number;
  activity: string;
  time_label: string;
  temp: string;
  amount: string;
  dirty?: boolean;
}

function BrewActivityLogManager({ batch }: { batch: BrewBatch }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: productionKeys.batches });
  const existing = [...(batch.batch_brew_activity_log ?? [])].sort((a, b) => a.sort_order - b.sort_order);

  const [rows, setRows] = useState<ActivityEditRow[]>(() =>
    existing.map((e) => ({
      id: e.id!,
      sort_order: e.sort_order,
      activity: e.activity,
      time_label: e.time_label ?? "",
      temp: e.temp != null ? String(e.temp) : "",
      amount: e.amount != null ? String(e.amount) : "",
    }))
  );
  const [newRow, setNewRow] = useState({ activity: "", time_label: "", temp: "", amount: "" });
  const [saving, setSaving] = useState(false);

  function markDirty(i: number, field: keyof ActivityEditRow, value: string) {
    setRows((rs) => rs.map((r, idx) => idx === i ? { ...r, [field]: value, dirty: true } : r));
  }

  async function saveAll() {
    setSaving(true);
    try {
      const dirty = rows.filter((r) => r.dirty);
      await Promise.all(dirty.map((r) =>
        fetch("/api/production/brew-activity-log", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: r.id,
            activity: r.activity,
            time_label: r.time_label || null,
            temp: r.temp !== "" ? parseFloat(r.temp) : null,
            amount: r.amount !== "" ? parseFloat(r.amount) : null,
            sort_order: r.sort_order,
          }),
        })
      ));
      setRows((rs) => rs.map((r) => ({ ...r, dirty: false })));
      await refresh();
    } catch {
      alert("Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function deleteRow(id: string) {
    if (!confirm("Remove this activity entry?")) return;
    await fetch(`/api/production/brew-activity-log?id=${id}`, { method: "DELETE" });
    setRows((rs) => rs.filter((r) => r.id !== id));
    await refresh();
  }

  async function addRow() {
    if (!newRow.activity.trim()) return;
    setSaving(true);
    try {
      const maxOrder = rows.reduce((m, r) => Math.max(m, r.sort_order), -1);
      const res = await fetch("/api/production/brew-activity-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batch_id: batch.id,
          sort_order: maxOrder + 1,
          activity: newRow.activity,
          time_label: newRow.time_label || null,
          temp: newRow.temp !== "" ? parseFloat(newRow.temp) : null,
          amount: newRow.amount !== "" ? parseFloat(newRow.amount) : null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      const created = await res.json();
      setRows((rs) => [...rs, { id: created.id, sort_order: created.sort_order, activity: created.activity, time_label: created.time_label ?? "", temp: created.temp != null ? String(created.temp) : "", amount: created.amount != null ? String(created.amount) : "" }]);
      setNewRow({ activity: "", time_label: "", temp: "", amount: "" });
      await refresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  const hasDirty = rows.some((r) => r.dirty);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Brew Activity Log</p>
        {hasDirty && (
          <button type="button" onClick={saveAll} disabled={saving}
            className="text-xs text-amber-500 hover:text-amber-400 disabled:opacity-50 transition-colors">
            {saving ? "Saving…" : "Save changes"}
          </button>
        )}
      </div>

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded border border-zinc-800/60 mb-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/40 text-left">
                <th className="px-3 py-2 font-medium text-zinc-500">#</th>
                <th className="px-3 py-2 font-medium text-zinc-500">Activity</th>
                <th className="px-3 py-2 font-medium text-zinc-500">Time</th>
                <th className="px-3 py-2 font-medium text-zinc-500 text-right">Temp (°F)</th>
                <th className="px-3 py-2 font-medium text-zinc-500 text-right">Amount</th>
                <th className="px-3 py-2 w-6"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} className={`border-b border-zinc-800/40 ${i % 2 !== 0 ? "bg-zinc-900/20" : ""} ${r.dirty ? "bg-amber-950/10" : ""}`}>
                  <td className="px-3 py-1.5 text-zinc-600 tabular-nums">{i + 1}</td>
                  <td className="px-3 py-1.5">
                    <input className="inp text-xs" value={r.activity}
                      onChange={(e) => markDirty(i, "activity", e.target.value)} />
                  </td>
                  <td className="px-3 py-1.5">
                    <input className="inp text-xs" placeholder="e.g. 0:00" value={r.time_label}
                      onChange={(e) => markDirty(i, "time_label", e.target.value)} />
                  </td>
                  <td className="px-3 py-1.5">
                    <input type="number" step="0.1" className="inp text-xs text-right" value={r.temp}
                      onChange={(e) => markDirty(i, "temp", e.target.value)} />
                  </td>
                  <td className="px-3 py-1.5">
                    <input type="number" step="0.01" className="inp text-xs text-right" value={r.amount}
                      onChange={(e) => markDirty(i, "amount", e.target.value)} />
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <button type="button" onClick={() => deleteRow(r.id)}
                      className="text-zinc-600 hover:text-red-400 transition-colors">×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add new row */}
      <div className="flex gap-2 items-end flex-wrap">
        <div className="flex-1 min-w-[140px]">
          <label className="block text-xs text-zinc-500 mb-1">Activity</label>
          <input className="inp text-xs" placeholder="e.g. Mash in" value={newRow.activity}
            onChange={(e) => setNewRow((r) => ({ ...r, activity: e.target.value }))} />
        </div>
        <div className="w-24">
          <label className="block text-xs text-zinc-500 mb-1">Time</label>
          <input className="inp text-xs" placeholder="e.g. 0:00" value={newRow.time_label}
            onChange={(e) => setNewRow((r) => ({ ...r, time_label: e.target.value }))} />
        </div>
        <div className="w-24">
          <label className="block text-xs text-zinc-500 mb-1">Temp (°F)</label>
          <input type="number" step="0.1" className="inp text-xs text-right" placeholder="152" value={newRow.temp}
            onChange={(e) => setNewRow((r) => ({ ...r, temp: e.target.value }))} />
        </div>
        <div className="w-24">
          <label className="block text-xs text-zinc-500 mb-1">Amount</label>
          <input type="number" step="0.01" className="inp text-xs text-right" placeholder="0" value={newRow.amount}
            onChange={(e) => setNewRow((r) => ({ ...r, amount: e.target.value }))} />
        </div>
        <button type="button" onClick={addRow} disabled={saving || !newRow.activity.trim()}
          className="px-3 py-1.5 text-xs bg-zinc-800 border border-zinc-700 hover:border-zinc-500 text-zinc-300 rounded transition-colors disabled:opacity-50 shrink-0">
          {saving ? "…" : "+ Add"}
        </button>
      </div>
    </div>
  );
}

// ─── Per-batch volume breakdown ─────────────────────────────────────────────
function BatchVolumeBreakdown({
  batch,
  transfers,
  tankTypeById,
  isAssigned,
}: {
  batch: BrewBatch;
  transfers: BatchTransfer[];
  tankTypeById: Record<string, string>;
  isAssigned: boolean;
}) {
  const originalVol = Number(batch.volume_bbl ?? 0);
  const bd = computeLocationBreakdown(batch.id, originalVol, transfers, tankTypeById, isAssigned);

  const available    = bd.backlog + bd.brewhouse + bd.fermenter + bd.brite + bd.packaging + bd.coldStorage;
  const availablePct = originalVol > 0 ? (available / originalVol) * 100 : 0;
  const exportedPct  = originalVol > 0 ? (bd.exported / originalVol) * 100 : 0;
  const shrinkagePct = originalVol > 0 ? (bd.shrinkage / originalVol) * 100 : 0;

  // Only show location stages with nonzero volume
  const locationCols: { label: string; value: number }[] = [
    { label: "Backlog",      value: bd.backlog },
    { label: "Brewing",      value: bd.brewhouse },
    { label: "Fermenter",    value: bd.fermenter },
    { label: "Brite",        value: bd.brite },
    { label: "Packaging",    value: bd.packaging },
    { label: "Cold Storage", value: bd.coldStorage },
  ].filter((c) => c.value > 0.001);

  const accountedFor = [bd.backlog, bd.brewhouse, bd.fermenter, bd.brite, bd.packaging, bd.coldStorage, bd.exported, bd.converted, bd.shrinkage].reduce((s, v) => s + v, 0);
  const balanced     = Math.abs(accountedFor - originalVol) < 0.01;

  return (
    <div className="mt-3">
      <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">Volume Breakdown</p>

      {/* Bar + headline */}
      <div className="mb-3">
        <div className="flex items-baseline gap-2 mb-1.5">
          <span className="text-sm font-semibold text-green-400 tabular-nums">{fmtBbl2(available)}</span>
          <span className="text-xs text-zinc-500">
            available of {fmtBbl2(originalVol)} total{!balanced && <span className="text-red-400 ml-1">⚠ unbalanced</span>}
          </span>
          {bd.converted > 0 && <span className="text-xs text-violet-400/80 ml-auto">{fmtBbl2(bd.converted)} converted</span>}
          {bd.exported > 0 && <span className="text-xs text-zinc-500">{fmtBbl2(bd.exported)} exported</span>}
          {bd.shrinkage > 0 && <span className="text-xs text-amber-500/80">{fmtBbl2(bd.shrinkage)} shrinkage</span>}
        </div>
        <div className="h-2 rounded-full bg-zinc-800 overflow-hidden flex">
          <div className="h-full bg-green-600/70" style={{ width: `${availablePct}%` }} />
          <div className="h-full bg-blue-600/50" style={{ width: `${exportedPct}%` }} />
          <div className="h-full bg-amber-600/50" style={{ width: `${shrinkagePct}%` }} />
        </div>
      </div>

      {/* Active location breakdown — only nonzero stages */}
      {locationCols.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {locationCols.map(({ label, value }) => (
            <div key={label} className="flex items-center gap-1.5 text-xs">
              <span className="text-zinc-600">{label}</span>
              <span className="text-zinc-300 tabular-nums font-medium">{fmtBbl2(value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ShortfallBadge({ batchId, status }: { batchId: string; status: string }) {
  const enabled = status === "planning" || status === "backlog";
  const { data: shortfalls } = useIngredientShortfallsQuery(batchId, enabled);
  if (!shortfalls?.length) return null;
  return (
    <span
      title={shortfalls.map((s) => `${s.name}: need ${s.this_batch_committed.toFixed(2)} ${s.unit}, short by ${s.shortfall.toFixed(2)}`).join("\n")}
      className="ml-1.5 px-1.5 py-px rounded border border-red-700/50 bg-red-950/40 text-red-400 text-[10px] font-normal whitespace-nowrap cursor-help"
    >
      ⚠ {shortfalls.length} ingredient{shortfalls.length > 1 ? "s" : ""} short
    </span>
  );
}

function ReassignTankSection({ batchId, equipment }: { batchId: string; equipment: import("../types").Equipment[] }) {
  const queryClient = useQueryClient();
  const [tankId, setTankId]   = useState("");
  const [reason, setReason]   = useState("");
  const [saving, setSaving]   = useState(false);
  const [done, setDone]       = useState(false);

  const tanks = equipment.filter((e) =>
    ["brewhouse", "fermenter", "brite"].includes(e.type)
  );

  async function handleReassign(e: React.FormEvent) {
    e.preventDefault();
    if (!tankId) return;
    if (!confirm("Reassign this batch to the selected tank? This closes the current assignment without creating a transfer record.")) return;
    setSaving(true);
    try {
      const res = await fetch("/api/production/tank-assignments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_id: batchId, correct_tank_id: tankId, reason: reason || undefined }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await queryClient.invalidateQueries({ queryKey: productionKeys.assignments });
      await queryClient.invalidateQueries({ queryKey: productionKeys.batches });
      setDone(true);
      setTankId(""); setReason("");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">
        Admin — Reassign Tank
      </p>
      {done && (
        <p className="text-xs text-green-400 mb-2">Tank reassigned successfully.</p>
      )}
      <form onSubmit={handleReassign} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-500">Correct Tank</label>
          <select className="inp text-sm" value={tankId} required onChange={(e) => { setTankId(e.target.value); setDone(false); }}>
            <option value="">— select tank —</option>
            {tanks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}{t.capacity_bbl ? ` · ${t.capacity_bbl} BBL` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 flex-1 min-w-[160px]">
          <label className="text-xs text-zinc-500">Reason (optional)</label>
          <input className="inp text-sm" placeholder="e.g. entered wrong tank" value={reason} onChange={(e) => { setReason(e.target.value); setDone(false); }} />
        </div>
        <button type="submit" disabled={saving || !tankId}
          className="px-3 py-1.5 text-sm rounded border border-red-800 bg-red-950/40 text-red-300 hover:bg-red-900/40 disabled:opacity-40 transition-colors">
          {saving ? "Saving…" : "Reassign"}
        </button>
      </form>
      <p className="text-xs text-zinc-600 mt-1.5">
        Closes the current tank assignment and opens a new one. No transfer record is created.
      </p>
    </div>
  );
}

function TransferLog({ transfers, batchVol }: { transfers: BatchTransfer[]; batchVol: number }) {
  const [expanded, setExpanded] = useState(false);

  const sorted = [...transfers].sort(
    (a, b) => new Date(a.transferred_at).getTime() - new Date(b.transferred_at).getTime()
  );

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-2 text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2 hover:text-zinc-200 transition-colors"
      >
        <span>{expanded ? "▾" : "▸"}</span>
        <span>Transfer Log</span>
        <span className="text-zinc-600 font-normal normal-case tracking-normal">({transfers.length})</span>
      </button>
      {expanded && (
        transfers.length === 0 ? (
          <p className="text-xs text-zinc-600">No transfers recorded yet.</p>
        ) : (
          <div className="overflow-x-auto rounded border border-zinc-800/60">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/40 text-left">
                  {["Date", "From", "To", "Type", "Draw", "Shrinkage", "By", "Notes"].map(h => (
                    <th key={h} className="px-3 py-2 font-medium text-zinc-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((t, i) => {
                  const fromEq = t.from_tank ? EQ[t.from_tank.type as keyof typeof EQ] : null;
                  const toEq   = t.to_tank   ? EQ[t.to_tank.type   as keyof typeof EQ] : null;
                  const byEmail = t.created_by_profile?.email;
                  const byLabel = byEmail ? byEmail.split("@")[0] : "—";
                  return (
                    <tr key={t.id} className={`border-b border-zinc-800/40 ${i % 2 !== 0 ? "bg-zinc-900/20" : ""}`}>
                      <td className="px-3 py-2 text-zinc-500 whitespace-nowrap">{fmtDateTime(t.transferred_at)}</td>
                      <td className="px-3 py-2 text-zinc-300">
                        {t.from_tank
                          ? <><span className="text-zinc-100">{t.from_tank.name}</span> <span className={`px-1 py-px rounded border text-zinc-500 ${fromEq?.badge ?? ""}`} style={{ fontSize: 9 }}>{fromEq?.label ?? t.from_tank.type}</span></>
                          : <span className="text-zinc-600">—</span>}
                      </td>
                      <td className="px-3 py-2 text-zinc-300">
                        {t.transfer_type === "conversion" && t.to_batch
                          ? <span className="text-amber-300">{t.to_batch.beer_name}{t.to_batch.batch_number ? <span className="text-zinc-500 font-mono ml-1">#{t.to_batch.batch_number}</span> : null}</span>
                          : t.to_tank
                            ? <><span className="text-zinc-100">{t.to_tank.name}</span> <span className={`px-1 py-px rounded border text-zinc-500 ${toEq?.badge ?? ""}`} style={{ fontSize: 9 }}>{toEq?.label ?? t.to_tank.type}</span></>
                            : t.transfer_type === "export"
                              ? <span className="text-zinc-400">Export Bay</span>
                              : <span className="text-zinc-600">—</span>}
                      </td>
                      <td className="px-3 py-2 text-zinc-400 capitalize">
                        {t.transfer_type === "conversion"
                          ? <span className="text-amber-400">Conversion</span>
                          : t.transfer_type === "export" ? "Export" : t.transfer_type}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-zinc-300">{fmtBbl2(Number(t.volume_bbl))}</td>
                      <td className="px-3 py-2 tabular-nums text-zinc-500">
                        {Number(t.shrinkage_bbl) > 0 ? fmtBbl2(Number(t.shrinkage_bbl)) : "—"}
                      </td>
                      <td className="px-3 py-2 text-zinc-500 max-w-[100px] truncate" title={byEmail ?? undefined}>{byLabel}</td>
                      <td className="px-3 py-2 text-zinc-500 max-w-[160px] truncate">{t.notes ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
