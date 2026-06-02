"use client";

import React, { useState } from "react";
import { BrewBatch, BatchTransfer, Recipe } from "../types";
import { BREWHOUSE_BBL, BATCH_STATUSES, StatusBadge, Modal, Field, ModalActions } from "./shared";
import { fmtDateLong, fmtBbl } from "@/lib/utils/formatting";
import { EQ } from "../equipmentMeta";

function computeTurns(bbl: string) {
  const v = parseFloat(bbl);
  return !isNaN(v) && v > 0 ? Math.ceil(v / BREWHOUSE_BBL) : 1;
}

const fmtDate = fmtDateLong;

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const BATCH_EMPTY = {
  recipe_id: "",
  beer_name: "",
  planned_brew_date: new Date().toISOString().slice(0, 10),
  volume_bbl: "",
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
  const [submitting, setSubmitting] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  function handleRecipeChange(recipeId: string) {
    const r = recipes.find((r) => r.id === recipeId);
    setForm((f) => ({
      ...f,
      recipe_id: recipeId,
      beer_name:  r?.beer_name ?? f.beer_name,
      volume_bbl: r?.expected_yield_bbl ? String(r.expected_yield_bbl) : f.volume_bbl,
      turns:      r?.expected_yield_bbl ? String(computeTurns(String(r.expected_yield_bbl))) : f.turns,
    }));
  }

  function openNew() { setForm(BATCH_EMPTY); setEditingId(null); setShowModal(true); }

  function openEdit(b: BrewBatch) {
    setForm({
      recipe_id:          b.recipe_id ?? "",
      beer_name:          b.beer_name,
      planned_brew_date:  b.planned_brew_date,
      volume_bbl:         String(b.volume_bbl),
      turns:              String(b.turns),
      notes:              b.notes ?? "",
    });
    setEditingId(b.id);
    setShowModal(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.recipe_id) { alert("Please select a recipe."); return; }
    setSubmitting(true);
    try {
      const payload = {
        recipe_id:         form.recipe_id,
        beer_name:         form.beer_name,
        planned_brew_date: form.planned_brew_date,
        volume_bbl:        parseFloat(form.volume_bbl),
        turns:             parseInt(form.turns),
        notes:             form.notes || null,
      };
      const res = editingId
        ? await fetch(`/api/production/batches/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch("/api/production/batches",              { method: "POST",  headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowModal(false);
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

  const active   = batches.filter((b) => b.status !== "archived");
  const archived = batches.filter((b) => b.status === "archived");

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">Brew Batch Log</h2>
          <p className="text-sm text-zinc-500 mt-0.5">
            {BREWHOUSE_BBL} BBL brewhouse · status set automatically from Brew Status
          </p>
        </div>
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
            onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
            onEdit={openEdit}
            onDelete={handleDelete}
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
                onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
                onEdit={openEdit}
                onDelete={handleDelete}
              />
            </details>
          )}
        </>
      )}

      {showModal && (
        <Modal title={editingId ? "Edit Batch" : "New Batch"} onClose={() => setShowModal(false)}>
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
            <Field label="Planned Brew Date" required>
              <input type="date" className="inp" value={form.planned_brew_date} required
                onChange={(e) => setForm((f) => ({ ...f, planned_brew_date: e.target.value }))} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Volume (BBL)" required>
                <input type="number" step="0.01" min="0" className="inp" value={form.volume_bbl} required
                  onChange={(e) => setForm((f) => ({
                    ...f,
                    volume_bbl: e.target.value,
                    turns: String(computeTurns(e.target.value)),
                  }))} />
              </Field>
              <Field label={`Turns (${BREWHOUSE_BBL} BBL)`} required>
                <input type="number" min="1" step="1" className="inp" value={form.turns} required
                  onChange={(e) => setForm((f) => ({ ...f, turns: e.target.value }))} />
              </Field>
            </div>
            <Field label="Notes">
              <textarea className="inp resize-none" rows={2} value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            </Field>
            <ModalActions submitting={submitting} onCancel={() => setShowModal(false)}
              label={editingId ? "Save Changes" : "Create Batch"} />
          </form>
        </Modal>
      )}
    </>
  );
}

function BatchTable({
  batches,
  transfers,
  expandedId,
  onToggle,
  onEdit,
  onDelete,
}: {
  batches: BrewBatch[];
  transfers: BatchTransfer[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  onEdit: (b: BrewBatch) => void;
  onDelete: (id: string, name: string) => void;
}) {
  if (!batches.length) return null;

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left bg-zinc-900/50">
            <th className="px-3 py-2.5 text-xs font-medium text-zinc-500 w-6"></th>
            <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Batch #</th>
            <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Beer</th>
            <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Planned Brew</th>
            <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Volume</th>
            <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Turns</th>
            <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Status</th>
            <th className="px-4 py-2.5 text-xs font-medium text-zinc-500"></th>
          </tr>
        </thead>
        <tbody>
          {batches.map((b, i) => {
            const isExpanded    = expandedId === b.id;
            const batchTransfers = transfers.filter((t) => t.batch_id === b.id);

            return (
              <React.Fragment key={b.id}>
                <tr className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""} ${isExpanded ? "border-b-0" : ""}`}>
                  <td className="px-3 py-2.5">
                    <button
                      onClick={() => onToggle(b.id)}
                      className="text-zinc-600 hover:text-zinc-400 transition-colors text-xs"
                      title="Show transfer log"
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
                  <td className="px-4 py-2.5 text-zinc-300 text-right tabular-nums">{Number(b.volume_bbl).toFixed(1)} BBL</td>
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
                    <td colSpan={8} className="px-6 pb-4 pt-1">
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
                  <td className="px-3 py-2 tabular-nums text-zinc-300">{fmtBbl(Number(t.volume_bbl))}</td>
                  <td className="px-3 py-2 tabular-nums text-zinc-500">
                    {Number(t.shrinkage_bbl) > 0 ? fmtBbl(Number(t.shrinkage_bbl)) : "—"}
                  </td>
                  <td className="px-3 py-2 text-zinc-500 max-w-[160px] truncate">{t.notes ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-600 mt-1.5">
        Batch volume: {fmtBbl(batchVol)} · Total transferred:{" "}
        {fmtBbl(sorted.reduce((s, t) => s + Number(t.volume_bbl), 0))} ·
        Total shrinkage:{" "}
        {fmtBbl(sorted.reduce((s, t) => s + Number(t.shrinkage_bbl), 0))}
      </p>
    </div>
  );
}
