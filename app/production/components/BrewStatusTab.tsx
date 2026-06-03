"use client";

import React, { useState, useEffect } from "react";
import { Equipment, BatchTankAssignment, BrewBatch, BatchTransfer, PackagingItem, Recipe, UNCONSTRAINED_EQUIPMENT_TYPES } from "../types";
import { BREWHOUSE_BBL, StatusBadge, Modal, Field, ModalActions } from "./shared";
import { EQ, EQ_TYPES } from "../equipmentMeta";
import { GRID_CELL_PX as CELL, GRID_COLS, GRID_ROWS, GRID_GAP_PX as GAP } from "@/lib/constants/production";
import { fmtDate, fmtBbl } from "@/lib/utils/formatting";
import TransferModal from "./TransferModal";
import { useTankDragDrop } from "../hooks/useTankDragDrop";
import { useEquipmentCrud } from "../hooks/useEquipmentCrud";
import { useBatchAssign } from "../hooks/useBatchAssign";

const GRID_COLS_KEY = "brewConsole_gridCols";
const GRID_ROWS_KEY = "brewConsole_gridRows";


const BATCH_EMPTY = {
  recipe_id: "",
  beer_name: "",
  planned_brew_date: new Date().toISOString().slice(0, 10),
  turns: "1",
  notes: "",
};

const TANK_TYPES = new Set(["fermenter", "brite", "brewhouse"]);

function eqStyle(t: Equipment, cell: number): React.CSSProperties {
  return {
    position: "absolute",
    left:   (t.grid_col ?? 0) * cell + GAP,
    top:    (t.grid_row ?? 0) * cell + GAP,
    width:  t.grid_width  * cell - GAP * 2,
    height: t.grid_height * cell - GAP * 2,
  };
}

