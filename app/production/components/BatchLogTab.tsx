"use client";

import React, { useState } from "react";
import { BrewBatch, BatchStatus, BatchStatusHistory, Recipe } from "../types";
import { BREWHOUSE_BBL, BATCH_STATUSES, STATUS_MAP, StatusBadge, Modal, Field, ModalActions } from "./shared";

const STATUS_OPTIONS = BATCH_STATUSES.filter((s) => s.value !== "archived");

function computeTurns(bbl: string) {
  const v = parseFloat(bbl);
  return !isNaN(v) && v > 0 ? Math.ceil(v / BREWHOUSE_BBL) : 1;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const BATCH_EMPTY = {
  recipe_id: "",
  beer_name: "",
  planned_brew_date: new Date().toISOString().slice(0, 10),
  volume_bbl: "",
  turns: "1",
  status: "planning" as BatchStatus,
  notes: "",
};

export default function BatchLogTab({
  batches,
  recipes,
  onRefresh,
}: {
  batches: BrewBatch[];
  recipes: Recipe[];
  onRefresh: () => Promise<void>;
}) {
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(BATCH_EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState("");

  // Prefill from recipe when recipe selected
  function handleRecipeChange(recipeId: string) {
    const r = recipes.find((r) => r.id === recipeId);
    setForm((f) => ({
      ...f,
      recipe_id: recipeId,
      beer_name: r?.beer_name ?? f.beer_name,
      volume_bbl: r?.expected_yield_bbl ? String(r.expected_yield_bbl) : f.volume_bbl,
      turns: r?.expected_yield_bbl ? String(computeTurns(String(r.expected_yield_bbl))) : f.turns,
    }));
  }

  function openNew() {
    setForm(BATCH_EMPTY);
    setEditingId(null);
    setShowModal(true);
  }

  function openEdit(b: BrewBatch) {
    setForm({
      recipe_id: b.recipe_id ?? "",
      beer_name: b.beer_name,
      planned_brew_date: b.planned_brew_date,
      volume_bbl: String(b.volume_bbl),
      turns: String(b.turns),
      status: b.status,
      notes: b.notes ?? "",
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
        recipe_id: form.recipe_id,
        beer_name: form.beer_name,
        planned_brew_date: form.planned_brew_date,
        volume_bbl: parseFloat(form.volume_bbl),
        turns: parseInt(form.turns),
        status: form.status,
        notes: form.notes || null,
      };
      const res = editingId
        ? await fetch(`/api/production/batches/${editingId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/production/batches", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
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

  async function updateStatus(id: string, status: BatchStatus) {
    await fetch(`/api/production/batches/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, status_note: statusNote || null }),
    });
    setStatusNote("");
    await onRefresh();
  }

  const active = batches.filter((b) => b.status !== "archived");
  const archived = batches.filter((b) => b.status === "archived");

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">Brew Batch Log</h2>
          <p className="text-sm text-zinc-500 mt-0.5">
            {BREWHOUSE_BBL} BBL brewhouse · batches always started from a recipe
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
            recipes={recipes}
            expandedId={expandedId}
            onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
            onEdit={openEdit}
            onDelete={handleDelete}
            onStatusChange={updateStatus}
          />
          {archived.length > 0 && (
            <details className="mt-8">
              <summary className="text-sm text-zinc-500 cursor-pointer hover:text-zinc-400 select-none mb-3">
                Archived ({archived.length})
              </summary>
              <BatchTable
                batches={archived}
                recipes={recipes}
                expandedId={expandedId}
                onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
                onEdit={openEdit}
                onDelete={handleDelete}
                onStatusChange={updateStatus}
              />
            </details>
          )}
        </>
      )}

      {showModal && (
        <Modal title={editingId ? "Edit Batch" : "New Batch"} onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field label="Recipe" required>
              <select
                className="inp"
                value={form.recipe_id}
                onChange={(e) => handleRecipeChange(e.target.value)}
                required
              >
                <option value="">— select a recipe —</option>
                {recipes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.beer_name}{r.brewery ? ` · ${r.brewery}` : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Beer Name" required>
              <input
                className="inp"
                value={form.beer_name}
                required
                onChange={(e) => setForm((f) => ({ ...f, beer_name: e.target.value }))}
              />
            </Field>
            <Field label="Planned Brew Date" required>
              <input
                type="date"
                className="inp"
                value={form.planned_brew_date}
                required
                onChange={(e) => setForm((f) => ({ ...f, planned_brew_date: e.target.value }))}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Volume (BBL)" required>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className="inp"
                  value={form.volume_bbl}
                  required
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      volume_bbl: e.target.value,
                      turns: String(computeTurns(e.target.value)),
                    }))
                  }
                />
              </Field>
              <Field label={`Turns (${BREWHOUSE_BBL} BBL)`} required>
                <input
                  type="number"
                  min="1"
                  step="1"
                  className="inp"
                  value={form.turns}
                  required
                  onChange={(e) => setForm((f) => ({ ...f, turns: e.target.value }))}
                />
              </Field>
            </div>
            <Field label="Status" required>
              <select
                className="inp"
                value={form.status}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as BatchStatus }))}
              >
                {BATCH_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Notes">
              <textarea
                className="inp resize-none"
                rows={2}
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </Field>
            <ModalActions
              submitting={submitting}
              onCancel={() => setShowModal(false)}
              label={editingId ? "Save Changes" : "Create Batch"}
            />
          </form>
        </Modal>
      )}
    </>
  );
}

