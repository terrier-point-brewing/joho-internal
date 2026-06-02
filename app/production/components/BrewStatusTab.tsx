"use client";

import React, { useState, useRef, useCallback } from "react";
import { Tank, BatchTankAssignment, BrewBatch, TankType } from "../types";
import { StatusBadge, Modal, Field, ModalActions } from "./shared";

// ─── Grid constants ───────────────────────────────────────────────────────────

const CELL = 48;       // px per grid unit
const GAP = 3;         // px inset inside each cell
const GRID_COLS = 24;
const GRID_ROWS = 16;

// ─── Equipment metadata ───────────────────────────────────────────────────────

const EQ: Record<TankType, {
  label: string;
  headerBg: string;
  border: string;
  badge: string;
  defaultW: number;
  defaultH: number;
}> = {
  fermenter:    { label: "Fermenter",    headerBg: "bg-blue-950/80",   border: "border-blue-800",   badge: "bg-blue-900/60 text-blue-300 border-blue-700",    defaultW: 2, defaultH: 4 },
  unitank:      { label: "Unitank",      headerBg: "bg-indigo-950/80", border: "border-indigo-800", badge: "bg-indigo-900/60 text-indigo-300 border-indigo-700", defaultW: 2, defaultH: 4 },
  brite:        { label: "Brite",        headerBg: "bg-cyan-950/80",   border: "border-cyan-800",   badge: "bg-cyan-900/60 text-cyan-300 border-cyan-700",     defaultW: 2, defaultH: 3 },
  serving:      { label: "Serving",      headerBg: "bg-teal-950/80",   border: "border-teal-800",   badge: "bg-teal-900/60 text-teal-300 border-teal-700",     defaultW: 2, defaultH: 2 },
  brewhouse:    { label: "Brewhouse",    headerBg: "bg-amber-950/80",  border: "border-amber-700",  badge: "bg-amber-900/60 text-amber-300 border-amber-600",  defaultW: 3, defaultH: 3 },
  cold_storage: { label: "Cold Storage", headerBg: "bg-sky-950/80",    border: "border-sky-800",    badge: "bg-sky-900/60 text-sky-300 border-sky-700",        defaultW: 5, defaultH: 2 },
};

const EQ_TYPES = Object.entries(EQ) as [TankType, typeof EQ[TankType]][];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function eqStyle(t: Tank): React.CSSProperties {
  return {
    position: "absolute",
    left:   (t.grid_col ?? 0) * CELL + GAP,
    top:    (t.grid_row ?? 0) * CELL + GAP,
    width:  t.grid_width  * CELL - GAP * 2,
    height: t.grid_height * CELL - GAP * 2,
  };
}

function isInBounds(t: Tank, row: number, col: number): boolean {
  return row >= 0 && col >= 0 && row + t.grid_height <= GRID_ROWS && col + t.grid_width <= GRID_COLS;
}

