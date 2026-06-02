"use client";

import React, { useState, useEffect } from "react";
import { Tank, BatchTankAssignment, BrewBatch, PackagingItem, UNCONSTRAINED_TANK_TYPES } from "../types";
import { StatusBadge, Modal, Field, ModalActions } from "./shared";
import { EQ, EQ_TYPES } from "../equipmentMeta";
import { GRID_CELL_PX as CELL, GRID_COLS, GRID_ROWS, GRID_GAP_PX as GAP } from "@/lib/constants/production";
import { fmtDate, fmtBbl } from "@/lib/utils/formatting";
import TransferModal from "./TransferModal";
import { useTankDragDrop } from "../hooks/useTankDragDrop";
import { useEquipmentCrud } from "../hooks/useEquipmentCrud";
import { useBatchAssign } from "../hooks/useBatchAssign";

function eqStyle(t: Tank): React.CSSProperties {
  return {
    position: "absolute",
    left:   (t.grid_col ?? 0) * CELL + GAP,
    top:    (t.grid_row ?? 0) * CELL + GAP,
    width:  t.grid_width  * CELL - GAP * 2,
    height: t.grid_height * CELL - GAP * 2,
  };
}

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
  const [transferTankId, setTransferTankId] = useState<string | null>(null);
  const [packaging, setPackaging] = useState<PackagingItem[]>([]);

  useEffect(() => {
    fetch("/api/production/packaging").then((r) => r.ok ? r.json() : []).then(setPackaging);
  }, []);

  const assignmentByTank   = Object.fromEntries(assignments.map((a) => [a.tank_id, a])) as Record<string, BatchTankAssignment | undefined>;
  const assignedBatchIds   = new Set(assignments.map((a) => a.batch_id));
  const unassignedBatches  = batches.filter((b) => b.status !== "archived" && !assignedBatchIds.has(b.id));

  const placed   = tanks.filter((t) => t.grid_row != null && t.grid_col != null);
  const unplaced = tanks.filter((t) => t.grid_row == null || t.grid_col == null);

  const transferTank       = transferTankId ? tanks.find((t) => t.id === transferTankId) ?? null : null;
  const transferAssignment = transferTankId ? assignmentByTank[transferTankId] : null;
  const transferBatch      = transferAssignment
    ? batches.find((b) => b.id === transferAssignment.batch_id) ?? null
    : null;

  const drag   = useTankDragDrop(tanks, onRefresh);
  const eqCrud = useEquipmentCrud(onRefresh);
  const assign = useBatchAssign(unassignedBatches, onRefresh);

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
            <button onClick={eqCrud.openNew} className="btn-amber">+ Add Equipment</button>
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
      <div className="overflow-auto rounded-lg border border-zinc-800 mb-6" style={{ maxHeight: "72vh" }}>
        <div
          ref={drag.gridRef}
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
          onDragOver={editMode ? drag.onGridDragOver : undefined}
          onDrop={editMode ? drag.onGridDrop : undefined}
          onDragLeave={() => drag.clearDrag()}
        >
          {placed.map((tank) => {
            const eq             = EQ[tank.type];
            if (!eq) return null;
            const assignment     = assignmentByTank[tank.id];
            const batch          = assignment?.brew_batches;
            const isDraggingThis = drag.dragging?.id === tank.id;
            const pixW           = tank.grid_width  * CELL - GAP * 2;
            const pixH           = tank.grid_height * CELL - GAP * 2;
            const compact        = pixW < 100 || pixH < 90;
            const tiny           = pixW < 60  || pixH < 60;
            const isUnconstrained = UNCONSTRAINED_TANK_TYPES.includes(tank.type);

            return (
              <div
                key={tank.id}
                draggable={editMode}
                onDragStart={editMode ? (e) => drag.onDragStart(e, tank) : undefined}
                onDragEnd={drag.clearDrag}
                className={`absolute flex flex-col overflow-hidden rounded border transition-opacity select-none ${
                  isDraggingThis ? "opacity-30" : "opacity-100"
                } ${editMode ? "cursor-grab active:cursor-grabbing" : ""} ${eq.border}`}
                style={{ ...eqStyle(tank), background: "rgba(9,9,11,0.85)" }}
              >
                {/* Header — name on first line, type badge on second */}
                <div className={`shrink-0 px-2 py-1 flex flex-col gap-0.5 ${eq.headerBg}`}>
                  <span className="font-semibold text-zinc-100 leading-tight" style={{ fontSize: tiny ? 9 : compact ? 10 : 11 }}>
                    {tank.name}
                  </span>
                  {!tiny && (
                    <span className={`self-start text-xs px-1 py-px rounded border ${eq.badge}`} style={{ fontSize: 8 }}>
                      {eq.label}
                    </span>
                  )}
                </div>

                {/* Body */}
                {!tiny && (
                  <div className="flex-1 min-h-0 px-2 py-1 flex flex-col gap-0.5">
                    {/* Capacity / fill line */}
                    {!compact && !isUnconstrained && (
                      <p className="text-zinc-600" style={{ fontSize: 9 }}>
                        {batch
                          ? `${Number(batch.volume_bbl).toFixed(1)} BBL${tank.capacity_bbl ? ` / ${tank.capacity_bbl} BBL` : ""}`
                          : tank.capacity_bbl ? `${tank.capacity_bbl} BBL` : ""}
                      </p>
                    )}

                    {batch ? (
                      <>
                        <p className="text-zinc-200 font-medium leading-tight break-words whitespace-normal" style={{ fontSize: compact ? 9 : 10 }}>
                          {batch.beer_name}
                        </p>
                        <p className="text-zinc-500 font-mono" style={{ fontSize: 9 }}>{batch.batch_number ?? "—"}</p>
                        {!compact && <StatusBadge status={batch.status} />}
                        {!compact && assignment && (
                          <p className="text-zinc-600" style={{ fontSize: 9 }}>since {fmtDate(assignment.assigned_at)}</p>
                        )}
                        {!editMode && (
                          <div className="mt-auto flex gap-1.5 flex-wrap">
                            <button
                              onClick={() => setTransferTankId(tank.id)}
                              onMouseDown={(e) => e.stopPropagation()}
                              className="text-xs text-amber-700 hover:text-amber-400 border border-amber-900 hover:border-amber-700 px-1.5 rounded transition-colors"
                              style={{ fontSize: 9 }}
                            >
                              Transfer
                            </button>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="flex-1 flex flex-col items-center justify-center gap-1">
                        <p className="text-zinc-700" style={{ fontSize: 9 }}>Empty</p>
                        {!editMode && !isUnconstrained && unassignedBatches.length > 0 && (
                          <button
                            onClick={() => assign.openAssign(tank.id)}
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
                        <button onClick={() => eqCrud.openEdit(tank)} onMouseDown={(e) => e.stopPropagation()} className="text-zinc-600 hover:text-zinc-300 transition-colors" style={{ fontSize: 9 }}>Edit</button>
                        <button onClick={() => drag.removeFromGrid(tank.id)} onMouseDown={(e) => e.stopPropagation()} className="text-zinc-600 hover:text-amber-400 transition-colors" style={{ fontSize: 9 }}>Unplace</button>
                        {!assignment && <button onClick={() => eqCrud.handleDeleteEq(tank.id, tank.name)} onMouseDown={(e) => e.stopPropagation()} className="text-zinc-600 hover:text-red-400 transition-colors" style={{ fontSize: 9 }}>Del</button>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Drop preview */}
          {drag.dropPreview && drag.draggingTank && (
            <div
              className={`absolute pointer-events-none z-20 rounded border-2 border-dashed ${
                drag.dropPreview.valid ? "border-amber-400 bg-amber-900/15" : "border-red-500 bg-red-900/15"
              }`}
              style={{
                left:   drag.dropPreview.col * CELL + GAP,
                top:    drag.dropPreview.row * CELL + GAP,
                width:  drag.draggingTank.grid_width  * CELL - GAP * 2,
                height: drag.draggingTank.grid_height * CELL - GAP * 2,
              }}
            />
          )}
        </div>
      </div>

      {/* Unplaced equipment */}
      {unplaced.length > 0 && (
        <div
          className={`mb-6 p-3 rounded-lg border border-dashed transition-colors ${
            drag.dragging ? "border-zinc-500 bg-zinc-900/40" : "border-zinc-700"
          }`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={drag.onUnplacedDrop}
        >
          <p className="text-xs text-zinc-500 font-medium uppercase tracking-wide mb-2">
            Unplaced Equipment {editMode ? "— drag onto the grid to position" : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            {unplaced.map((tank) => {
              const eq = EQ[tank.type];
              if (!eq) return null;
              return (
                <div
                  key={tank.id}
                  draggable={editMode}
                  onDragStart={editMode ? (e) => drag.onDragStart(e, tank) : undefined}
                  onDragEnd={drag.clearDrag}
                  className={`rounded border px-3 py-2 bg-zinc-900 ${eq.border} ${
                    editMode ? "cursor-grab active:cursor-grabbing" : ""
                  } ${drag.dragging?.id === tank.id ? "opacity-40" : ""}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">{tank.name}</span>
                    <span className={`text-xs px-1.5 py-px rounded border ${eq.badge}`}>{eq.label}</span>
                    {tank.capacity_bbl && <span className="text-xs text-zinc-600">{tank.capacity_bbl} BBL</span>}
                    <span className="text-xs text-zinc-700">{tank.grid_width}×{tank.grid_height}</span>
                  </div>
                  {editMode && (
                    <div className="flex gap-3 mt-1">
                      <button onClick={() => eqCrud.openEdit(tank)} onMouseDown={(e) => e.stopPropagation()} className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">Edit</button>
                      <button onClick={() => eqCrud.handleDeleteEq(tank.id, tank.name)} onMouseDown={(e) => e.stopPropagation()} className="text-xs text-zinc-600 hover:text-red-400 transition-colors">Delete</button>
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
      {eqCrud.showEqModal && (
        <Modal title={eqCrud.editingId ? "Edit Equipment" : "Add Equipment"} onClose={() => eqCrud.setShowEqModal(false)}>
          <form onSubmit={eqCrud.handleEqSubmit} className="space-y-4">
            <Field label="Name" required>
              <input className="inp" placeholder="e.g. FV-1, Brewhouse A" value={eqCrud.eqForm.name} required
                onChange={(e) => eqCrud.setEqForm((f) => ({ ...f, name: e.target.value }))} />
            </Field>
            <Field label="Type" required>
              <div className="grid grid-cols-3 gap-2">
                {EQ_TYPES.map(([type, meta]) => (
                  <button key={type} type="button"
                    onClick={() => eqCrud.setEqForm((f) => ({
                      ...f, type,
                      grid_width:  String(meta.defaultW),
                      grid_height: String(meta.defaultH),
                      capacity_bbl: UNCONSTRAINED_TANK_TYPES.includes(type) ? "" : f.capacity_bbl,
                    }))}
                    className={`px-2 py-2 rounded border text-xs font-medium transition-colors ${
                      eqCrud.eqForm.type === type
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
                <input
                  type="number" step="0.5" min="0" className="inp"
                  disabled={UNCONSTRAINED_TANK_TYPES.includes(eqCrud.eqForm.type)}
                  placeholder={UNCONSTRAINED_TANK_TYPES.includes(eqCrud.eqForm.type) ? "N/A" : ""}
                  value={eqCrud.eqForm.capacity_bbl}
                  onChange={(e) => eqCrud.setEqForm((f) => ({ ...f, capacity_bbl: e.target.value }))}
                  style={UNCONSTRAINED_TANK_TYPES.includes(eqCrud.eqForm.type) ? { opacity: 0.35, cursor: "not-allowed" } : {}}
                />
                {UNCONSTRAINED_TANK_TYPES.includes(eqCrud.eqForm.type) && (
                  <p className="text-xs text-zinc-600 mt-0.5">No capacity constraint for this type</p>
                )}
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Width (cells)">
                  <input type="number" min="1" max="10" className="inp" value={eqCrud.eqForm.grid_width}
                    onChange={(e) => eqCrud.setEqForm((f) => ({ ...f, grid_width: e.target.value }))} />
                </Field>
                <Field label="Height (cells)">
                  <input type="number" min="1" max="10" className="inp" value={eqCrud.eqForm.grid_height}
                    onChange={(e) => eqCrud.setEqForm((f) => ({ ...f, grid_height: e.target.value }))} />
                </Field>
              </div>
            </div>
            <Field label="Notes">
              <input className="inp" value={eqCrud.eqForm.notes}
                onChange={(e) => eqCrud.setEqForm((f) => ({ ...f, notes: e.target.value }))} />
            </Field>
            <p className="text-xs text-zinc-600">
              Grid preview: {parseInt(eqCrud.eqForm.grid_width) || 2}×{parseInt(eqCrud.eqForm.grid_height) || 3} cells
              = {(parseInt(eqCrud.eqForm.grid_width) || 2) * CELL}×{(parseInt(eqCrud.eqForm.grid_height) || 3) * CELL}px
            </p>
            <ModalActions submitting={eqCrud.eqSubmitting} onCancel={() => eqCrud.setShowEqModal(false)}
              label={eqCrud.editingId ? "Save Changes" : "Add Equipment"} />
          </form>
        </Modal>
      )}

      {/* Assign batch modal */}
      {assign.showAssignModal && (
        <Modal title="Assign Batch to Equipment" onClose={() => assign.setShowAssignModal(false)}>
          <form onSubmit={assign.handleAssignSubmit} className="space-y-4">
            <Field label="Batch" required>
              <select className="inp" value={assign.assignBatchId} required
                onChange={(e) => assign.setAssignBatchId(e.target.value)}>
                <option value="">— select —</option>
                {unassignedBatches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.batch_number ?? "?"} · {b.beer_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Notes">
              <input className="inp" value={assign.assignNotes}
                onChange={(e) => assign.setAssignNotes(e.target.value)} />
            </Field>
            <ModalActions submitting={assign.assignSubmitting} onCancel={() => assign.setShowAssignModal(false)} label="Assign" />
          </form>
        </Modal>
      )}

      {/* Transfer modal */}
      {transferTankId && transferTank && transferBatch && (
        <TransferModal
          batch={transferBatch}
          fromTank={transferTank}
          allTanks={tanks}
          packaging={packaging}
          onClose={() => setTransferTankId(null)}
          onDone={onRefresh}
        />
      )}
    </>
  );
}