export default function BrewStatusTab({
  tanks,
  assignments,
  batches,
  transfers,
  recipes,
  onRefresh,
  onBatchCreated,
}: {
  tanks: Equipment[];
  assignments: BatchTankAssignment[];
  batches: BrewBatch[];
  transfers: BatchTransfer[];
  recipes: Recipe[];
  onRefresh: () => Promise<void>;
  onBatchCreated: () => Promise<void>;
}) {
  const [editMode, setEditMode] = useState(false);
  const [transferTankId, setTransferTankId] = useState<string | null>(null);
  const [packaging, setPackaging] = useState<PackagingItem[]>([]);
  const [gridCols, setGridCols] = useState(() => {
    if (typeof window === "undefined") return GRID_COLS;
    return parseInt(localStorage.getItem(GRID_COLS_KEY) ?? String(GRID_COLS)) || GRID_COLS;
  });
  const [gridRows, setGridRows] = useState(() => {
    if (typeof window === "undefined") return GRID_ROWS;
    return parseInt(localStorage.getItem(GRID_ROWS_KEY) ?? String(GRID_ROWS)) || GRID_ROWS;
  });

  // New batch modal state
  const [showNewBatch, setShowNewBatch] = useState(false);
  const [batchForm, setBatchForm] = useState(BATCH_EMPTY);
  const [batchSubmitting, setBatchSubmitting] = useState(false);

  function handleRecipeChange(recipeId: string) {
    const r = recipes.find((r) => r.id === recipeId);
    setBatchForm((f) => ({
      ...f,
      recipe_id: recipeId,
      beer_name: r?.beer_name ?? f.beer_name,
      turns: "1",
    }));
  }

  async function handleNewBatchSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!batchForm.recipe_id) { alert("Please select a recipe."); return; }
    const recipe = recipes.find((r) => r.id === batchForm.recipe_id);
    const turns = parseInt(batchForm.turns) || 1;
    const volume_bbl = recipe?.expected_yield_bbl != null ? recipe.expected_yield_bbl * turns : null;
    if (!volume_bbl) { alert("Selected recipe has no expected yield. Set it in the Recipes tab first."); return; }
    setBatchSubmitting(true);
    try {
      const payload = {
        recipe_id:         batchForm.recipe_id,
        beer_name:         batchForm.beer_name,
        planned_brew_date: batchForm.planned_brew_date,
        volume_bbl,
        turns,
        notes:             batchForm.notes || null,
      };
      const res = await fetch("/api/production/batches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowNewBatch(false);
      setBatchForm(BATCH_EMPTY);
      await onBatchCreated();
      await onRefresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error saving batch");
    } finally {
      setBatchSubmitting(false);
    }
  }

  useEffect(() => {
    fetch("/api/production/packaging").then((r) => r.ok ? r.json() : []).then(setPackaging);
  }, []);

  useEffect(() => { localStorage.setItem(GRID_COLS_KEY, String(gridCols)); }, [gridCols]);
  useEffect(() => { localStorage.setItem(GRID_ROWS_KEY, String(gridRows)); }, [gridRows]);

  const assignmentByTank   = Object.fromEntries(assignments.map((a) => [a.tank_id, a])) as Record<string, BatchTankAssignment | undefined>;
  const assignedBatchIds   = new Set(assignments.map((a) => a.batch_id));
  const unassignedBatches  = batches.filter((b) => b.status !== "archived" && !assignedBatchIds.has(b.id));
  const planningBatches    = batches.filter((b) => b.status === "planning")
    .sort((a, b) => new Date(b.planned_brew_date).getTime() - new Date(a.planned_brew_date).getTime());
  const batchById          = Object.fromEntries(batches.map((b) => [b.id, b]));

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

  const cell = CELL; // could wire to a slider later

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-end gap-2 mb-4">
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

      {/* Unplaced equipment — only visible in edit mode */}
      {editMode && unplaced.length > 0 && (
        <div
          className={`mb-4 p-3 rounded-lg border border-dashed transition-colors ${
            drag.dragging ? "border-zinc-500 bg-zinc-900/40" : "border-zinc-700"
          }`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={drag.onUnplacedDrop}
        >
          <p className="text-xs text-zinc-500 font-medium uppercase tracking-wide mb-2">
            Unplaced Equipment — drag onto the grid to position
          </p>
          <div className="flex flex-wrap gap-2">
            {unplaced.map((tank) => {
              const eq = EQ[tank.type];
              if (!eq) return null;
              return (
                <div
                  key={tank.id}
                  draggable
                  onDragStart={(e) => drag.onDragStart(e, tank)}
                  onDragEnd={drag.clearDrag}
                  className={`rounded border px-3 py-2 bg-zinc-900 ${eq.border} cursor-grab active:cursor-grabbing ${
                    drag.dragging?.id === tank.id ? "opacity-40" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">{tank.name}</span>
                    <span className={`text-xs px-1.5 py-px rounded border ${eq.badge}`}>{eq.label}</span>
                    {tank.capacity_bbl && <span className="text-xs text-zinc-600">{tank.capacity_bbl} BBL</span>}
                    <span className="text-xs text-zinc-700">{tank.grid_width}×{tank.grid_height}</span>
                  </div>
                  <div className="flex gap-3 mt-1">
                    <button onClick={() => eqCrud.openEdit(tank)} onMouseDown={(e) => e.stopPropagation()} className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">Edit</button>
                    <button onClick={() => eqCrud.handleDeleteEq(tank.id, tank.name)} onMouseDown={(e) => e.stopPropagation()} className="text-xs text-zinc-600 hover:text-red-400 transition-colors">Delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Grid size controls — only in edit mode */}
      {editMode && (
        <div className="flex items-center gap-4 mb-3 text-xs text-zinc-500">
          <span className="font-medium text-zinc-400">Grid size:</span>
          <label className="flex items-center gap-1.5">
            Cols
            <input type="number" min={8} max={40} value={gridCols} onChange={(e) => setGridCols(Math.max(8, Math.min(40, parseInt(e.target.value) || GRID_COLS)))}
              className="w-16 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-200 text-xs" />
          </label>
          <label className="flex items-center gap-1.5">
            Rows
            <input type="number" min={4} max={32} value={gridRows} onChange={(e) => setGridRows(Math.max(4, Math.min(32, parseInt(e.target.value) || GRID_ROWS)))}
              className="w-16 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-200 text-xs" />
          </label>
          <span className="text-zinc-700">{gridCols * cell}×{gridRows * cell}px</span>
        </div>
      )}

      {/* Grid */}
      <div className="overflow-auto rounded-lg border border-zinc-800 mb-6" style={{ maxHeight: "72vh" }}>
        <div
          ref={drag.gridRef}
          className="relative"
          style={{
            width:  gridCols * cell,
            height: gridRows * cell,
            backgroundImage: [
              `linear-gradient(to right, rgba(63,63,70,0.22) 1px, transparent 1px)`,
              `linear-gradient(to bottom, rgba(63,63,70,0.22) 1px, transparent 1px)`,
            ].join(","),
            backgroundSize: `${cell}px ${cell}px`,
          }}
          onDragOver={editMode ? drag.onGridDragOver : undefined}
          onDrop={editMode ? drag.onGridDrop : undefined}
          onDragLeave={() => drag.clearDrag()}
        >
          {placed.map((tank) => {
            const eq          = EQ[tank.type];
            if (!eq) return null;
            const assignment  = assignmentByTank[tank.id];
            const batch       = assignment?.brew_batches;
            const isDragging  = drag.dragging?.id === tank.id;
            const isTank      = TANK_TYPES.has(tank.type);
            const isColdStorage = tank.type === "cold_storage";
            const isBacklog   = tank.type === "backlog";
            const isUnconstrained = UNCONSTRAINED_EQUIPMENT_TYPES.includes(tank.type);

            // Transfers to this cold storage tank
            const coldTransfers = isColdStorage
              ? transfers.filter((tr) => tr.to_tank_id === tank.id && (tr.transfer_type === "kegging" || tr.transfer_type === "canning"))
              : [];

            const style = eqStyle(tank, cell);
            const pixW  = tank.grid_width  * cell - GAP * 2;
            const pixH  = tank.grid_height * cell - GAP * 2;
            const tiny  = pixW < 56 || pixH < 56;

            return (
              <div
                key={tank.id}
                draggable={editMode}
                onDragStart={editMode ? (e) => drag.onDragStart(e, tank) : undefined}
                onDragEnd={drag.clearDrag}
                className={`absolute flex flex-col rounded border transition-opacity select-none ${
                  isDragging ? "opacity-30" : "opacity-100"
                } ${editMode ? "cursor-grab active:cursor-grabbing" : ""} ${eq.border}`}
                style={{ ...style, background: "rgba(9,9,11,0.88)" }}
              >
                {/* Header: name + type badge on one line */}
                <div className={`shrink-0 px-1.5 py-1 flex items-center justify-between gap-1 min-w-0 ${eq.headerBg}`}>
                  <span className="font-semibold text-zinc-100 truncate leading-tight" style={{ fontSize: tiny ? 8 : 10 }}>
                    {tank.name}
                  </span>
                  {!tiny && (
                    <span className={`shrink-0 px-1 py-px rounded border leading-none ${eq.badge}`} style={{ fontSize: 7 }}>
                      {eq.label}
                    </span>
                  )}
                </div>

                {/* Body */}
                {!tiny && (
                  <div className="flex-1 min-h-0 overflow-y-auto px-1.5 py-1 flex flex-col gap-0.5">

                    {/* === Backlog === */}
                    {isBacklog && (
                      <>
                        {planningBatches.length === 0 ? (
                          <p className="text-zinc-700 text-center mt-1" style={{ fontSize: 9 }}>No planned batches</p>
                        ) : (
                          <div className="space-y-0.5">
                            {planningBatches.map((b) => (
                              <div key={b.id} className="flex items-baseline gap-1 leading-tight">
                                {b.batch_number && (
                                  <span className="text-zinc-600 font-mono shrink-0" style={{ fontSize: 8 }}>#{b.batch_number}</span>
                                )}
                                <span className="text-zinc-300 truncate" style={{ fontSize: 9 }}>{b.beer_name}</span>
                                <span className="text-zinc-600 shrink-0" style={{ fontSize: 8 }}>{fmtDate(b.planned_brew_date)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {!editMode && (
                          <div className="mt-auto pt-1">
                            <button
                              onClick={() => { setBatchForm(BATCH_EMPTY); setShowNewBatch(true); }}
                              onMouseDown={(e) => e.stopPropagation()}
                              className="text-amber-600 hover:text-amber-400 border border-amber-900 hover:border-amber-700 px-1.5 rounded transition-colors"
                              style={{ fontSize: 9 }}
                            >
                              + New Batch
                            </button>
                          </div>
                        )}
                      </>
                    )}

                    {/* === Cold Storage === */}
                    {isColdStorage && (
                      <>
                        {coldTransfers.length === 0 ? (
                          <p className="text-zinc-700 text-center mt-1" style={{ fontSize: 9 }}>Empty</p>
                        ) : (
                          <div className="space-y-0.5">
                            {coldTransfers.map((tr) => {
                              const b = batchById[tr.batch_id];
                              const detail = tr.transfer_type === "kegging"
                                ? (tr.kegging_detail as { total_kegs?: number } | null)
                                : (tr.canning_detail as { total_cans?: number } | null);
                              const qty = tr.transfer_type === "kegging"
                                ? (detail as { total_kegs?: number } | null)?.total_kegs
                                : (detail as { total_cans?: number } | null)?.total_cans;
                              const unit = tr.transfer_type === "kegging" ? "keg" : "can";
                              return (
                                <div key={tr.id} className="flex items-baseline gap-1 leading-tight">
                                  <span className="text-zinc-300 truncate" style={{ fontSize: 9 }}>{b?.beer_name ?? "—"}</span>
                                  {qty != null && (
                                    <span className="text-zinc-500 shrink-0" style={{ fontSize: 8 }}>{qty} {unit}{qty !== 1 ? "s" : ""}</span>
                                  )}
                                  <span className="text-zinc-600 shrink-0 ml-auto" style={{ fontSize: 8 }}>{fmtDate(tr.transferred_at)}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}

                    {/* === Regular tank (fermenter / brite / brewhouse) === */}
                    {isTank && (
                      <>
                        {!isUnconstrained && tank.capacity_bbl && (
                          <>
                            <p className="text-zinc-600" style={{ fontSize: 9 }}>
                              {batch ? `${Number(batch.volume_bbl).toFixed(1)} / ${tank.capacity_bbl} BBL` : `${tank.capacity_bbl} BBL`}
                            </p>
                            {/* Fill bar */}
                            {batch && (
                              <div className="w-full rounded-full overflow-hidden" style={{ height: 3, background: "rgba(63,63,70,0.6)", marginTop: 2, marginBottom: 2 }}>
                                <div
                                  style={{
                                    height: "100%",
                                    width: `${Math.min(100, (Number(batch.volume_bbl) / tank.capacity_bbl) * 100).toFixed(1)}%`,
                                    background: "rgba(245,158,11,0.7)",
                                    borderRadius: "9999px",
                                  }}
                                />
                              </div>
                            )}
                          </>
                        )}
                        {batch ? (
                          <>
                            <div className="flex items-baseline gap-1 flex-wrap">
                              {batch.batch_number && (
                                <span className="text-zinc-500 font-mono shrink-0" style={{ fontSize: 9 }}>#{batch.batch_number}</span>
                              )}
                              <span className="text-zinc-200 font-medium leading-tight break-words" style={{ fontSize: 10 }}>
                                {batch.beer_name}
                              </span>
                            </div>
                            {assignment && (
                              <p className="text-zinc-600" style={{ fontSize: 8 }}>since {fmtDate(assignment.assigned_at)}</p>
                            )}
                            {!editMode && (
                              <div className="mt-auto pt-1">
                                <button
                                  onClick={() => setTransferTankId(tank.id)}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  className="text-amber-700 hover:text-amber-400 border border-amber-900 hover:border-amber-700 px-1.5 rounded transition-colors"
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
                            {!editMode && tank.type === "brewhouse" && unassignedBatches.length > 0 && (
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
                      </>
                    )}

                    {/* === Kegging / Canning (unconstrained, single-assign) === */}
                    {!isTank && !isColdStorage && !isBacklog && (
                      <>
                        {batch ? (
                          <>
                            <div className="flex items-baseline gap-1 flex-wrap">
                              {batch.batch_number && (
                                <span className="text-zinc-500 font-mono shrink-0" style={{ fontSize: 9 }}>#{batch.batch_number}</span>
                              )}
                              <span className="text-zinc-200 font-medium leading-tight break-words" style={{ fontSize: 10 }}>
                                {batch.beer_name}
                              </span>
                            </div>
                            <StatusBadge status={batch.status} />
                            {assignment && (
                              <p className="text-zinc-600" style={{ fontSize: 8 }}>since {fmtDate(assignment.assigned_at)}</p>
                            )}
                            {!editMode && (
                              <div className="mt-auto pt-1">
                                <button
                                  onClick={() => setTransferTankId(tank.id)}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  className="text-amber-700 hover:text-amber-400 border border-amber-900 hover:border-amber-700 px-1.5 rounded transition-colors"
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
                          </div>
                        )}
                      </>
                    )}

                    {/* Edit mode controls */}
                    {editMode && (
                      <div className="mt-auto pt-1 flex gap-1.5">
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
                left:   drag.dropPreview.col * cell + GAP,
                top:    drag.dropPreview.row * cell + GAP,
                width:  drag.draggingTank.grid_width  * cell - GAP * 2,
                height: drag.draggingTank.grid_height * cell - GAP * 2,
              }}
            />
          )}
        </div>
      </div>


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
                      capacity_bbl: UNCONSTRAINED_EQUIPMENT_TYPES.includes(type) ? "" : f.capacity_bbl,
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
                  disabled={UNCONSTRAINED_EQUIPMENT_TYPES.includes(eqCrud.eqForm.type)}
                  placeholder={UNCONSTRAINED_EQUIPMENT_TYPES.includes(eqCrud.eqForm.type) ? "N/A" : ""}
                  value={eqCrud.eqForm.capacity_bbl}
                  onChange={(e) => eqCrud.setEqForm((f) => ({ ...f, capacity_bbl: e.target.value }))}
                  style={UNCONSTRAINED_EQUIPMENT_TYPES.includes(eqCrud.eqForm.type) ? { opacity: 0.35, cursor: "not-allowed" } : {}}
                />
                {UNCONSTRAINED_EQUIPMENT_TYPES.includes(eqCrud.eqForm.type) && (
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

      {/* New batch modal (triggered from Backlog) */}
      {showNewBatch && (
        <Modal title="New Batch" onClose={() => setShowNewBatch(false)}>
          <form onSubmit={handleNewBatchSubmit} className="space-y-4">
            <Field label="Recipe" required>
              <select className="inp" value={batchForm.recipe_id} onChange={(e) => handleRecipeChange(e.target.value)} required>
                <option value="">— select a recipe —</option>
                {recipes.map((r) => (
                  <option key={r.id} value={r.id}>{r.beer_name}{r.brewery ? ` · ${r.brewery}` : ""}</option>
                ))}
              </select>
            </Field>
            <Field label="Beer Name" required>
              <input className="inp" value={batchForm.beer_name} required
                onChange={(e) => setBatchForm((f) => ({ ...f, beer_name: e.target.value }))} />
            </Field>
            <Field label="Planned Brew Date" required>
              <input type="date" className="inp" value={batchForm.planned_brew_date} required
                onChange={(e) => setBatchForm((f) => ({ ...f, planned_brew_date: e.target.value }))} />
            </Field>
            <Field label={`Turns (${BREWHOUSE_BBL} BBL brewhouse)`} required>
              <input type="number" min="1" step="1" className="inp" value={batchForm.turns} required
                onChange={(e) => setBatchForm((f) => ({ ...f, turns: e.target.value }))} />
              {(() => {
                const r = recipes.find((r) => r.id === batchForm.recipe_id);
                const vol = r?.expected_yield_bbl != null ? (r.expected_yield_bbl * (parseInt(batchForm.turns) || 1)).toFixed(2) : null;
                return vol ? (
                  <p className="text-xs text-zinc-500 mt-1">Computed volume: <span className="text-zinc-300 font-medium">{vol} BBL</span></p>
                ) : batchForm.recipe_id ? (
                  <p className="text-xs text-amber-600 mt-1">Recipe has no expected yield — set it in Recipes first.</p>
                ) : null;
              })()}</Field>
            <Field label="Notes">
              <textarea className="inp resize-none" rows={2} value={batchForm.notes}
                onChange={(e) => setBatchForm((f) => ({ ...f, notes: e.target.value }))} />
            </Field>
            <ModalActions submitting={batchSubmitting} onCancel={() => setShowNewBatch(false)} label="Create Batch" />
          </form>
        </Modal>
      )}
    </>
  );
}
