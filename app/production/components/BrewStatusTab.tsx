"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Equipment, BrewBatch, BatchTankAssignment, UNCONSTRAINED_EQUIPMENT_TYPES } from "../types";
import { computeTankVolumes } from "../lib/volumeLedger";
import { BREWHOUSE_BBL, Modal, Field, ModalActions } from "./shared";
import { EQ, EQ_TYPES } from "../equipmentMeta";
import { GRID_CELL_PX as CELL, GRID_COLS, GRID_ROWS, GRID_GAP_PX as GAP } from "@/lib/constants/production";
import { fmtDate } from "@/lib/utils/formatting";
import TransferModal from "./TransferModal";
import { useTankDragDrop } from "../hooks/useTankDragDrop";
import { useEquipmentCrud } from "../hooks/useEquipmentCrud";
import { useBatchAssign } from "../hooks/useBatchAssign";
import {
  usePackagingQuery, useEquipmentQuery, useAssignmentsQuery, useBatchesQuery,
  useTransfersQuery, useRecipesQuery, productionKeys,
} from "../hooks/queries";

const GRID_COLS_KEY = "brewConsole_gridCols";
const GRID_ROWS_KEY = "brewConsole_gridRows";


const BATCH_EMPTY = {
  recipe_id: "",
  beer_name: "",
  planned_brew_date: new Date().toISOString().slice(0, 10),
  expected_delivery_date: "",
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

export default function BrewStatusTab() {
  const qc = useQueryClient();
  const { data: tanks = [] } = useEquipmentQuery();
  const { data: assignments = [] } = useAssignmentsQuery();
  const { data: batches = [] } = useBatchesQuery();
  const { data: transfers = [] } = useTransfersQuery();
  const { data: recipes = [] } = useRecipesQuery();

  // Floorplan actions touch equipment/assignments/batches/transfers together.
  const refreshBrewStatus = useCallback(() => Promise.all([
    qc.invalidateQueries({ queryKey: productionKeys.equipment }),
    qc.invalidateQueries({ queryKey: productionKeys.assignments }),
    qc.invalidateQueries({ queryKey: productionKeys.batches }),
    qc.invalidateQueries({ queryKey: productionKeys.transfers }),
  ]).then(() => undefined), [qc]);
  const onRefresh = refreshBrewStatus;
  const onBatchCreated = useCallback(() => qc.invalidateQueries({ queryKey: productionKeys.batches }), [qc]);

  const [editMode, setEditMode] = useState(false);
  const [transferTankId, setTransferTankId] = useState<string | null>(null);
  const [transferBatchId, setTransferBatchId] = useState<string | null>(null);
  const [transferFromVol, setTransferFromVol] = useState<number | undefined>(undefined);
  // Tracks batch IDs currently being sent to cold storage (kegging/canning one-click transfer)
  const [pkgTransferring, setPkgTransferring] = useState<Set<string>>(new Set());

  async function handleSendToColdStorage(batchId: string, fromTankId: string, incoming: typeof transfers[0]) {
    const coldStorage = tanks.find((t) => t.type === "cold_storage");
    if (!coldStorage) { alert("No cold storage tank found on the floorplan."); return; }
    setPkgTransferring((s) => new Set(s).add(batchId));
    try {
      const res = await fetch("/api/production/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batch_id:       batchId,
          from_tank_id:   fromTankId,
          to_tank_id:     coldStorage.id,
          volume_bbl:     incoming.volume_bbl,
          shrinkage_bbl:  0,
          transfer_type:  incoming.transfer_type,
          kegging_detail: incoming.kegging_detail ?? null,
          canning_detail: incoming.canning_detail ?? null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await onRefresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Transfer failed");
    } finally {
      setPkgTransferring((s) => { const n = new Set(s); n.delete(batchId); return n; });
    }
  }
  // Shared with the Inventory tab via the query cache (de-duped, no local fetch).
  const { data: packaging = [] } = usePackagingQuery();
  // Initialize with the SSR default so the server and the client's first render
  // agree (avoids a hydration mismatch on the grid dimensions); the persisted
  // value is loaded from localStorage after mount in the effect below.
  const [gridCols, setGridCols] = useState(GRID_COLS);
  const [gridRows, setGridRows] = useState(GRID_ROWS);
  const gridSizeSaveSkip = useRef(true);

  // New batch modal state
  const [showNewBatch, setShowNewBatch] = useState(false);
  const [batchForm, setBatchForm] = useState(BATCH_EMPTY);
  const [batchSubmitting, setBatchSubmitting] = useState(false);

  function handleRecipeChange(recipeId: string) {
    const r = recipes.find((rec) => rec.id === recipeId);
    const leadDays = r ? ((r.days_brewhouse ?? 0) + (r.days_fermenter ?? 0) + (r.days_brite ?? 0)) : 0;
    const autoDelivery = leadDays > 0
      ? (() => {
          const d = new Date(batchForm.planned_brew_date || new Date().toISOString().slice(0, 10));
          d.setDate(d.getDate() + leadDays);
          return d.toISOString().slice(0, 10);
        })()
      : "";
    setBatchForm((f) => ({
      ...f,
      recipe_id: recipeId,
      beer_name: r?.beer_name ?? f.beer_name,
      turns: "1",
      expected_delivery_date: autoDelivery || f.expected_delivery_date,
    }));
  }

  async function handleNewBatchSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!batchForm.recipe_id) { alert("Please select a recipe."); return; }
    if (!batchForm.expected_delivery_date) { alert("Expected delivery date is required."); return; }
    const recipe = recipes.find((r) => r.id === batchForm.recipe_id);
    const turns = parseInt(batchForm.turns) || 1;
    const volume_bbl = recipe?.expected_yield_bbl != null ? recipe.expected_yield_bbl * turns : null;
    if (!volume_bbl) { alert("Selected recipe has no expected yield. Set it in the Recipes tab first."); return; }
    setBatchSubmitting(true);
    try {
      const payload = {
        recipe_id:              batchForm.recipe_id,
        beer_name:              batchForm.beer_name,
        planned_brew_date:      batchForm.planned_brew_date,
        expected_delivery_date: batchForm.expected_delivery_date,
        volume_bbl,
        turns,
        notes:                  batchForm.notes || null,
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

  // Load persisted grid size once, after mount. Reading localStorage here (not
  // in the initializer) is required to avoid an SSR/client hydration mismatch.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const c = parseInt(localStorage.getItem(GRID_COLS_KEY) ?? "");
    const r = parseInt(localStorage.getItem(GRID_ROWS_KEY) ?? "");
    if (c) setGridCols(c);
    if (r) setGridRows(r);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Persist on change, but skip the initial mount so we never overwrite the
  // stored value with the default before the load effect above has run.
  useEffect(() => {
    if (gridSizeSaveSkip.current) { gridSizeSaveSkip.current = false; return; }
    localStorage.setItem(GRID_COLS_KEY, String(gridCols));
    localStorage.setItem(GRID_ROWS_KEY, String(gridRows));
  }, [gridCols, gridRows]);

  const assignmentByTank   = Object.fromEntries(assignments.map((a) => [a.tank_id, a])) as Record<string, BatchTankAssignment | undefined>;
  const assignedBatchIds   = new Set(assignments.map((a) => a.batch_id));
  // Packaging-status batches live on their kegging/canning tile — don't show in backlog/unassigned
  const unassignedBatches  = batches.filter((b) => b.status !== "archived" && b.status !== "packaging" && !assignedBatchIds.has(b.id));
  const planningBatches    = batches.filter((b) => b.status === "planning")
    .sort((a, b) => new Date(b.planned_brew_date).getTime() - new Date(a.planned_brew_date).getTime());
  const batchById          = Object.fromEntries(batches.map((b) => [b.id, b]));

  // Ledger: current volume per batch per tank, derived from transfer history
  const tankVolumesByBatch: Record<string, Record<string, number>> = {};
  for (const b of batches) {
    const vols = computeTankVolumes(b.id, Number(b.volume_bbl ?? 0), transfers);
    if (Object.keys(vols).length > 0) tankVolumesByBatch[b.id] = vols;
  }

  const placed   = tanks.filter((t) => t.grid_row != null && t.grid_col != null);
  const unplaced = tanks.filter((t) => t.grid_row == null || t.grid_col == null);

  const transferTank       = transferTankId ? tanks.find((t) => t.id === transferTankId) ?? null : null;
  const transferAssignment = transferTankId ? assignmentByTank[transferTankId] : null;
  const transferBatch: BrewBatch | null = transferBatchId
    ? (batches.find((b) => b.id === transferBatchId) ?? null)
    : (transferAssignment ? (batches.find((b) => b.id === transferAssignment.batch_id) ?? null) : null);

  // Destructure so the ref (gridRef) and state (dragging/dropPreview/…) keep
  // distinct identities — otherwise the React Compiler taints every access on
  // the returned object as "accessing refs during render".
  const {
    dragging, dropPreview, gridRef, draggingTank,
    onDragStart, onGridDragOver, onGridDrop, onUnplacedDrop, removeFromGrid, clearDrag,
  } = useTankDragDrop(tanks, onRefresh);
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
            dragging ? "border-zinc-500 bg-zinc-900/40" : "border-zinc-700"
          }`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onUnplacedDrop}
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
                  onDragStart={(e) => onDragStart(e, tank)}
                  onDragEnd={clearDrag}
                  className={`rounded border px-3 py-2 bg-zinc-900 ${eq.border} cursor-grab active:cursor-grabbing ${
                    dragging?.id === tank.id ? "opacity-40" : ""
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

      {/* Grid — frame always matches grid size exactly; page scrolls if needed, no internal scrollbar */}
      <div className="rounded-lg border border-zinc-800 mb-6 overflow-hidden" style={{ width: gridCols * cell, height: gridRows * cell }}>
        <div
          ref={gridRef}
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
          onDragOver={editMode ? onGridDragOver : undefined}
          onDrop={editMode ? onGridDrop : undefined}
          onDragLeave={() => clearDrag()}
        >
          {placed.map((tank) => {
            const eq          = EQ[tank.type];
            if (!eq) return null;
            const assignment  = assignmentByTank[tank.id];
            const batch       = assignment?.brew_batches;
            const isDragging  = dragging?.id === tank.id;
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
                onDragStart={editMode ? (e) => onDragStart(e, tank) : undefined}
                onDragEnd={clearDrag}
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
                          <div className="space-y-1">
                            {coldTransfers.map((tr) => {
                              const b = batchById[tr.batch_id];
                              const isKeg = tr.transfer_type === "kegging";
                              const kegDetail  = isKeg ? (tr.kegging_detail as { total_kegs?: number; kegs?: { name: string; quantity: number }[] } | null) : null;
                              const canDetail  = !isKeg ? (tr.canning_detail as { total_cans?: number } | null) : null;
                              const kegLines   = kegDetail?.kegs?.filter((k) => k.quantity > 0) ?? [];
                              return (
                                <div key={tr.id} className="flex flex-col gap-0 leading-tight">
                                  <div className="flex items-baseline gap-1">
                                    <span className="text-zinc-300 truncate font-medium" style={{ fontSize: 9 }}>{b?.beer_name ?? "—"}</span>
                                    <span className="text-zinc-600 shrink-0 ml-auto" style={{ fontSize: 8 }}>{fmtDate(tr.transferred_at)}</span>
                                  </div>
                                  {isKeg && kegLines.length > 0 && (
                                    <div className="pl-1">
                                      {kegLines.map((k, i) => (
                                        <span key={i} className="text-zinc-500 block" style={{ fontSize: 8 }}>
                                          {k.quantity}× {k.name}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                  {isKeg && kegLines.length === 0 && kegDetail?.total_kegs != null && (
                                    <span className="text-zinc-500 pl-1" style={{ fontSize: 8 }}>{kegDetail.total_kegs} keg{kegDetail.total_kegs !== 1 ? "s" : ""}</span>
                                  )}
                                  {!isKeg && canDetail?.total_cans != null && (
                                    <span className="text-zinc-500 pl-1" style={{ fontSize: 8 }}>{canDetail.total_cans} can{canDetail.total_cans !== 1 ? "s" : ""}</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}

                    {/* === Regular tank (fermenter / brite / brewhouse) === */}
                    {isTank && (() => {
                      // Ledger volume for this batch in THIS specific tank (may be a partial split)
                      const ledgerVol = batch
                        ? (tankVolumesByBatch[batch.id]?.[tank.id] ?? Number(batch.volume_bbl ?? 0))
                        : 0;
                      return (
                      <>
                        {!isUnconstrained && tank.capacity_bbl && (
                          <>
                            <p className="text-zinc-600" style={{ fontSize: 9 }}>
                              {batch ? `${ledgerVol.toFixed(1)} / ${tank.capacity_bbl} BBL` : `${tank.capacity_bbl} BBL`}
                            </p>
                            {/* Fill bar */}
                            {batch && (
                              <div className="w-full rounded-full overflow-hidden" style={{ height: 3, background: "rgba(63,63,70,0.6)", marginTop: 2, marginBottom: 2 }}>
                                <div
                                  style={{
                                    height: "100%",
                                    width: `${Math.min(100, (ledgerVol / tank.capacity_bbl) * 100).toFixed(1)}%`,
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
                                  onClick={() => { setTransferTankId(tank.id); setTransferFromVol(ledgerVol); }}
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
                    ); })()}

                    {/* === Kegging / Canning (unconstrained — derive active batches from transfers) === */}
                    {!isTank && !isColdStorage && !isBacklog && (
                      (() => {
                        // Most-recent incoming pkg transfer per batch → used to show packaging output
                        const incomingByBatch = new Map<string, typeof transfers[0]>();
                        for (const tr of transfers) {
                          if (tr.to_tank_id !== tank.id) continue;
                          if (tr.transfer_type !== "kegging" && tr.transfer_type !== "canning") continue;
                          const existing = incomingByBatch.get(tr.batch_id);
                          if (!existing || new Date(tr.transferred_at) > new Date(existing.transferred_at)) {
                            incomingByBatch.set(tr.batch_id, tr);
                          }
                        }

                        const pkgBatches = [...new Map(
                          transfers
                            .filter((tr) => tr.to_tank_id === tank.id)
                            .sort((a, b) => new Date(b.transferred_at).getTime() - new Date(a.transferred_at).getTime())
                            .map((tr) => batchById[tr.batch_id])
                            .filter((b): b is BrewBatch => b?.status === "packaging")
                            .map((b) => [b.id, b] as [string, BrewBatch])
                        ).values()];

                        return pkgBatches.length > 0 ? (
                          <div className="space-y-1.5">
                            {pkgBatches.map((b) => {
                              const incoming = incomingByBatch.get(b.id);
                              const kd = incoming?.kegging_detail;
                              const cd = incoming?.canning_detail;
                              return (
                                <div key={b.id} className="flex flex-col gap-0.5">
                                  {/* Batch identity */}
                                  <div className="flex items-baseline gap-1 flex-wrap">
                                    {b.batch_number && (
                                      <span className="text-zinc-500 font-mono shrink-0" style={{ fontSize: 9 }}>#{b.batch_number}</span>
                                    )}
                                    <span className="text-zinc-200 font-medium leading-tight break-words" style={{ fontSize: 10 }}>
                                      {b.beer_name}
                                    </span>
                                  </div>

                                  {/* Packaging output */}
                                  {kd && (
                                    <div className="space-y-px">
                                      {kd.kegs && kd.kegs.length > 0
                                        ? kd.kegs.filter((k) => k.quantity > 0).map((k, i) => (
                                            <div key={i} className="flex items-center gap-1">
                                              <span className="text-amber-400 font-mono font-semibold" style={{ fontSize: 9 }}>{k.quantity}×</span>
                                              <span className="text-zinc-400 truncate" style={{ fontSize: 9 }}>{k.name}</span>
                                            </div>
                                          ))
                                        : kd.total_kegs != null && (
                                            <span className="text-amber-400 font-mono" style={{ fontSize: 9 }}>{kd.total_kegs} kegs</span>
                                          )
                                      }
                                    </div>
                                  )}
                                  {cd && cd.total_cans != null && (
                                    <div className="flex items-center gap-1">
                                      <span className="text-amber-400 font-mono font-semibold" style={{ fontSize: 9 }}>{cd.total_cans.toLocaleString()}</span>
                                      <span className="text-zinc-400" style={{ fontSize: 9 }}>cans</span>
                                      {cd.cases != null && cd.cases > 0 && (
                                        <span className="text-zinc-600" style={{ fontSize: 8 }}>({cd.cases} cases{cd.loose_cans ? ` + ${cd.loose_cans}` : ""})</span>
                                      )}
                                    </div>
                                  )}

                                  {/* One-click transfer to cold storage */}
                                  {!editMode && incoming && (
                                    <button
                                      onClick={() => handleSendToColdStorage(b.id, tank.id, incoming)}
                                      onMouseDown={(e) => e.stopPropagation()}
                                      disabled={pkgTransferring.has(b.id)}
                                      className="self-start text-amber-700 hover:text-amber-400 border border-amber-900 hover:border-amber-700 px-1.5 rounded transition-colors mt-0.5 disabled:opacity-40"
                                      style={{ fontSize: 9 }}
                                    >
                                      {pkgTransferring.has(b.id) ? "…" : "Transfer"}
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="flex-1 flex flex-col items-center justify-center gap-1">
                            <p className="text-zinc-700" style={{ fontSize: 9 }}>Empty</p>
                          </div>
                        );
                      })()
                    )}

                    {/* Edit mode controls */}
                    {editMode && (
                      <div className="mt-auto pt-1 flex gap-1.5">
                        <button onClick={() => eqCrud.openEdit(tank)} onMouseDown={(e) => e.stopPropagation()} className="text-zinc-600 hover:text-zinc-300 transition-colors" style={{ fontSize: 9 }}>Edit</button>
                        <button onClick={() => removeFromGrid(tank.id)} onMouseDown={(e) => e.stopPropagation()} className="text-zinc-600 hover:text-amber-400 transition-colors" style={{ fontSize: 9 }}>Unplace</button>
                        {!assignment && <button onClick={() => eqCrud.handleDeleteEq(tank.id, tank.name)} onMouseDown={(e) => e.stopPropagation()} className="text-zinc-600 hover:text-red-400 transition-colors" style={{ fontSize: 9 }}>Del</button>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Drop preview */}
          {dropPreview && draggingTank && (
            <div
              className={`absolute pointer-events-none z-20 rounded border-2 border-dashed ${
                dropPreview.valid ? "border-amber-400 bg-amber-900/15" : "border-red-500 bg-red-900/15"
              }`}
              style={{
                left:   dropPreview.col * cell + GAP,
                top:    dropPreview.row * cell + GAP,
                width:  draggingTank.grid_width  * cell - GAP * 2,
                height: draggingTank.grid_height * cell - GAP * 2,
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
          occupiedTankIds={new Set(assignments.map((a) => a.tank_id))}
          packaging={packaging}
          fromTankVolume={transferFromVol}
          onClose={() => { setTransferTankId(null); setTransferBatchId(null); setTransferFromVol(undefined); }}
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
                onChange={(e) => {
                  const newDate = e.target.value;
                  setBatchForm((f) => {
                    const recipe = recipes.find((r) => r.id === f.recipe_id);
                    const leadDays = recipe ? ((recipe.days_brewhouse ?? 0) + (recipe.days_fermenter ?? 0) + (recipe.days_brite ?? 0)) : 0;
                    const autoDelivery = leadDays > 0 && newDate
                      ? (() => { const d = new Date(newDate); d.setDate(d.getDate() + leadDays); return d.toISOString().slice(0, 10); })()
                      : f.expected_delivery_date;
                    return { ...f, planned_brew_date: newDate, expected_delivery_date: autoDelivery };
                  });
                }} />
            </Field>
            <Field label="Expected Delivery Date" required>
              <input type="date" className="inp" value={batchForm.expected_delivery_date} required
                onChange={(e) => setBatchForm((f) => ({ ...f, expected_delivery_date: e.target.value }))} />
              {batchForm.recipe_id && (() => {
                const recipe = recipes.find((r) => r.id === batchForm.recipe_id);
                const leadDays = recipe ? ((recipe.days_brewhouse ?? 0) + (recipe.days_fermenter ?? 0) + (recipe.days_brite ?? 0)) : 0;
                return leadDays > 0 ? (
                  <p className="text-xs text-zinc-600 mt-1">Auto-set from recipe lead time: {leadDays} days</p>
                ) : null;
              })()}
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
