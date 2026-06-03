"use client";

import React, { useState, useEffect, useCallback } from "react";
import { BrewBatch, BatchTransfer, Recipe, PlannedAllocation, ContractBrewingPartner } from "../types";
import { BREWHOUSE_BBL, StatusBadge, Modal, Field, ModalActions } from "./shared";
import { fmtDateLong, fmtBbl2 } from "@/lib/utils/formatting";
import { EQ } from "../equipmentMeta";

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
};

export default function BatchLogTab({
  batches,
  recipes,
  transfers,
  onRefresh,
}: {
  batches: BrewBatch[];
  recipes: Recipe[];
  transfers: BatchTransfer[];
  onRefresh: () => Promise<void>;
}) {
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
      };
      const res = editingId
        ? await fetch(`/api/production/batches/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch("/api/production/batches",              { method: "POST",  headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowModal(false);
      setEditingBatch(null);
      await onRefresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error saving batch");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete batch "${name}"? This cannot be undone.`)) return;
    await fetch(`/api/production/batches/${id}`, { method: "DELETE" });
    await onRefresh();
  }

  const active   = sortBatches(batches.filter((b) => b.status !== "archived"));
  const archived = sortBatches(batches.filter((b) => b.status === "archived"));

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

      {active.length === 0 && archived.length === 0 ? (
        <p className="text-zinc-600 text-sm">No batches yet.</p>
      ) : (
        <>
          <BatchTable
            batches={active}
            transfers={transfers}
            expandedId={expandedId}
            sort={sort}
            onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
            onEdit={openEdit}
            onDelete={handleDelete}
            onRefresh={onRefresh}
            onSort={toggleSort}
          />
          {archived.length > 0 && (
            <details className="mt-8">
              <summary className="text-sm text-zinc-500 cursor-pointer hover:text-zinc-400 select-none mb-3">
                Archived ({archived.length})
              </summary>
              <BatchTable
                batches={archived}
                transfers={transfers}
                expandedId={expandedId}
                sort={sort}
                onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
                onEdit={openEdit}
                onDelete={handleDelete}
                onRefresh={onRefresh}
                onSort={toggleSort}
              />
            </details>
          )}
        </>
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

            {editingBatch && (
              <div className="pt-4 border-t border-zinc-800">
                <AllocationManager batch={editingBatch} onRefresh={async () => { await onRefresh(); }} />
              </div>
            )}

            <ModalActions submitting={submitting} onCancel={() => { setShowModal(false); setEditingBatch(null); }}
              label={editingId ? "Save Changes" : "Create Batch"} />
          </form>
        </Modal>
      )}
    </>
  );
}

// ─── Allocation mini-manager ────────────────────────────────────────────────

const RECIPIENT_OPTIONS = ["Taproom", "Distribution", "Contract Brewing", "Events"] as const;
type RecipientOption = typeof RECIPIENT_OPTIONS[number];