function wouldCollide(tanks: Tank[], tankId: string, row: number, col: number): boolean {
  const drag = tanks.find((t) => t.id === tankId)!;
  return tanks
    .filter((t) => t.id !== tankId && t.grid_row != null && t.grid_col != null)
    .some((t) => {
      const tr = t.grid_row!, tc = t.grid_col!;
      return !(col + drag.grid_width <= tc || col >= tc + t.grid_width ||
               row + drag.grid_height <= tr || row >= tr + t.grid_height);
    });
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ─── Tank form defaults ───────────────────────────────────────────────────────

const TANK_EMPTY = {
  name: "", type: "fermenter" as TankType, capacity_bbl: "", notes: "", grid_width: "2", grid_height: "4",
};

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
  const [editMode, setEditMode] = useState(false);

  // Equipment CRUD
  const [showEqModal, setShowEqModal] = useState(false);
  const [eqForm, setEqForm] = useState(TANK_EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [eqSubmitting, setEqSubmitting] = useState(false);

  // Batch assign/release
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignTankId, setAssignTankId] = useState<string | null>(null);
  const [assignBatchId, setAssignBatchId] = useState("");
  const [assignNotes, setAssignNotes] = useState("");
  const [assignSubmitting, setAssignSubmitting] = useState(false);

  // Drag state
  const [dragging, setDragging] = useState<{ id: string; grabRow: number; grabCol: number } | null>(null);
  const [dropPreview, setDropPreview] = useState<{ row: number; col: number; valid: boolean } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const assignmentByTank = Object.fromEntries(assignments.map((a) => [a.tank_id, a])) as Record<string, BatchTankAssignment | undefined>;
  const assignedBatchIds = new Set(assignments.map((a) => a.batch_id));
  const unassignedBatches = batches.filter((b) => b.status !== "archived" && !assignedBatchIds.has(b.id));

  const placed   = tanks.filter((t) => t.grid_row != null && t.grid_col != null);
  const unplaced = tanks.filter((t) => t.grid_row == null || t.grid_col == null);

  // ── Drag/drop ──────────────────────────────────────────────────────────────

  function onDragStart(e: React.DragEvent, t: Tank) {
    const rect = e.currentTarget.getBoundingClientRect();
    const grabCol = Math.floor((e.clientX - rect.left) / CELL);
    const grabRow = Math.floor((e.clientY - rect.top)  / CELL);
    e.dataTransfer.setData("tankId",  t.id);
    e.dataTransfer.setData("grabCol", String(grabCol));
    e.dataTransfer.setData("grabRow", String(grabRow));
    e.dataTransfer.effectAllowed = "move";
    setDragging({ id: t.id, grabRow, grabCol });
  }

  const onGridDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!dragging || !gridRef.current) return;
    const rect = gridRef.current.getBoundingClientRect();
    const col = Math.max(0, Math.floor((e.clientX - rect.left + gridRef.current.scrollLeft)  / CELL) - dragging.grabCol);
    const row = Math.max(0, Math.floor((e.clientY - rect.top  + gridRef.current.scrollTop)   / CELL) - dragging.grabRow);
    const tank = tanks.find((t) => t.id === dragging.id)!;
    const valid = isInBounds(tank, row, col) && !wouldCollide(tanks, dragging.id, row, col);
    setDropPreview({ row, col, valid });
  }, [dragging, tanks]);

  async function onGridDrop(e: React.DragEvent) {
    e.preventDefault();
    if (!gridRef.current) return;
    const tankId  = e.dataTransfer.getData("tankId");
    const grabCol = parseInt(e.dataTransfer.getData("grabCol") || "0");
    const grabRow = parseInt(e.dataTransfer.getData("grabRow") || "0");
    const rect = gridRef.current.getBoundingClientRect();
    const col  = Math.max(0, Math.floor((e.clientX - rect.left + gridRef.current.scrollLeft) / CELL) - grabCol);
    const row  = Math.max(0, Math.floor((e.clientY - rect.top  + gridRef.current.scrollTop)  / CELL) - grabRow);
    const tank = tanks.find((t) => t.id === tankId);
    if (tank && isInBounds(tank, row, col) && !wouldCollide(tanks, tankId, row, col)) {
      await fetch(`/api/production/tanks/${tankId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grid_row: row, grid_col: col }),
      });
      await onRefresh();
    }
    setDragging(null);
    setDropPreview(null);
  }

  async function removeFromGrid(tankId: string) {
    await fetch(`/api/production/tanks/${tankId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grid_row: null, grid_col: null }),
    });
    await onRefresh();
  }

  async function onUnplacedDrop(e: React.DragEvent) {
    e.preventDefault();
    const tankId = e.dataTransfer.getData("tankId");
    if (tankId) await removeFromGrid(tankId);
    setDragging(null);
    setDropPreview(null);
  }

  // ── Equipment CRUD ─────────────────────────────────────────────────────────

  function openNew() { setEqForm(TANK_EMPTY); setEditingId(null); setShowEqModal(true); }

  function openEdit(t: Tank) {
    setEqForm({
      name: t.name, type: t.type,
      capacity_bbl: t.capacity_bbl != null ? String(t.capacity_bbl) : "",
      notes: t.notes ?? "",
      grid_width: String(t.grid_width),
      grid_height: String(t.grid_height),
    });
    setEditingId(t.id);
    setShowEqModal(true);
  }

  async function handleEqSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    setEqSubmitting(true);
    try {
      const payload = {
        name: eqForm.name, type: eqForm.type,
        capacity_bbl: eqForm.capacity_bbl ? parseFloat(eqForm.capacity_bbl) : null,
        notes: eqForm.notes || null,
        grid_width:  parseInt(eqForm.grid_width)  || 2,
        grid_height: parseInt(eqForm.grid_height) || 3,
      };
      const res = editingId
        ? await fetch(`/api/production/tanks/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch("/api/production/tanks",              { method: "POST",  headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowEqModal(false);
      await onRefresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setEqSubmitting(false);
    }
  }

  async function handleDeleteEq(id: string, name: string) {
    if (!confirm(`Delete "${name}"?`)) return;
    await fetch(`/api/production/tanks/${id}`, { method: "DELETE" });
    await onRefresh();
  }

  // ── Batch assign/release ───────────────────────────────────────────────────

  function openAssign(tankId: string) {
    setAssignTankId(tankId);
    setAssignBatchId(unassignedBatches[0]?.id ?? "");
    setAssignNotes("");
    setShowAssignModal(true);
  }

  async function handleAssignSubmit(ev: React.FormEvent) {
    ev.preventDefault();
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

  // ── Render ─────────────────────────────────────────────────────────────────

  const draggingTank = dragging ? tanks.find((t) => t.id === dragging.id) : null;

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">Brew Status</h2>
          <p className="text-sm text-zinc-500 mt-0.5">
            {editMode ? "Edit mode — drag equipment to reposition" : "Lock mode — assign batches to equipment"}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setEditMode((v) => !v)}
            className={`px-3 py-1.5 text-sm font-medium rounded border transition-colors ${
              editMode
                ? "border-amber-600 bg-amber-900/30 text-amber-300 hover:bg-amber-900/50"
                : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {editMode ? "🔓 Editing Layout" : "🔒 Edit Layout"}
          </button>
          {editMode && (
            <button onClick={openNew} className="btn-amber">+ Add Equipment</button>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-2 mb-3">
        {EQ_TYPES.map(([type, meta]) => (
          <span key={type} className={`text-xs px-2 py-px rounded border ${meta.badge}`}>
            {meta.label}
          </span>
        ))}
      </div>

      {/* Grid */}
      <div
        className="overflow-auto rounded-lg border border-zinc-800 mb-6"
        style={{ maxHeight: "72vh" }}
      >
        <div
          ref={gridRef}
          className="relative"
          style={{
            width:  GRID_COLS * CELL,
            height: GRID_ROWS * CELL,
            backgroundImage: [
              `linear-gradient(to right, rgba(63,63,70,0.22) 1px, transparent 1px)`,
              `linear-gradient(to bottom, rgba(63,63,70,0.22) 1px, transparent 1px)`,
            ].join(","),
            backgroundSize: `${CELL}px ${CELL}px`,
          }}
          onDragOver={editMode ? onGridDragOver : undefined}
          onDrop={editMode ? onGridDrop : undefined}
          onDragLeave={() => setDropPreview(null)}
        >
          {/* Placed equipment */}
          {placed.map((tank) => {
            const eq       = EQ[tank.type];
            const assign   = assignmentByTank[tank.id];
            const batch    = assign?.brew_batches;
            const isDraggingThis = dragging?.id === tank.id;
            const pixW     = tank.grid_width  * CELL - GAP * 2;
            const pixH     = tank.grid_height * CELL - GAP * 2;
            const compact  = pixW < 100 || pixH < 90;
            const tiny     = pixW < 60  || pixH < 60;

            return (
              <div
                key={tank.id}
                draggable={editMode}
                onDragStart={editMode ? (e) => onDragStart(e, tank) : undefined}
                onDragEnd={() => { setDragging(null); setDropPreview(null); }}
                className={`absolute flex flex-col overflow-hidden rounded border transition-opacity select-none ${
                  isDraggingThis ? "opacity-30" : "opacity-100"
                } ${editMode ? "cursor-grab active:cursor-grabbing" : ""} ${eq.border}`}
                style={{
                  ...eqStyle(tank),
                  background: "rgba(9,9,11,0.85)",
                }}
              >
                {/* Header */}
                <div className={`shrink-0 px-2 py-1 flex items-center justify-between gap-1 ${eq.headerBg}`}>
                  <span className="font-semibold text-zinc-100 truncate" style={{ fontSize: tiny ? 9 : compact ? 10 : 11 }}>
                    {tank.name}
                  </span>
                  {!tiny && (
                    <span className={`text-xs px-1 py-px rounded border shrink-0 ${eq.badge}`} style={{ fontSize: 9 }}>
                      {eq.label}
                    </span>
                  )}
                </div>

                {/* Body — only if not tiny */}
                {!tiny && (
                  <div className="flex-1 min-h-0 px-2 py-1 flex flex-col gap-0.5">
                    {tank.capacity_bbl && !compact && (
                      <p className="text-zinc-600" style={{ fontSize: 9 }}>{tank.capacity_bbl} BBL</p>
                    )}
                    {batch ? (
                      <>
                        <p className="text-zinc-200 font-medium leading-tight truncate" style={{ fontSize: compact ? 9 : 10 }}>
                          {batch.beer_name}
                        </p>
                        <p className="text-zinc-500 font-mono" style={{ fontSize: 9 }}>{batch.batch_number ?? "—"}</p>
                        {!compact && <StatusBadge status={batch.status} />}
                        {!compact && assign && (
                          <p className="text-zinc-600" style={{ fontSize: 9 }}>since {fmtDate(assign.assigned_at)}</p>
                        )}
                        {!editMode && (
                          <button
                            onClick={() => handleRelease(assign!.id)}
                            onMouseDown={(e) => e.stopPropagation()}
                            className="mt-auto text-xs text-zinc-600 hover:text-red-400 border border-zinc-700 hover:border-red-800 px-1.5 rounded transition-colors self-start"
                            style={{ fontSize: 9 }}
                          >
                            Release
                          </button>
                        )}
                      </>
                    ) : (
                      <div className="flex-1 flex flex-col items-center justify-center gap-1">
                        <p className="text-zinc-700" style={{ fontSize: 9 }}>Empty</p>
                        {!editMode && unassignedBatches.length > 0 && (
                          <button
                            onClick={() => openAssign(tank.id)}
                            onMouseDown={(e) => e.stopPropagation()}
                            className="text-amber-600 hover:text-amber-400 border border-amber-900 hover:border-amber-700 px-1.5 rounded transition-colors"
                            style={{ fontSize: 9 }}
                          >
                            Assign
                          </button>
                        )}
                      </div>
                    )}
                    {editMode && (
                      <div className="mt-auto flex gap-1.5">
                        <button onClick={() => openEdit(tank)} onMouseDown={(e) => e.stopPropagation()} className="text-zinc-600 hover:text-zinc-300 transition-colors" style={{ fontSize: 9 }}>Edit</button>
                        <button onClick={() => removeFromGrid(tank.id)} onMouseDown={(e) => e.stopPropagation()} className="text-zinc-600 hover:text-amber-400 transition-colors" style={{ fontSize: 9 }}>Unplace</button>
                        {!assign && <button onClick={() => handleDeleteEq(tank.id, tank.name)} onMouseDown={(e) => e.stopPropagation()} className="text-zinc-600 hover:text-red-400 transition-colors" style={{ fontSize: 9 }}>Del</button>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Drop preview ghost */}
          {dropPreview && draggingTank && (
            <div
              className={`absolute pointer-events-none z-20 rounded border-2 border-dashed ${
                dropPreview.valid
                  ? "border-amber-400 bg-amber-900/15"
                  : "border-red-500 bg-red-900/15"
              }`}
              style={{
                left:   dropPreview.col * CELL + GAP,
                top:    dropPreview.row * CELL + GAP,
                width:  draggingTank.grid_width  * CELL - GAP * 2,
                height: draggingTank.grid_height * CELL - GAP * 2,
              }}
            />
          )}
        </div>
      </div>

      {/* Unplaced equipment */}
      {unplaced.length > 0 && (
        <div
          className={`mb-6 p-3 rounded-lg border border-dashed transition-colors ${
            dragging ? "border-zinc-500 bg-zinc-900/40" : "border-zinc-700"
          }`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onUnplacedDrop}
        >
          <p className="text-xs text-zinc-500 font-medium uppercase tracking-wide mb-2">
            Unplaced Equipment {editMode ? "— drag onto the grid to position" : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            {unplaced.map((tank) => {
              const eq = EQ[tank.type];
              return (
                <div
                  key={tank.id}
                  draggable={editMode}
                  onDragStart={editMode ? (e) => onDragStart(e, tank) : undefined}
                  onDragEnd={() => { setDragging(null); setDropPreview(null); }}
                  className={`rounded border px-3 py-2 bg-zinc-900 ${eq.border} ${
                    editMode ? "cursor-grab active:cursor-grabbing" : ""
                  } ${dragging?.id === tank.id ? "opacity-40" : ""}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">{tank.name}</span>
                    <span className={`text-xs px-1.5 py-px rounded border ${eq.badge}`}>{eq.label}</span>
                    {tank.capacity_bbl && <span className="text-xs text-zinc-600">{tank.capacity_bbl} BBL</span>}
                    <span className="text-xs text-zinc-700">{tank.grid_width}×{tank.grid_height}</span>
                  </div>
                  {editMode && (
                    <div className="flex gap-3 mt-1">
                      <button onClick={() => openEdit(tank)} onMouseDown={(e) => e.stopPropagation()} className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">Edit</button>
                      <button onClick={() => handleDeleteEq(tank.id, tank.name)} onMouseDown={(e) => e.stopPropagation()} className="text-xs text-zinc-600 hover:text-red-400 transition-colors">Delete</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Unassigned batches */}
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

      {/* Add/edit equipment modal */}
      {showEqModal && (
        <Modal title={editingId ? "Edit Equipment" : "Add Equipment"} onClose={() => setShowEqModal(false)}>
          <form onSubmit={handleEqSubmit} className="space-y-4">
            <Field label="Name" required>
              <input className="inp" placeholder="e.g. FV-1, Brewhouse A" value={eqForm.name} required
                onChange={(e) => setEqForm((f) => ({ ...f, name: e.target.value }))} />
            </Field>
            <Field label="Type" required>
              <div className="grid grid-cols-3 gap-2">
                {EQ_TYPES.map(([type, meta]) => (
                  <button key={type} type="button"
                    onClick={() => setEqForm((f) => ({
                      ...f, type,
                      grid_width:  String(meta.defaultW),
                      grid_height: String(meta.defaultH),
                    }))}
                    className={`px-2 py-2 rounded border text-xs font-medium transition-colors ${
                      eqForm.type === type
                        ? "border-amber-600 bg-amber-900/30 text-amber-300"
                        : "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-500"
                    }`}
                  >
                    {meta.label}
                  </button>
                ))}
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Capacity (BBL)">
                <input type="number" step="0.5" min="0" className="inp" value={eqForm.capacity_bbl}
                  onChange={(e) => setEqForm((f) => ({ ...f, capacity_bbl: e.target.value }))} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Width (cells)">
                  <input type="number" min="1" max="10" className="inp" value={eqForm.grid_width}
                    onChange={(e) => setEqForm((f) => ({ ...f, grid_width: e.target.value }))} />
                </Field>
                <Field label="Height (cells)">
                  <input type="number" min="1" max="10" className="inp" value={eqForm.grid_height}
                    onChange={(e) => setEqForm((f) => ({ ...f, grid_height: e.target.value }))} />
                </Field>
              </div>
            </div>
            <Field label="Notes">
              <input className="inp" value={eqForm.notes}
                onChange={(e) => setEqForm((f) => ({ ...f, notes: e.target.value }))} />
            </Field>
            <p className="text-xs text-zinc-600">
              Grid preview: {parseInt(eqForm.grid_width) || 2}×{parseInt(eqForm.grid_height) || 3} cells
              = {(parseInt(eqForm.grid_width) || 2) * CELL}×{(parseInt(eqForm.grid_height) || 3) * CELL}px
            </p>
            <ModalActions submitting={eqSubmitting} onCancel={() => setShowEqModal(false)}
              label={editingId ? "Save Changes" : "Add Equipment"} />
          </form>
        </Modal>
      )}

      {showAssignModal && (
        <Modal title="Assign Batch to Equipment" onClose={() => setShowAssignModal(false)}>
          <form onSubmit={handleAssignSubmit} className="space-y-4">
            <Field label="Batch" required>
              <select className="inp" value={assignBatchId} required
                onChange={(e) => setAssignBatchId(e.target.value)}>
                <option value="">— select —</option>
                {unassignedBatches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.batch_number ?? "?"} · {b.beer_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Notes">
              <input className="inp" value={assignNotes}
                onChange={(e) => setAssignNotes(e.target.value)} />
            </Field>
            <ModalActions submitting={assignSubmitting} onCancel={() => setShowAssignModal(false)} label="Assign" />
          </form>
        </Modal>
      )}
    </>
  );
}