function BatchTable({
  batches,
  recipes,
  expandedId,
  onToggle,
  onEdit,
  onDelete,
  onStatusChange,
}: {
  batches: BrewBatch[];
  recipes: Recipe[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  onEdit: (b: BrewBatch) => void;
  onDelete: (id: string, name: string) => void;
  onStatusChange: (id: string, s: BatchStatus) => void;
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
            const isExpanded = expandedId === b.id;
            const history = [...(b.batch_status_history ?? [])].sort(
              (a, b) => new Date(a.changed_at).getTime() - new Date(b.changed_at).getTime()
            );

            return (
              <React.Fragment key={b.id}>
                <tr
                  className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""} ${isExpanded ? "border-b-0" : ""}`}
                >
                  <td className="px-3 py-2.5">
                    <button
                      onClick={() => onToggle(b.id)}
                      className="text-zinc-600 hover:text-zinc-400 transition-colors text-xs"
                      title="Show status timeline"
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
                  <td className="px-4 py-2.5 text-zinc-300 text-right tabular-nums">
                    {Number(b.volume_bbl).toFixed(1)} BBL
                  </td>
                  <td className="px-4 py-2.5 text-zinc-400 text-right">{b.turns}</td>
                  <td className="px-4 py-2.5">
                    <StatusDropdown
                      status={b.status}
                      onChange={(s) => onStatusChange(b.id, s)}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-3 justify-end">
                      <button
                        onClick={() => onEdit(b)}
                        className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => onDelete(b.id, b.beer_name)}
                        className="text-xs text-zinc-600 hover:text-red-400 transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>

                {isExpanded && (
                  <tr className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                    <td colSpan={8} className="px-6 pb-4 pt-1">
                      <StatusTimeline history={history} currentStatus={b.status} />
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

function StatusDropdown({ status, onChange }: { status: BatchStatus; onChange: (s: BatchStatus) => void }) {
  const s = STATUS_MAP[status];
  return (
    <select
      value={status}
      onChange={(e) => onChange(e.target.value as BatchStatus)}
      className={`text-xs px-2 py-0.5 rounded font-medium cursor-pointer border outline-none appearance-none ${s?.color ?? ""}`}
      style={{ background: "transparent" }}
    >
      {BATCH_STATUSES.map((opt) => (
        <option key={opt.value} value={opt.value} style={{ background: "rgb(39 39 42)", color: "rgb(244 244 245)" }}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

function StatusTimeline({ history, currentStatus }: { history: BatchStatusHistory[]; currentStatus: BatchStatus }) {
  if (!history.length) {
    return <p className="text-xs text-zinc-600">No status history recorded.</p>;
  }

  return (
    <div className="flex flex-col gap-0">
      <p className="text-xs text-zinc-600 mb-2 font-medium uppercase tracking-wide">Status Timeline</p>
      <div className="flex flex-col">
        {history.map((h, i) => {
          const s = STATUS_MAP[h.status as BatchStatus];
          const isLast = i === history.length - 1;
          return (
            <div key={h.id} className="flex items-start gap-3">
              {/* Timeline connector */}
              <div className="flex flex-col items-center w-3 shrink-0 mt-1">
                <div className={`w-2.5 h-2.5 rounded-full border-2 shrink-0 ${isLast ? "border-amber-500 bg-amber-500/30" : "border-zinc-600 bg-zinc-800"}`} />
                {!isLast && <div className="w-px flex-1 bg-zinc-700 mt-1 mb-1 min-h-[16px]" />}
              </div>
              <div className="pb-3">
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-1.5 py-px rounded border font-medium ${s?.color ?? "text-zinc-400"}`}>
                    {s?.label ?? h.status}
                  </span>
                  <span className="text-xs text-zinc-500">{fmtDateTime(h.changed_at)}</span>
                </div>
                {h.note && <p className="text-xs text-zinc-600 mt-0.5">{h.note}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
