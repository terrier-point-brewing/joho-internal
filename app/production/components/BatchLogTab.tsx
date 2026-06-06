"use client";

import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BrewBatch, BatchTransfer, BrewActivityEntry, BatchAllocation, AllocationChannel, AllocationLockReason } from "../types";
import { BREWHOUSE_BBL, StatusBadge, Modal, Field, ModalActions } from "./shared";
import { fmtDateLong, fmtBbl2 } from "@/lib/utils/formatting";
import { EQ } from "../equipmentMeta";
import { computeLocationBreakdown } from "../lib/volumeLedger";
import { fetchJson } from "../hooks/queries";
import {
  useBatchesQuery, useRecipesQuery, useTransfersQuery, useContractPartnersQuery,
  useAssignmentsQuery, useEquipmentQuery, productionKeys,
} from "../hooks/queries";

const fmtDate = fmtDateLong;

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Compute expected delivery ISO date string from brew date + weeks */
function calcDelivery(brewDate: string, weeks: number | null | undefined): string {
  if (!brewDate || !weeks) return "";
  return new Date(new Date(brewDate).getTime() + weeks * 7 * 86400000).toISOString().slice(0, 10);
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
  const qc = useQueryClient();
  const { data: batches = [] } = useBatchesQuery();
  const { data: recipes = [] } = useRecipesQuery();
  const { data: transfers = [] } = useTransfersQuery();
  const { data: assignments = [] } = useAssignmentsQuery();
  const { data: tanks = [] } = useEquipmentQuery();
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
  const computedVolume =
    selectedRecipe?.expected_yield_bbl != null
      ? (selectedRecipe.expected_yield_bbl * (parseInt(form.turns) || 1)).toFixed(2)
      : null;

  function handleRecipeChange(recipeId: string) {
    const r = recipes.find((r) => r.id === recipeId);
    const newTurns = "1";
    const delivery = calcDelivery(form.planned_brew_date, r?.brew_time_weeks);
    setForm((f) => ({
      ...f,
      recipe_id: recipeId,
      beer_name: r?.beer_name ?? f.beer_name,
      turns: newTurns,
      expected_delivery_date: delivery,
    }));
  }

  function handleBrewDateChange(date: string) {
    const delivery = calcDelivery(date, selectedRecipe?.brew_time_weeks);
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
    const recipe = recipes.find((r) => r.id === form.recipe_id);
    const turns = parseInt(form.turns) || 1;
    const volume_bbl = recipe?.expected_yield_bbl != null
      ? recipe.expected_yield_bbl * turns
      : null;
    if (!volume_bbl) { alert("Selected recipe has no expected yield configured."); return; }

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

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete batch "${name}"? This cannot be undone.`)) return;
    await fetch(`/api/production/batches/${id}`, { method: "DELETE" });
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
          expandedId={expandedId}
          sort={sort}
          onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
          onEdit={openEdit}
          onDelete={handleDelete}
          onSort={toggleSort}
          tankTypeById={tankTypeById}
          assignedBatchIds={assignedBatchIds}
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
            <div className="grid grid-cols-2 gap-3">
              <Field label="Planned Brew Date" required>
                <input type="date" className="inp" value={form.planned_brew_date} required
                  onChange={(e) => handleBrewDateChange(e.target.value)} />
              </Field>
              <Field label="Expected Delivery Date">
                <input type="date" className="inp" value={form.expected_delivery_date}
                  onChange={(e) => setForm((f) => ({ ...f, expected_delivery_date: e.target.value }))} />
              </Field>
            </div>
            <Field label={`Turns (${BREWHOUSE_BBL} BBL brewhouse)`} required>
              <input type="number" min="1" step="1" className="inp" value={form.turns} required
                onChange={(e) => setForm((f) => ({ ...f, turns: e.target.value }))} />
              {computedVolume && (
                <p className="text-xs text-zinc-500 mt-1">
                  Computed volume: <span className="text-zinc-300 font-medium">{computedVolume} BBL</span>
                  {selectedRecipe?.expected_yield_bbl && (
                    <span className="text-zinc-600 ml-1">({selectedRecipe.expected_yield_bbl} BBL/turn × {parseInt(form.turns) || 1})</span>
                  )}
                </p>
              )}
              {!computedVolume && form.recipe_id && (
                <p className="text-xs text-amber-600 mt-1">Recipe has no expected yield — set it in the Recipes tab first.</p>
              )}
            </Field>
            <Field label="Notes">
              <textarea className="inp resize-none" rows={2} value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            </Field>

            {/* Brew Stats — edit only */}
            {editingBatch && (
              <div>
                <p className="text-xs text-zinc-400 mb-2">Brew Stats</p>
                <div className="grid grid-cols-5 gap-3">
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
  { value: "taproom", label: "Taproom" },
  { value: "distribution", label: "Distribution" },
  { value: "contract_brewing", label: "Contract Brewing" },
  { value: "safety_stock", label: "Safety Stock" },
];

const LOCK_REASON_OPTIONS: { value: AllocationLockReason; label: string }[] = [
  { value: "deposit_paid", label: "Deposit Paid" },
  { value: "contract_signed", label: "Contract Signed" },
];

function AllocationManager({ batch }: { batch: BrewBatch }) {
  const qc = useQueryClient();
  const { data: partners = [] } = useContractPartnersQuery();

  const allocKey = ["production", "allocations", batch.id] as const;
  const { data: allocations = [] } = useQuery({
    queryKey: allocKey,
    queryFn: () => fetchJson<BatchAllocation[]>(`/api/production/allocations?batch_id=${batch.id}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: allocKey });

  const [channel, setChannel] = useState<AllocationChannel>("taproom");
  const [partnerId, setPartnerId] = useState("");
  const [pct, setPct] = useState("");
  const [label, setLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const totalPct = allocations.reduce((s, a) => s + Number(a.percentage), 0);
  const remaining = 100 - totalPct;

  // Auto-build label when channel/partner changes
  function buildDefaultLabel(ch: AllocationChannel, pid: string) {
    if (ch === "contract_brewing") {
      const p = partners.find((x) => x.id === pid);
      return p ? `Contract Brewing — ${p.company_name}` : "Contract Brewing";
    }
    return CHANNEL_OPTIONS.find((o) => o.value === ch)?.label ?? ch;
  }

  function handleChannelChange(ch: AllocationChannel) {
    setChannel(ch);
    setLabel(buildDefaultLabel(ch, partnerId));
  }

  function handlePartnerChange(pid: string) {
    setPartnerId(pid);
    setLabel(buildDefaultLabel(channel, pid));
  }

  async function handleAdd() {
    if (!pct) return;
    const partner = channel === "contract_brewing" ? (partners.find((p) => p.id === partnerId) ?? partners[0]) : null;
    const effectiveLabel = label.trim() || buildDefaultLabel(channel, partner?.id ?? "");
    setSaving(true);
    try {
      const res = await fetch("/api/production/allocations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batch_id: batch.id,
          channel,
          label: effectiveLabel,
          percentage: parseFloat(pct),
          partner_id: partner?.id ?? null,
          notes: notes || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setPct(""); setNotes(""); setLabel("");
      await refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally {
      setSaving(false);
    }
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
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locked: true, lock_reason: reason }),
    });
    if (!res.ok) alert((await res.json()).error ?? "Error");
    await refresh();
  }

  async function handleUnlock(id: string) {
    if (!confirm("Unlock this allocation? The percentage can be reduced again.")) return;
    const res = await fetch(`/api/production/allocations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locked: false }),
    });
    if (!res.ok) alert((await res.json()).error ?? "Error");
    await refresh();
  }

  return (
    <div>
      <p className="text-xs text-zinc-500 mb-3 font-medium uppercase tracking-wide">Allocations</p>

      {allocations.length > 0 && (
        <>
          {/* Percentage fill bar */}
          <div className="w-full rounded-full overflow-hidden mb-2" style={{ height: 4, background: "rgba(63,63,70,0.5)" }}>
            <div
              style={{
                height: "100%",
                width: `${Math.min(100, totalPct).toFixed(1)}%`,
                background: totalPct > 100 ? "rgb(239,68,68)" : "rgb(245,158,11)",
                borderRadius: "9999px",
                transition: "width 0.3s",
              }}
            />
          </div>

          <div className="overflow-x-auto rounded border border-zinc-800/60 mb-3">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/40 text-left">
                  <th className="px-3 py-2 font-medium text-zinc-500">Label</th>
                  <th className="px-3 py-2 font-medium text-zinc-500">Channel</th>
                  <th className="px-3 py-2 font-medium text-zinc-500 text-right">%</th>
                  <th className="px-3 py-2 font-medium text-zinc-500">Lock</th>
                  <th className="px-3 py-2 font-medium text-zinc-500">Status</th>
                  <th className="px-3 py-2 w-6"></th>
                </tr>
              </thead>
              <tbody>
                {allocations.map((a, i) => (
                  <tr key={a.id} className={`border-b border-zinc-800/40 ${i % 2 !== 0 ? "bg-zinc-900/20" : ""}`}>
                    <td className="px-3 py-2 text-zinc-200 font-medium max-w-[160px] truncate">{a.label}</td>
                    <td className="px-3 py-2 text-zinc-400">
                      {CHANNEL_OPTIONS.find((o) => o.value === a.channel)?.label ?? a.channel}
                    </td>
                    <td className="px-3 py-2 text-zinc-300 text-right tabular-nums font-medium">
                      {Number(a.percentage).toFixed(1)}%
                    </td>
                    <td className="px-3 py-2">
                      {a.locked ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-blue-400">
                            {a.lock_reason === "deposit_paid" ? "Deposit" : "Contract"}
                          </span>
                          <button type="button" onClick={() => handleUnlock(a.id)}
                            className="text-zinc-600 hover:text-zinc-400 text-[10px]">unlock</button>
                        </div>
                      ) : (
                        <select
                          className="text-[10px] bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-zinc-500 hover:border-zinc-500 cursor-pointer"
                          defaultValue=""
                          onChange={(e) => { if (e.target.value) handleLock(a.id, e.target.value as AllocationLockReason); e.target.value = ""; }}
                        >
                          <option value="">Lock…</option>
                          {LOCK_REASON_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {a.allocated_bbl == null ? (
                        <span className="text-zinc-600">Pending</span>
                      ) : a.fulfilled ? (
                        <span className="text-emerald-400">Fulfilled</span>
                      ) : (
                        <span className="text-amber-400">
                          {a.exported_bbl > 0 && a.allocated_bbl > 0
                            ? `${((a.exported_bbl / a.allocated_bbl) * 100).toFixed(0)}%`
                            : "Unfulfilled"}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => handleDelete(a.id, a.locked)}
                        className="text-zinc-600 hover:text-red-400 transition-colors">×</button>
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-zinc-700 bg-zinc-900/30">
                  <td colSpan={2} className="px-3 py-1.5 text-zinc-500 font-medium">Total</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${totalPct > 100 ? "text-red-400" : "text-zinc-300"}`}>
                    {totalPct.toFixed(1)}%
                  </td>
                  <td colSpan={3} className="px-3 py-1.5 text-zinc-600 text-xs">
                    {remaining > 0 ? `${remaining.toFixed(1)}% unallocated` : remaining < 0 ? `${Math.abs(remaining).toFixed(1)}% over-allocated` : "Fully allocated"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Add allocation row */}
      <div className="flex gap-2 items-end flex-wrap">
        <div className="flex-1 min-w-[120px]">
          <label className="block text-xs text-zinc-500 mb-1">Channel</label>
          <select className="inp" value={channel} onChange={(e) => handleChannelChange(e.target.value as AllocationChannel)}>
            {CHANNEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        {channel === "contract_brewing" && (
          <div className="flex-1 min-w-[120px]">
            <label className="block text-xs text-zinc-500 mb-1">Partner</label>
            <select className="inp" value={partnerId} onChange={(e) => handlePartnerChange(e.target.value)}>
              <option value="">— select —</option>
              {partners.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
            </select>
          </div>
        )}
        <div className="flex-1 min-w-[120px]">
          <label className="block text-xs text-zinc-500 mb-1">Label</label>
          <input className="inp" value={label} placeholder={buildDefaultLabel(channel, partnerId)}
            onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className="w-20">
          <label className="block text-xs text-zinc-500 mb-1">%</label>
          <input type="number" step="0.1" min="0.1" max="100" className="inp" placeholder="0.0"
            value={pct} onChange={(e) => setPct(e.target.value)} />
        </div>
        <div className="flex-1 min-w-[80px]">
          <label className="block text-xs text-zinc-500 mb-1">Notes</label>
          <input className="inp" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <button type="button" onClick={handleAdd} disabled={saving || !pct}
          className="px-3 py-1.5 text-xs bg-zinc-800 border border-zinc-700 hover:border-zinc-500 text-zinc-300 rounded transition-colors disabled:opacity-50 shrink-0">
          {saving ? "…" : "+ Add"}
        </button>
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
  expandedId,
  sort,
  onToggle,
  onEdit,
  onDelete,
  onSort,
  tankTypeById,
  assignedBatchIds,
}: {
  batches: BrewBatch[];
  transfers: BatchTransfer[];
  expandedId: string | null;
  sort: { col: SortCol; dir: "asc" | "desc" };
  onToggle: (id: string) => void;
  onEdit: (b: BrewBatch) => void;
  onDelete: (id: string, name: string) => void;
  onSort: (col: SortCol) => void;
  tankTypeById: Record<string, string>;
  assignedBatchIds: Set<string>;
}) {
  if (!batches.length) return null;

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left bg-zinc-900/50">
            <th className="px-3 py-2.5 text-xs font-medium text-zinc-500 w-6"></th>
            <SortTh col="batch_number"          label="Batch #"           sort={sort} onSort={onSort} />
            <SortTh col="beer_name"             label="Beer"              sort={sort} onSort={onSort} />
            <SortTh col="planned_brew_date"     label="Planned Brew Date" sort={sort} onSort={onSort} />
            <SortTh col="expected_delivery_date" label="Expected Delivery" sort={sort} onSort={onSort} />
            <SortTh col="volume_bbl"            label="Volume"            sort={sort} onSort={onSort} className="text-right" />
            <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Turns</th>
            <SortTh col="status"                label="Status"            sort={sort} onSort={onSort} />
            <th className="px-4 py-2.5 text-xs font-medium text-zinc-500"></th>
          </tr>
        </thead>
        <tbody>
          {batches.map((b, i) => {
            const isExpanded    = expandedId === b.id;
            const batchTransfers = transfers.filter((t) => t.batch_id === b.id);

            // Delivery: use stored field if set, else calculate from recipe
            const deliveryDate = b.expected_delivery_date
              ?? (b.recipes?.brew_time_weeks
                  ? new Date(new Date(b.planned_brew_date).getTime() + b.recipes.brew_time_weeks * 7 * 86400000).toISOString().slice(0, 10)
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
                  <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">{b.batch_number ?? "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-100 font-medium">
                    {b.beer_name}
                    {b.recipes?.brewery && (
                      <span className="ml-1.5 text-xs text-zinc-500">{b.recipes.brewery}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-400">{fmtDate(b.planned_brew_date)}</td>
                  <td className="px-4 py-2.5 text-zinc-400">
                    {deliveryDate ? fmtDate(deliveryDate) : <span className="text-zinc-700">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-300 text-right tabular-nums">{Number(b.volume_bbl).toFixed(2)} BBL</td>
                  <td className="px-4 py-2.5 text-zinc-400 text-right">{b.turns}</td>
                  <td className="px-4 py-2.5"><StatusBadge status={b.status} /></td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-3 justify-end">
                      <button onClick={() => onEdit(b)} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Edit</button>
                      <button onClick={() => onDelete(b.id, b.beer_name)} className="text-xs text-zinc-600 hover:text-red-400 transition-colors">Delete</button>
                    </div>
                  </td>
                </tr>

                {isExpanded && (
                  <tr className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                    <td colSpan={9} className="px-6 pb-5 pt-2 space-y-4">
                      {/* Brew stats row */}
                      {(b.ibu != null || b.color_srm != null || b.original_gravity != null || b.final_gravity != null || b.dissolved_oxygen_ppb != null) && (
                        <div className="flex gap-6 py-2">
                          {b.ibu != null && <div><p className="text-xs text-zinc-600 mb-0.5">IBU</p><p className="text-sm text-zinc-300 tabular-nums">{b.ibu}</p></div>}
                          {b.color_srm != null && <div><p className="text-xs text-zinc-600 mb-0.5">Color (SRM)</p><p className="text-sm text-zinc-300 tabular-nums">{b.color_srm}</p></div>}
                          {b.original_gravity != null && <div><p className="text-xs text-zinc-600 mb-0.5">OG</p><p className="text-sm text-zinc-300 tabular-nums">{b.original_gravity}</p></div>}
                          {b.final_gravity != null && <div><p className="text-xs text-zinc-600 mb-0.5">FG</p><p className="text-sm text-zinc-300 tabular-nums">{b.final_gravity}</p></div>}
                          {b.dissolved_oxygen_ppb != null && <div><p className="text-xs text-zinc-600 mb-0.5">DO (ppb)</p><p className="text-sm text-zinc-300 tabular-nums">{b.dissolved_oxygen_ppb}</p></div>}
                        </div>
                      )}
                      <BrewActivityLogDisplay entries={b.batch_brew_activity_log ?? []} />
                      <BatchVolumeBreakdown
                        batch={b}
                        transfers={batchTransfers}
                        tankTypeById={tankTypeById}
                        isAssigned={assignedBatchIds.has(b.id)}
                      />
                      <TransferLog transfers={batchTransfers} batchVol={Number(b.volume_bbl)} />
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
      <p className="text-xs text-zinc-600 mb-2 font-medium uppercase tracking-wide">Brew Activity Log</p>
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
        <p className="text-xs text-zinc-500 font-medium uppercase tracking-wide">Brew Activity Log</p>
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

  const cols: { label: string; value: number; highlight?: string }[] = [
    { label: "Backlog",       value: bd.backlog },
    { label: "Brewhouse",     value: bd.brewhouse },
    { label: "Fermenter",     value: bd.fermenter },
    { label: "Brite",         value: bd.brite },
    { label: "Packaging",     value: bd.packaging },
    { label: "Cold Storage",  value: bd.coldStorage },
    { label: "Exported",      value: bd.exported },
    { label: "Shrinkage",     value: bd.shrinkage, highlight: "text-amber-400" },
  ];

  const accountedFor = cols.reduce((s, c) => s + c.value, 0);
  const balanced     = Math.abs(accountedFor - originalVol) < 0.01;

  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Volume Breakdown</p>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
        {cols.map(({ label, value, highlight }) => (
          <div key={label} className="flex flex-col gap-0">
            <span className="text-xs text-zinc-600">{label}</span>
            <span className={`text-sm tabular-nums font-medium ${highlight ?? (value > 0 ? "text-zinc-200" : "text-zinc-700")}`}>
              {fmtBbl2(value)}
            </span>
          </div>
        ))}
        <div className="flex flex-col gap-0">
          <span className="text-xs text-zinc-600">Total</span>
          <span className={`text-sm tabular-nums font-medium ${balanced ? "text-zinc-500" : "text-red-400"}`}>
            {fmtBbl2(originalVol)}{!balanced && " ⚠"}
          </span>
        </div>
      </div>
    </div>
  );
}

function TransferLog({ transfers, batchVol }: { transfers: BatchTransfer[]; batchVol: number }) {
  if (!transfers.length) {
    return <p className="text-xs text-zinc-600">No transfers recorded yet.</p>;
  }

  const sorted = [...transfers].sort(
    (a, b) => new Date(a.transferred_at).getTime() - new Date(b.transferred_at).getTime()
  );

  return (
    <div>
      <p className="text-xs text-zinc-600 mb-2 font-medium uppercase tracking-wide">Transfer Log</p>
      <div className="overflow-x-auto rounded border border-zinc-800/60">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/40 text-left">
              {["Date", "From", "To", "Type", "Draw", "Shrinkage", "Notes"].map((h) => (
                <th key={h} className="px-3 py-2 font-medium text-zinc-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((t, i) => {
              const fromEq = t.from_tank ? EQ[t.from_tank.type as keyof typeof EQ] : null;
              const toEq   = t.to_tank   ? EQ[t.to_tank.type   as keyof typeof EQ] : null;
              return (
                <tr key={t.id} className={`border-b border-zinc-800/40 ${i % 2 !== 0 ? "bg-zinc-900/20" : ""}`}>
                  <td className="px-3 py-2 text-zinc-500 whitespace-nowrap">{fmtDateTime(t.transferred_at)}</td>
                  <td className="px-3 py-2 text-zinc-300">
                    {t.from_tank
                      ? <><span className="text-zinc-100">{t.from_tank.name}</span> <span className={`px-1 py-px rounded border text-zinc-500 ${fromEq?.badge ?? ""}`} style={{ fontSize: 9 }}>{fromEq?.label ?? t.from_tank.type}</span></>
                      : <span className="text-zinc-600">—</span>}
                  </td>
                  <td className="px-3 py-2 text-zinc-300">
                    {t.to_tank
                      ? <><span className="text-zinc-100">{t.to_tank.name}</span> <span className={`px-1 py-px rounded border text-zinc-500 ${toEq?.badge ?? ""}`} style={{ fontSize: 9 }}>{toEq?.label ?? t.to_tank.type}</span></>
                      : t.transfer_type === "export"
                        ? <span className="text-zinc-400">Export Bay</span>
                        : <span className="text-zinc-600">—</span>}
                  </td>
                  <td className="px-3 py-2 text-zinc-400 capitalize">
                    {t.transfer_type === "export" && t.export_detail
                      ? `Export → ${t.export_detail.channel === "contract_brewing" ? (t.export_detail.partner_name ?? "Contract Brewing") : t.export_detail.channel}`
                      : t.transfer_type}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-zinc-300">
                    {fmtBbl2(Number(t.volume_bbl))}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-zinc-500">
                    {Number(t.shrinkage_bbl) > 0 ? fmtBbl2(Number(t.shrinkage_bbl)) : "—"}
                  </td>
                  <td className="px-3 py-2 text-zinc-500 max-w-[160px] truncate">{t.notes ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
