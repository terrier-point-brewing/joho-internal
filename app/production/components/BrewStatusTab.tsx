"use client";

import React, { useState } from "react";
import { Tank, BatchTankAssignment, BrewBatch, TankType } from "../types";
import { StatusBadge, Modal, Field, ModalActions } from "./shared";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_ROWS = 3;
const MIN_COLS = 4;

const TANK_TYPES: { value: TankType; label: string; color: string }[] = [
  { value: "fermenter", label: "Fermenter", color: "bg-blue-900/40 text-blue-300 border-blue-800" },
  { value: "unitank",   label: "Unitank",   color: "bg-indigo-900/40 text-indigo-300 border-indigo-800" },
  { value: "brite",     label: "Brite",     color: "bg-cyan-900/40 text-cyan-300 border-cyan-800" },
  { value: "serving",   label: "Serving",   color: "bg-teal-900/40 text-teal-300 border-teal-800" },
];
const TANK_TYPE_MAP = Object.fromEntries(
  TANK_TYPES.map((t) => [t.value, t])
) as Record<TankType, (typeof TANK_TYPES)[number]>;

const TANK_EMPTY = { name: "", type: "fermenter" as TankType, capacity_bbl: "", notes: "" };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeGrid(tanks: Tank[]) {
  const placed = tanks.filter((t) => t.grid_row != null && t.grid_col != null);
  const maxRow = placed.length ? Math.max(...placed.map((t) => t.grid_row!)) : -1;
  const maxCol = placed.length ? Math.max(...placed.map((t) => t.grid_col!)) : -1;
  return {
    rows: Math.max(MIN_ROWS, maxRow + 2),
    cols: Math.max(MIN_COLS, maxCol + 2),
  };
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function BrewStatusTab({
  tanks,
  assignments,
  batches,
  onRefresh,
}: {
  tanks: Tank[];
  assignments: BatchTankAssignment[];
  batches: BrewBatch[];
  onRefresh: () => Promise<void>;
}) {
  const [showTankModal, setShowTankModal] = useState(false);
  const [tankForm, setTankForm] = useState(TANK_EMPTY);
  const [editingTankId, setEditingTankId] = useState<string | null>(null);
  const [tankSubmitting, setTankSubmitting] = useState(false);

  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignTankId, setAssignTankId] = useState<string | null>(null);
  const [assignBatchId, setAssignBatchId] = useState("");
  const [assignNotes, setAssignNotes] = useState("");
  const [assignSubmitting, setAssignSubmitting] = useState(false);

  // Drag state
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverCell, setHoverCell] = useState<{ row: number; col: number } | null>(null);

  const assignmentByTank = Object.fromEntries(
    assignments.map((a) => [a.tank_id, a])
  ) as Record<string, BatchTankAssignment | undefined>;

  const assignedBatchIds = new Set(assignments.map((a) => a.batch_id));
  const unassignedBatches = batches.filter(
    (b) => b.status !== "archived" && !assignedBatchIds.has(b.id)
  );

  const placedTanks = tanks.filter((t) => t.grid_row != null && t.grid_col != null);
  const unplacedTanks = tanks.filter((t) => t.grid_row == null || t.grid_col == null);

  const { rows, cols } = computeGrid(tanks);

  // ── Tank CRUD ───────────────────────────────────────────────────────────────

  function openNewTank() {
    setTankForm(TANK_EMPTY);
    setEditingTankId(null);
    setShowTankModal(true);
  }

  function openEditTank(t: Tank) {
    setTankForm({
      name: t.name,
      type: t.type,
      capacity_bbl: t.capacity_bbl != null ? String(t.capacity_bbl) : "",
      notes: t.notes ?? "",
    });
    setEditingTankId(t.id);
    setShowTankModal(true);
  }

  async function handleTankSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTankSubmitting(true);
    try {
      const payload = {
        name: tankForm.name,
        type: tankForm.type,
        capacity_bbl: tankForm.capacity_bbl ? parseFloat(tankForm.capacity_bbl) : null,
        notes: tankForm.notes || null,
      };
      const res = editingTankId
        ? await fetch(`/api/production/tanks/${editingTankId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/production/tanks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowTankModal(false);
      await onRefresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setTankSubmitting(false);
    }
  }

  async function handleDeleteTank(id: string, name: string) {
    if (!confirm(`Delete tank "${name}"?`)) return;
    await fetch(`/api/production/tanks/${id}`, { method: "DELETE" });
    await onRefresh();
  }

  // ── Position updates (drag-and-drop) ────────────────────────────────────────

  async function moveTankTo(tankId: string, row: number | null, col: number | null) {
    // If target cell is occupied, swap positions
    const occupant = row != null && col != null
      ? placedTanks.find((t) => t.grid_row === row && t.grid_col === col && t.id !== tankId)
      : null;

    const draggedTank = tanks.find((t) => t.id === tankId);

    if (occupant) {
      // Swap: move occupant to dragged tank's old position
      await Promise.all([
        fetch(`/api/production/tanks/${tankId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grid_row: row, grid_col: col }),
        }),
        fetch(`/api/production/tanks/${occupant.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grid_row: draggedTank?.grid_row ?? null, grid_col: draggedTank?.grid_col ?? null }),
        }),
      ]);
    } else {
      await fetch(`/api/production/tanks/${tankId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grid_row: row, grid_col: col }),
      });
    }
    await onRefresh();
  }

  // ── Drag handlers ────────────────────────────────────────────────────────────

  function onDragStart(e: React.DragEvent, tankId: string) {
    e.dataTransfer.setData("tankId", tankId);
    e.dataTransfer.effectAllowed = "move";
    setDraggingId(tankId);
  }

  function onDragEnd() {
    setDraggingId(null);
    setHoverCell(null);
  }

  function onCellDragOver(e: React.DragEvent, row: number, col: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setHoverCell({ row, col });
  }

  function onCellDragLeave() {
    setHoverCell(null);
  }

  async function onCellDrop(e: React.DragEvent, row: number, col: number) {
    e.preventDefault();
    const tankId = e.dataTransfer.getData("tankId");
    setDraggingId(null);
    setHoverCell(null);
    if (tankId) await moveTankTo(tankId, row, col);
  }

  async function onUnplacedDrop(e: React.DragEvent) {
    e.preventDefault();
    const tankId = e.dataTransfer.getData("tankId");
    setDraggingId(null);
    setHoverCell(null);
    if (tankId) await moveTankTo(tankId, null, null);
  }

  // ── Batch assign/release ─────────────────────────────────────────────────────

  function openAssign(tankId: string) {
    setAssignTankId(tankId);
    setAssignBatchId(unassignedBatches[0]?.id ?? "");
    setAssignNotes("");
    setShowAssignModal(true);
  }

  async function handleAssignSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!assignBatchId || !assignTankId) return;
    setAssignSubmitting(true);
    try {
      const res = await fetch("/api/production/tank-assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_id: assignBatchId, tank_id: assignTankId, notes: assignNotes || null }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowAssignModal(false);
      await onRefresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setAssignSubmitting(false);
    }
  }

  async function handleRelease(assignmentId: string) {
    if (!confirm("Release this batch from the tank?")) return;
    await fetch(`/api/production/tank-assignments/${assignmentId}`, { method: "PATCH" });
    await onRefresh();
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-base font-medium text-zinc-100">Brew Status</h2>
          <p className="text-sm text-zinc-500 mt-0.5">
            Drag tanks to arrange the shop floor layout · assign batches to tanks
          </p>
        </div>
        <button onClick={openNewTank} className="btn-amber">+ Add Tank</button>
      </div>

      {/* ── Shop floor grid ── */}
      {placedTanks.length === 0 && unplacedTanks.length === 0 ? (
        <p className="text-zinc-600 text-sm mb-6">No tanks configured yet.</p>
      ) : (
        <div
          className="grid gap-2 mb-6"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: rows * cols }, (_, i) => {
            const row = Math.floor(i / cols);
            const col = i % cols;
            const tank = placedTanks.find((t) => t.grid_row === row && t.grid_col === col);
            const isHover = hoverCell?.row === row && hoverCell?.col === col;
            const isDraggingThis = tank?.id === draggingId;

            if (tank) {
              return (
                <div
                  key={`${row}-${col}`}
                  draggable
                  onDragStart={(e) => onDragStart(e, tank.id)}
                  onDragEnd={onDragEnd}
                  onDragOver={(e) => onCellDragOver(e, row, col)}
                  onDragLeave={onCellDragLeave}
                  onDrop={(e) => onCellDrop(e, row, col)}
                  className={`rounded-lg border flex flex-col transition-all cursor-grab active:cursor-grabbing select-none ${
                    isDraggingThis
                      ? "opacity-40 border-zinc-700"
                      : isHover
                      ? "border-amber-500 ring-1 ring-amber-500/30"
                      : "border-zinc-800"
                  }`}
                  style={{ minHeight: 160 }}
                >
                  <TankCardContent
                    tank={tank}
                    assignment={assignmentByTank[tank.id]}
                    unassignedBatches={unassignedBatches}
                    onEdit={() => openEditTank(tank)}
                    onDelete={() => handleDeleteTank(tank.id, tank.name)}
                    onAssign={() => openAssign(tank.id)}
                    onRelease={handleRelease}
                  />
                </div>
              );
            }

            return (
              <div
                key={`${row}-${col}`}
                onDragOver={(e) => onCellDragOver(e, row, col)}
                onDragLeave={onCellDragLeave}
                onDrop={(e) => onCellDrop(e, row, col)}
                className={`rounded-lg border-2 border-dashed transition-colors flex items-center justify-center ${
                  isHover && draggingId
                    ? "border-amber-500 bg-amber-900/10"
                    : "border-zinc-800/60"
                }`}
                style={{ minHeight: 160 }}
              >
                {isHover && draggingId && (
                  <span className="text-xs text-amber-500">Drop here</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Unplaced tanks ── */}
      {unplacedTanks.length > 0 && (
        <div
          className="mb-6 p-3 rounded-lg border border-dashed border-zinc-700"
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={onUnplacedDrop}
        >
          <p className="text-xs text-zinc-500 font-medium uppercase tracking-wide mb-2">
            Unplaced Tanks — drag onto the grid to position
          </p>
          <div className="flex flex-wrap gap-2">
            {unplacedTanks.map((tank) => (
              <div
                key={tank.id}
                draggable
                onDragStart={(e) => onDragStart(e, tank.id)}
                onDragEnd={onDragEnd}
                className={`rounded border border-zinc-700 bg-zinc-900 px-3 py-2 cursor-grab active:cursor-grabbing select-none transition-opacity ${
                  draggingId === tank.id ? "opacity-40" : ""
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zinc-200">{tank.name}</span>
                  <span className={`text-xs px-1.5 py-px rounded border ${TANK_TYPE_MAP[tank.type].color}`}>
                    {TANK_TYPE_MAP[tank.type].label}
                  </span>
                  {tank.capacity_bbl && (
                    <span className="text-xs text-zinc-500">{tank.capacity_bbl} BBL</span>
                  )}
                </div>
                <div className="flex gap-3 mt-1.5">
                  <button
                    onClick={() => openEditTank(tank)}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDeleteTank(tank.id, tank.name)}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="text-xs text-zinc-600 hover:text-red-400 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Unassigned batches ── */}
      {unassignedBatches.length > 0 && (
        <div>
          <p className="text-xs text-zinc-500 font-medium uppercase tracking-wide mb-2">
            Unassigned Batches ({unassignedBatches.length})
          </p>
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                  {["Batch #", "Beer", "Volume", "Status"].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-xs font-medium text-zinc-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {unassignedBatches.map((b, i) => (
                  <tr key={b.id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                    <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">{b.batch_number ?? "—"}</td>
                    <td className="px-4 py-2.5 text-zinc-200">{b.beer_name}</td>
                    <td className="px-4 py-2.5 text-zinc-400">{Number(b.volume_bbl).toFixed(1)} BBL</td>
                    <td className="px-4 py-2.5"><StatusBadge status={b.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      {showTankModal && (
        <Modal title={editingTankId ? "Edit Tank" : "Add Tank"} onClose={() => setShowTankModal(false)}>
          <form onSubmit={handleTankSubmit} className="space-y-4">
            <Field label="Tank Name" required>
              <input className="inp" placeholder="e.g. FV-1, Brite 2" value={tankForm.name} required
                onChange={(e) => setTankForm((f) => ({ ...f, name: e.target.value }))} />
            </Field>
            <Field label="Type" required>
              <div className="grid grid-cols-2 gap-2">
                {TANK_TYPES.map((t) => (
                  <button key={t.value} type="button"
                    onClick={() => setTankForm((f) => ({ ...f, type: t.value }))}
                    className={`px-3 py-2 rounded border text-sm font-medium transition-colors ${
                      tankForm.type === t.value
                        ? "border-amber-600 bg-amber-900/30 text-amber-300"
                        : "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-500"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Capacity (BBL)">
              <input type="number" step="0.5" min="0" className="inp" placeholder="e.g. 30"
                value={tankForm.capacity_bbl}
                onChange={(e) => setTankForm((f) => ({ ...f, capacity_bbl: e.target.value }))} />
            </Field>
            <Field label="Notes">
              <input className="inp" value={tankForm.notes}
                onChange={(e) => setTankForm((f) => ({ ...f, notes: e.target.value }))} />
            </Field>
            <ModalActions submitting={tankSubmitting} onCancel={() => setShowTankModal(false)}
              label={editingTankId ? "Save Changes" : "Add Tank"} />
          </form>
        </Modal>
      )}

      {showAssignModal && (
        <Modal title="Assign Batch to Tank" onClose={() => setShowAssignModal(false)}>
          <form onSubmit={handleAssignSubmit} className="space-y-4">
            <Field label="Batch" required>
              <select className="inp" value={assignBatchId} required
                onChange={(e) => setAssignBatchId(e.target.value)}>
                <option value="">— select a batch —</option>
                {unassignedBatches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.batch_number ?? "?"} · {b.beer_name} ({Number(b.volume_bbl).toFixed(1)} BBL)
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Notes">
              <input className="inp" placeholder="Optional notes" value={assignNotes}
                onChange={(e) => setAssignNotes(e.target.value)} />
            </Field>
            <ModalActions submitting={assignSubmitting} onCancel={() => setShowAssignModal(false)}
              label="Assign" />
          </form>
        </Modal>
      )}
    </>
  );
}

// ─── Tank card content ────────────────────────────────────────────────────────

function TankCardContent({
  tank,
  assignment,
  unassignedBatches,
  onEdit,
  onDelete,
  onAssign,
  onRelease,
}: {
  tank: Tank;
  assignment: BatchTankAssignment | undefined;
  unassignedBatches: BrewBatch[];
  onEdit: () => void;
  onDelete: () => void;
  onAssign: () => void;
  onRelease: (id: string) => void;
}) {
  const typeMeta = TANK_TYPE_MAP[tank.type];
  const batch = assignment?.brew_batches;

  return (
    <>
      {/* Tank header */}
      <div className="flex items-start justify-between px-3 py-2.5 border-b border-zinc-800 bg-zinc-900/60">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-medium text-zinc-100 text-sm leading-tight">{tank.name}</span>
            <span className={`text-xs px-1.5 py-px rounded border ${typeMeta.color} shrink-0`}>
              {typeMeta.label}
            </span>
          </div>
          {tank.capacity_bbl && (
            <p className="text-xs text-zinc-600 mt-0.5">{tank.capacity_bbl} BBL</p>
          )}
        </div>
        <div className="flex gap-2 shrink-0 ml-1">
          <button onClick={onEdit} onMouseDown={(e) => e.stopPropagation()}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">
            Edit
          </button>
          {!assignment && (
            <button onClick={onDelete} onMouseDown={(e) => e.stopPropagation()}
              className="text-xs text-zinc-600 hover:text-red-400 transition-colors">
              ×
            </button>
          )}
        </div>
      </div>

      {/* Batch area */}
      <div className="flex-1 p-3">
        {batch ? (
          <>
            <p className="text-sm font-medium text-zinc-100 leading-snug">{batch.beer_name}</p>
            <p className="font-mono text-xs text-zinc-500 mt-0.5">{batch.batch_number ?? "—"}</p>
            <div className="mt-2">
              <StatusBadge status={batch.status} />
            </div>
            <p className="text-xs text-zinc-600 mt-1.5">
              {Number(batch.volume_bbl).toFixed(1)} BBL · since {fmtDate(assignment!.assigned_at)}
            </p>
            <button
              onClick={() => onRelease(assignment!.id)}
              onMouseDown={(e) => e.stopPropagation()}
              className="mt-2 text-xs text-zinc-500 hover:text-red-400 border border-zinc-700 hover:border-red-800 px-2 py-0.5 rounded transition-colors"
            >
              Release
            </button>
          </>
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-1.5 min-h-[80px]">
            <p className="text-xs text-zinc-700">Empty</p>
            {unassignedBatches.length > 0 && (
              <button
                onClick={onAssign}
                onMouseDown={(e) => e.stopPropagation()}
                className="text-xs text-amber-600 hover:text-amber-400 border border-amber-900 hover:border-amber-700 px-2 py-0.5 rounded transition-colors"
              >
                Assign Batch
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