function AllocationManager({ batch, onRefresh }: { batch: BrewBatch; onRefresh: () => Promise<void> }) {
  const [recipient, setRecipient] = useState<RecipientOption>("Taproom");
  const [partnerId, setPartnerId] = useState("");
  const [partners, setPartners] = useState<ContractBrewingPartner[]>([]);
  const [volBbl, setVolBbl] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const loadPartners = useCallback(async () => {
    const r = await fetch("/api/partners/contract-brewing");
    if (r.ok) setPartners(await r.json());
  }, []);

  useEffect(() => { loadPartners(); }, [loadPartners]);

  // Set default partner when list loads
  useEffect(() => {
    if (partners.length && !partnerId) setPartnerId(partners[0].id);
  }, [partners, partnerId]);

  const allocations: PlannedAllocation[] = batch.planned_allocations ?? [];
  const totalAllocated = allocations.reduce((s, a) => s + Number(a.volume_bbl), 0);
  const batchVol = Number(batch.volume_bbl);
  const remaining = batchVol - totalAllocated;

  async function handleAdd() {
    if (!volBbl) return;
    const partner = partners.find((p) => p.id === partnerId);
    const label = recipient === "Contract Brewing" && partner
      ? `Contract Brewing — ${partner.company_name}`
      : recipient;
    setSaving(true);
    try {
      const res = await fetch("/api/production/allocations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_id: batch.id, label, volume_bbl: parseFloat(volBbl), notes: notes || null }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setVolBbl(""); setNotes("");
      await onRefresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Remove this allocation?")) return;
    await fetch(`/api/production/allocations?id=${id}`, { method: "DELETE" });
    await onRefresh();
  }

  return (
    <div>
      <p className="text-xs text-zinc-500 mb-3 font-medium uppercase tracking-wide">Planned Allocation</p>

      {allocations.length > 0 && (
        <>
          {/* Fill bar */}
          <div className="w-full rounded-full overflow-hidden mb-2" style={{ height: 4, background: "rgba(63,63,70,0.5)" }}>
            <div
              style={{
                height: "100%",
                width: `${Math.min(100, (totalAllocated / batchVol) * 100).toFixed(1)}%`,
                background: totalAllocated > batchVol ? "rgb(239,68,68)" : "rgb(245,158,11)",
                borderRadius: "9999px",
                transition: "width 0.3s",
              }}
            />
          </div>

          <div className="overflow-x-auto rounded border border-zinc-800/60 mb-3">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/40 text-left">
                  <th className="px-3 py-2 font-medium text-zinc-500">Recipient</th>
                  <th className="px-3 py-2 font-medium text-zinc-500 text-right">BBL</th>
                  <th className="px-3 py-2 font-medium text-zinc-500 text-right">% of Batch</th>
                  <th className="px-3 py-2 font-medium text-zinc-500">Notes</th>
                  <th className="px-3 py-2 w-6"></th>
                </tr>
              </thead>
              <tbody>
                {allocations.map((a, i) => (
                  <tr key={a.id} className={`border-b border-zinc-800/40 ${i % 2 !== 0 ? "bg-zinc-900/20" : ""}`}>
                    <td className="px-3 py-2 text-zinc-200 font-medium">{a.label}</td>
                    <td className="px-3 py-2 text-zinc-300 text-right tabular-nums">{Number(a.volume_bbl).toFixed(2)}</td>
                    <td className="px-3 py-2 text-zinc-500 text-right tabular-nums">
                      {batchVol > 0 ? ((Number(a.volume_bbl) / batchVol) * 100).toFixed(1) : "—"}%
                    </td>
                    <td className="px-3 py-2 text-zinc-500 max-w-[120px] truncate">{a.notes ?? "—"}</td>
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => handleDelete(a.id)} className="text-zinc-600 hover:text-red-400 transition-colors">×</button>
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-zinc-700 bg-zinc-900/30">
                  <td className="px-3 py-1.5 text-zinc-500 font-medium">Total allocated</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${totalAllocated > batchVol ? "text-red-400" : "text-zinc-300"}`}>
                    {totalAllocated.toFixed(2)}
                  </td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${totalAllocated > batchVol ? "text-red-400" : "text-zinc-500"}`}>
                    {batchVol > 0 ? ((totalAllocated / batchVol) * 100).toFixed(1) : "—"}%
                  </td>
                  <td colSpan={2} className="px-3 py-1.5 text-zinc-600 text-xs">
                    {remaining >= 0 ? `${remaining.toFixed(2)} BBL unallocated` : `${Math.abs(remaining).toFixed(2)} BBL over-allocated`}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Add allocation row — no nested <form>, uses type="button" to avoid submitting outer form */}
      <div className="flex gap-2 items-end flex-wrap">
        <div className="flex-1 min-w-[140px]">
          <label className="block text-xs text-zinc-500 mb-1">Recipient</label>
          <select className="inp" value={recipient} onChange={(e) => setRecipient(e.target.value as RecipientOption)}>
            {RECIPIENT_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        {recipient === "Contract Brewing" && (
          <div className="flex-1 min-w-[140px]">
            <label className="block text-xs text-zinc-500 mb-1">Partner</label>
            <select className="inp" value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
              {partners.length === 0
                ? <option value="">No partners yet</option>
                : partners.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)
              }
            </select>
          </div>
        )}
        <div className="w-24">
          <label className="block text-xs text-zinc-500 mb-1">BBL</label>
          <input type="number" step="0.01" min="0.01" className="inp" placeholder="0.00"
            value={volBbl} onChange={(e) => setVolBbl(e.target.value)} />
        </div>
        <div className="flex-1 min-w-[100px]">
          <label className="block text-xs text-zinc-500 mb-1">Notes (optional)</label>
          <input className="inp" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <button type="button" onClick={handleAdd} disabled={saving || !volBbl}
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
  onRefresh,
  onSort,
}: {
  batches: BrewBatch[];
  transfers: BatchTransfer[];
  expandedId: string | null;
  sort: { col: SortCol; dir: "asc" | "desc" };
  onToggle: (id: string) => void;
  onEdit: (b: BrewBatch) => void;
  onDelete: (id: string, name: string) => void;
  onRefresh: () => Promise<void>;
  onSort: (col: SortCol) => void;
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
                    <td colSpan={9} className="px-6 pb-5 pt-2">
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
                      : <span className="text-zinc-600">—</span>}
                  </td>
                  <td className="px-3 py-2 text-zinc-400 capitalize">{t.transfer_type}</td>
                  <td className="px-3 py-2 tabular-nums text-zinc-300">{fmtBbl2(Number(t.volume_bbl))}</td>
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
      <p className="text-xs text-zinc-600 mt-1.5">
        Batch volume: {fmtBbl2(batchVol)} · Total transferred:{" "}
        {fmtBbl2(sorted.reduce((s, t) => s + Number(t.volume_bbl), 0))} ·
        Total shrinkage:{" "}
        {fmtBbl2(sorted.reduce((s, t) => s + Number(t.shrinkage_bbl), 0))}
      </p>
    </div>
  );
}
