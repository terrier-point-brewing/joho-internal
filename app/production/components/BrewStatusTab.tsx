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
import NextPlannedBox from "./FloorplanTile/NextPlannedBox";
import { useTankDragDrop } from "../hooks/useTankDragDrop";
import { useEquipmentCrud } from "../hooks/useEquipmentCrud";
import { useBatchAssign } from "../hooks/useBatchAssign";
import {
  useRecipePackagingVariationsQuery, usePackagingVariationsQuery, useEquipmentQuery, useAssignmentsQuery, useBatchesQuery,
  useTransfersQuery, useRecipesQuery, useBatchScheduleQuery, useBatchConversionsQuery,
  productionKeys, type ScheduleEntry,
} from "../hooks/queries";
import { useUserRole } from "@/lib/hooks/useUserRole";
import { STAGE_LABELS } from "./EquipmentSchedule/constants";


const BATCH_EMPTY = {
  recipe_id: "",
  beer_name: "",
  planned_brew_date: new Date().toISOString().slice(0, 10),
  expected_delivery_date: "",
  turns: "1",
  notes: "",
};

const TANK_TYPES = new Set(["fermenter", "brite", "brewhouse"]);

// Minimal calendar glyph for the per-equipment "upcoming plans" button —
// crisper at tiny sizes than an emoji and matches the rest of the UI's line-icon style.
function CalendarIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="2.5" width="13" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.5 6h13" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.5 1.2v2.6M11.5 1.2v2.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// Groups a date-sorted list into runs sharing the same calendar day, so the
// UI can print the date once per group instead of repeating it on every row.
function groupByDate<T>(items: T[], dateOf: (item: T) => string): { date: string; items: T[] }[] {
  const groups: { date: string; items: T[] }[] = [];
  for (const item of items) {
    const d = dateOf(item).slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.date === d) last.items.push(item);
    else groups.push({ date: d, items: [item] });
  }
  return groups;
}

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
  const { role } = useUserRole();
  const isAdmin          = role === "admin";
  const canEditEquipment = role === "brewer" || role === "admin";
  const { data: tanks = [] } = useEquipmentQuery();
  const { data: assignments = [] } = useAssignmentsQuery();
  const { data: batches = [] } = useBatchesQuery();
  const { data: transfers = [] } = useTransfersQuery();
  const { data: recipes = [] } = useRecipesQuery();
  const { data: scheduleEntries = [] } = useBatchScheduleQuery();
  const { data: allBatchConversions = [] } = useBatchConversionsQuery();
  const pendingConversions = allBatchConversions.filter(c => !c.converted_at);

  // Deviation toast state
  const [deviationToast, setDeviationToast] = useState<{ message: string; equipment_name?: string } | null>(null);

  // Floorplan actions touch equipment/assignments/batches/transfers together.
  const refreshBrewStatus = useCallback(() => Promise.all([
    qc.invalidateQueries({ queryKey: productionKeys.equipment }),
    qc.invalidateQueries({ queryKey: productionKeys.assignments }),
    qc.invalidateQueries({ queryKey: productionKeys.batches }),
    qc.invalidateQueries({ queryKey: productionKeys.transfers }),
    qc.invalidateQueries({ queryKey: productionKeys.batchSchedule }),
    qc.invalidateQueries({ queryKey: productionKeys.scheduleConflicts }),
  ]).then(() => undefined), [qc]);
  const onRefresh = refreshBrewStatus;
  const onBatchCreated = useCallback(() => qc.invalidateQueries({ queryKey: productionKeys.batches }), [qc]);

  const handleTransferDone = useCallback(async (response?: { schedule_update?: { action: string; was_deviation?: boolean; equipment_name?: string }[] }) => {
    await refreshBrewStatus();
    const updates = response?.schedule_update ?? [];
    const deviation = updates.find(u => u.was_deviation);
    if (deviation) {
      setDeviationToast({ message: `Batch rebooked to ${deviation.equipment_name ?? "new tank"}`, equipment_name: deviation.equipment_name });
      setTimeout(() => setDeviationToast(null), 6000);
    }
  }, [refreshBrewStatus]);

  const [editMode, setEditMode] = useState(false);
  const [mobileFilter, setMobileFilter] = useState<string>("all");
  const [transferTankId, setTransferTankId] = useState<string | null>(null);
  const [transferBatchId, setTransferBatchId] = useState<string | null>(null);
  const [transferFromVol, setTransferFromVol] = useState<number | undefined>(undefined);
  // When the Up Next banner opens the Transfer modal directly (rather than
  // the per-tank Transfer button), it may need to seed Convert-mode fields.
  const [transferInitialDestId, setTransferInitialDestId] = useState<string | undefined>(undefined);
  const [transferInitialMode, setTransferInitialMode] = useState<"transfer" | "convert" | undefined>(undefined);
  const [transferInitialConvert, setTransferInitialConvert] = useState<{ toBatchId: string; beerName: string; bbl: string } | undefined>(undefined);
  // Shared with the Inventory tab via the query cache (de-duped, no local fetch).
  const { data: recipePackagingVariations = [] } = useRecipePackagingVariationsQuery();
  const { data: allPackagingVariations = [] } = usePackagingVariationsQuery();
  // Grid size — initialized to defaults to avoid SSR/client hydration mismatch;
  // actual server value is fetched once after mount.
  const [gridCols, setGridCols] = useState(GRID_COLS);
  const [gridRows, setGridRows] = useState(GRID_ROWS);

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
    const volume_bbl = BREWHOUSE_BBL * turns;
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

  // Load shared grid size from server once after mount.
  useEffect(() => {
    fetch("/api/production/floorplan-settings")
      .then((r) => r.json())
      .then((d: { cols: number; rows: number }) => {
        if (d.cols) setGridCols(d.cols);
        if (d.rows) setGridRows(d.rows);
      })
      .catch(() => {});
  }, []);

  function saveGridSize(cols: number, rows: number) {
    fetch("/api/production/floorplan-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cols, rows }),
    }).catch(() => {});
  }

  const assignmentByTank   = Object.fromEntries(assignments.map((a) => [a.tank_id, a])) as Record<string, BatchTankAssignment | undefined>;
  // Same-recipe batches can combine in one tank, so a tank may have more than
  // one active assignment — group them so tiles can show every occupant.
  const assignmentsByTank: Record<string, BatchTankAssignment[]> = {};
  for (const a of assignments) (assignmentsByTank[a.tank_id] ??= []).push(a);
  // Reverse lookup: which tank (if any) currently holds a given batch — this
  // is the "current upstream action" an Up Next entry is sourced from.
  const tankById = Object.fromEntries(tanks.map((t) => [t.id, t])) as Record<string, Equipment | undefined>;
  const currentTankByBatchId: Record<string, Equipment | undefined> = Object.fromEntries(
    assignments.map((a) => [a.batch_id, tankById[a.tank_id]])
  );
  const assignedBatchIds   = new Set(assignments.map((a) => a.batch_id));
  const unassignedBatches  = batches.filter((b) => b.status !== "complete" && !assignedBatchIds.has(b.id));
  const planningBatches    = batches.filter((b) => b.status === "planning")
    .sort((a, b) => new Date(b.planned_brew_date).getTime() - new Date(a.planned_brew_date).getTime());
  const batchById          = Object.fromEntries(batches.map((b) => [b.id, b]));
  const occupiedTankRecipeIds: Record<string, (string | null)[]> = Object.fromEntries(
    Object.entries(assignmentsByTank).map(([tankId, list]) => [tankId, list.map((a) => batchById[a.batch_id]?.recipe_id ?? null)]),
  );

  // Ledger: current volume per batch per tank, derived from transfer history
  const tankVolumesByBatch: Record<string, Record<string, number>> = {};
  for (const b of batches) {
    const vols = computeTankVolumes(b.id, Number(b.volume_bbl ?? 0), transfers);
    if (Object.keys(vols).length > 0) tankVolumesByBatch[b.id] = vols;
  }

  // Next planned batch per tank (for empty tank tiles) — earliest future uncancelled entry per equipment_id
  const nextPlannedByTank = React.useMemo(() => {
    const map = new Map<string, ScheduleEntry>();
    const now = new Date().toISOString();
    for (const entry of scheduleEntries) {
      if (!entry.equipment_id) continue;
      if (entry.actual_start) continue; // already started
      if (entry.planned_start < now.slice(0, 10)) continue; // past planned start, skip
      const existing = map.get(entry.equipment_id);
      if (!existing || entry.planned_start < existing.planned_start) {
        map.set(entry.equipment_id, entry);
      }
    }
    return map;
  }, [scheduleEntries]);

  // Every not-yet-started, non-cancelled entry per equipment, earliest first —
  // backs both the per-equipment "Plans" popup and the top "what's next" banner.
  const upcomingByEquipment = React.useMemo(() => {
    const map = new Map<string, ScheduleEntry[]>();
    for (const entry of scheduleEntries) {
      if (!entry.equipment_id || entry.cancelled_at || entry.actual_start) continue;
      (map.get(entry.equipment_id) ?? map.set(entry.equipment_id, []).get(entry.equipment_id)!).push(entry);
    }
    for (const list of map.values()) list.sort((a, b) => a.planned_start.localeCompare(b.planned_start));
    return map;
  }, [scheduleEntries]);

  // Flattened, globally-sorted upcoming tasks for the top banner.
  const upcomingTasks = React.useMemo(() => {
    return [...scheduleEntries]
      .filter(e => e.equipment_id && !e.cancelled_at && !e.actual_start)
      .sort((a, b) => a.planned_start.localeCompare(b.planned_start));
  }, [scheduleEntries]);

  // Resolve the right click-through action for an Up Next card: prefer a
  // direct Transfer/Convert action over the tank's current occupant, falling
  // back to the read-only "Upcoming plans" popup when there's no current
  // tank to act from (e.g. the batch hasn't been brewed/placed yet).
  function openUpNextAction(e: ScheduleEntry) {
    const currentTank = currentTankByBatchId[e.batch_id];
    if (!currentTank) {
      if (e.equipment_id) setPlansEquipmentId(e.equipment_id);
      return;
    }
    // In-place fermenting→conditioning, or any other transfer to a specific
    // planned tank: open Transfer mode with that tank pre-selected as the
    // destination (TransferModal falls back to its own first-valid-option
    // default if this tank isn't actually a legal destination).
    setTransferTankId(currentTank.id);
    setTransferBatchId(e.batch_id);
    setTransferFromVol(undefined);
    setTransferInitialMode("transfer");
    setTransferInitialDestId(e.equipment_id ?? undefined);
    setTransferInitialConvert(undefined);
  }

  function openPendingConversionAction(conversionId: string) {
    const conv = pendingConversions.find(c => c.id === conversionId);
    if (!conv) return;
    const sourceTank = conv.source_equipment_id ? tanks.find(t => t.id === conv.source_equipment_id) : null;
    if (!sourceTank) return;
    setTransferTankId(sourceTank.id);
    setTransferBatchId(conv.source_batch_id);
    setTransferFromVol(undefined);
    setTransferInitialMode("convert");
    setTransferInitialDestId(undefined);
    setTransferInitialConvert({
      toBatchId: conv.target_batch_id,
      beerName:  conv.target_batch?.beer_name ?? "",
      bbl:       String(conv.volume_bbl),
    });
  }

  const [plansEquipmentId, setPlansEquipmentId] = useState<string | null>(null);
  const plansEquipment = plansEquipmentId ? tanks.find(t => t.id === plansEquipmentId) ?? null : null;

  // Planned entry for the NEXT stage of the batch being transferred
  const placed   = tanks.filter((t) => t.grid_row != null && t.grid_col != null);
  const unplaced = tanks.filter((t) => t.grid_row == null || t.grid_col == null);

  const transferTank       = transferTankId ? tanks.find((t) => t.id === transferTankId) ?? null : null;
  const transferAssignment = transferTankId ? assignmentByTank[transferTankId] : null;
  const transferBatch: BrewBatch | null = transferBatchId
    ? (batches.find((b) => b.id === transferBatchId) ?? null)
    : (transferAssignment ? (batches.find((b) => b.id === transferAssignment.batch_id) ?? null) : null);

  const transferPlannedEntry = React.useMemo((): ScheduleEntry | null => {
    if (!transferBatch) return null;
    const NEXT_STAGE: Record<string, string> = { brewhouse: "fermenter", fermenter: "conditioning", conditioning: "" };
    const nextStage = transferTankId ? NEXT_STAGE[tanks.find(t => t.id === transferTankId)?.type ?? ""] : null;
    if (!nextStage) return null;
    return scheduleEntries.find(e => e.batch_id === transferBatch.id && e.stage === nextStage) ?? null;
  }, [transferBatch, transferTankId, scheduleEntries, tanks]);

  const cell = CELL;

  // Scale the grid to fit the available container dimensions.
  const scaleContainerRef = useRef<HTMLDivElement>(null);
  const [gridScale, setGridScale] = useState(1);
  useEffect(() => {
    const el = scaleContainerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      const { width } = entry.contentRect;
      const naturalW = gridCols * cell;
      setGridScale(Math.min(1, width / naturalW));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [gridCols, gridRows, cell]);

  // Destructure so the ref (gridRef) and state (dragging/dropPreview/…) keep
  // distinct identities — otherwise the React Compiler taints every access on
  // the returned object as "accessing refs during render".
  const {
    dragging, dropPreview, gridRef, draggingTank,
    onDragStart, onGridDragOver, onGridDrop, onUnplacedDrop, removeFromGrid, clearDrag,
  } = useTankDragDrop(tanks, onRefresh, gridScale, gridCols, gridRows);
  const eqCrud = useEquipmentCrud(onRefresh);
  const assign = useBatchAssign(unassignedBatches, onRefresh);

  return (
    <>
      {/* Deviation toast */}
      {deviationToast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-start gap-3 px-4 py-3 rounded-lg border border-accent-border/60 bg-accent-muted shadow-xl text-sm text-accent-soft max-w-sm">
          <span className="text-lg leading-none">📋</span>
          <div className="flex-1">
            <p className="font-semibold text-accent-soft">Schedule updated</p>
            <p className="text-xs text-accent mt-0.5">
              Batch rebooked to <span className="font-medium text-accent-soft">{deviationToast.equipment_name}</span>.
              Check the Timeline tab for any cascading conflicts.
            </p>
          </div>
          <button onClick={() => setDeviationToast(null)} className="text-accent-emphasis hover:text-accent text-lg leading-none ml-1">×</button>
        </div>
      )}

      {/* What's next — upcoming equipment-schedule tasks + pending conversions, soonest first */}
      {(upcomingTasks.length > 0 || pendingConversions.length > 0) && (
        <div className="mb-4 rounded-lg border border-line bg-surface/50 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-1.5">Up next</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {upcomingTasks.slice(0, 10).map((e) => {
              const b = e.brew_batches ?? (e.batch_id ? batchById[e.batch_id] : null);
              const eqName = e.equipment?.name ?? tanks.find(t => t.id === e.equipment_id)?.name ?? "—";
              const overdue = e.planned_start.slice(0, 10) < new Date().toISOString().slice(0, 10);
              const currentTank = currentTankByBatchId[e.batch_id];
              const actionLabel = !currentTank
                ? null
                : e.stage === "conditioning" && e.equipment_id === currentTank.id
                ? "Confirm Conditioning"
                : "Transfer";
              return (
                <button
                  key={e.id}
                  onClick={() => openUpNextAction(e)}
                  className={`shrink-0 flex flex-col gap-0.5 text-left px-2.5 py-1.5 rounded border transition-colors min-w-[150px] ${
                    overdue
                      ? "border-danger-border/60 bg-danger-surface/30 hover:bg-danger-surface/50"
                      : "border-line-strong/60 bg-surface-mid/40 hover:bg-surface-mid/70"
                  }`}
                >
                  <span className={`text-[9px] font-semibold uppercase tracking-wide ${overdue ? "text-danger" : "text-accent-emphasis"}`}>
                    {STAGE_LABELS[e.stage] ?? e.stage} · {eqName}
                  </span>
                  <span className="text-xs text-strong truncate">
                    {b ? `#${b.batch_number} ${b.beer_name}` : "—"}
                  </span>
                  <span className="text-[10px] text-muted">
                    {fmtDate(e.planned_start)}{e.volume_bbl != null && ` · ${Number(e.volume_bbl).toFixed(1)} BBL`}
                  </span>
                  {actionLabel && (
                    <span className="text-[9px] text-accent-emphasis font-medium mt-0.5">{actionLabel} →</span>
                  )}
                </button>
              );
            })}
            {/* Pending conversion cards — shown after schedule tasks */}
            {pendingConversions.map(conv => {
              const sourceBatch = batchById[conv.source_batch_id];
              const sourceTank = conv.source_equipment_id ? tanks.find(t => t.id === conv.source_equipment_id) : null;
              const overdue = conv.planned_date ? conv.planned_date < new Date().toISOString().slice(0, 10) : false;
              return (
                <button key={conv.id} onClick={() => openPendingConversionAction(conv.id)}
                  className={`shrink-0 flex flex-col gap-0.5 text-left px-2.5 py-1.5 rounded border transition-colors min-w-[150px] ${
                    overdue
                      ? "border-danger-border/60 bg-danger-surface/30 hover:bg-danger-surface/50"
                      : "border-accent-border/50 bg-accent-muted/20 hover:bg-accent-muted/40"
                  }`}
                >
                  <span className={`text-[9px] font-semibold uppercase tracking-wide ${overdue ? "text-danger" : "text-accent"}`}>
                    Conversion{sourceTank ? ` · ${sourceTank.name}` : ""}
                  </span>
                  <span className="text-xs text-strong truncate">
                    {sourceBatch ? `#${sourceBatch.batch_number} ${sourceBatch.beer_name}` : "—"}
                  </span>
                  {conv.target_batch && (
                    <span className="text-[10px] text-secondary">→ {conv.target_batch.beer_name}</span>
                  )}
                  <span className="text-[10px] text-muted">
                    {conv.planned_date ? fmtDate(conv.planned_date) : "—"}{` · ${Number(conv.volume_bbl).toFixed(1)} BBL`}
                  </span>
                  {sourceTank && <span className="text-[9px] text-accent-emphasis font-medium mt-0.5">Convert →</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Header — mobile new batch, legend, and edit layout controls (desktop) on one row */}
      <div className="flex items-center justify-between gap-2 mb-4">
        {/* Mobile: New Batch shortcut */}
        <button
          onClick={() => { setBatchForm(BATCH_EMPTY); setShowNewBatch(true); }}
          className="md:hidden btn-amber text-xs"
        >
          + New Batch
        </button>

        {/* Desktop: legend (left) + Edit Layout controls (right), same row */}
        <div className="hidden md:flex items-center justify-between w-full gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {EQ_TYPES.map(([type, meta]) => (
              <span key={type} className={`text-xs px-2 py-px rounded border ${meta.badge}`}>
                {meta.label}
              </span>
            ))}
          </div>
          {canEditEquipment && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setEditMode((v) => !v)}
                className={`px-3 py-1.5 text-sm font-medium rounded border transition-colors ${
                  editMode
                    ? "border-accent-border bg-accent-muted/30 text-accent-soft hover:bg-accent-muted/50"
                    : "border-line-strong bg-surface-mid text-secondary hover:text-strong"
                }`}
              >
                {editMode ? "🔓 Editing Layout" : "🔒 Edit Layout"}
              </button>
              {editMode && (
                <button onClick={eqCrud.openNew} className="btn-amber">+ Add Equipment</button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Mobile card list (hidden on md+) ── */}
      <div className="md:hidden">
        {/* Filter bar */}
        <div className="flex gap-2 mb-4 -mx-4 px-4 overflow-x-auto scrollbar-none pb-1">
          <button
            onClick={() => setMobileFilter("all")}
            className={`text-xs px-3 py-1 rounded border whitespace-nowrap transition-colors ${
              mobileFilter === "all" ? "border-line-subtle text-primary bg-surface-mid" : "border-line-strong text-muted"
            }`}
          >
            All
          </button>
          {EQ_TYPES.map(([type, meta]) => (
            <button
              key={type}
              onClick={() => setMobileFilter(type)}
              className={`text-xs px-3 py-1 rounded border whitespace-nowrap transition-colors ${
                mobileFilter === type ? meta.badge : "border-line-strong text-muted"
              }`}
            >
              {meta.label}
            </button>
          ))}
        </div>

        {/* Tank cards */}
        <div className="space-y-3">
          {placed
            .filter((tank) => mobileFilter === "all" || tank.type === mobileFilter)
            .map((tank) => {
              const eq = EQ[tank.type];
              if (!eq) return null;
              const assignment = assignmentByTank[tank.id];
              const batch = assignment?.brew_batches;
              const combinedAssignments = (assignmentsByTank[tank.id] ?? []).filter((a) => a.id !== assignment?.id);
              const isTank = TANK_TYPES.has(tank.type);
              const isColdStorage = tank.type === "cold_storage";
              const isBacklog = tank.type === "backlog";
              const isUnconstrained = UNCONSTRAINED_EQUIPMENT_TYPES.includes(tank.type);
              const volFor = (b: typeof batch) => b ? (tankVolumesByBatch[b.id]?.[tank.id] ?? Number(b.volume_bbl ?? 0)) : 0;
              const ledgerVol = volFor(batch) + combinedAssignments.reduce((s, a) => s + volFor(a.brew_batches), 0);

              return (
                <div key={tank.id} className={`rounded-lg border ${eq.border} overflow-hidden`} style={{ background: "rgba(9,9,11,0.95)" }}>
                  {/* Card header */}
                  <div className={`flex items-center justify-between px-3 py-2 ${eq.headerBg}`}>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-semibold text-primary truncate">{tank.name}</span>
                      <span className={`text-xs px-1.5 py-px rounded border shrink-0 ${eq.badge}`}>{eq.label}</span>
                    </div>
                    {tank.capacity_bbl && !isUnconstrained && (
                      <span className="text-xs text-secondary shrink-0 ml-2">{tank.capacity_bbl} BBL</span>
                    )}
                  </div>

                  {/* Card body */}
                  <div className="px-3 py-2.5">
                    {isBacklog ? (
                      <>
                        {planningBatches.length === 0 ? (
                          <p className="text-sm text-faint">No planned batches</p>
                        ) : (
                          <div className="space-y-1.5">
                            {planningBatches.slice(0, 6).map((b) => (
                              <div key={b.id} className="flex items-baseline gap-2">
                                {b.batch_number && <span className="text-faint font-mono text-xs shrink-0">#{b.batch_number}</span>}
                                <span className="text-strong text-sm truncate">{b.beer_name}</span>
                                <span className="text-faint text-xs shrink-0 ml-auto">{fmtDate(b.planned_brew_date)}</span>
                              </div>
                            ))}
                            {planningBatches.length > 6 && (
                              <p className="text-xs text-faint">+{planningBatches.length - 6} more</p>
                            )}
                          </div>
                        )}
                      </>
                    ) : isTank ? (
                      <>
                        {batch ? (
                          <>
                            <div className="flex items-center gap-2 mb-2">
                              {batch.batch_number && <span className="text-muted font-mono text-xs">#{batch.batch_number}</span>}
                              <span className="text-primary font-medium text-sm">{batch.beer_name}</span>
                            </div>
                            {!isUnconstrained && tank.capacity_bbl && (
                              <>
                                <div className="flex items-center justify-between text-xs mb-1">
                                  <span className="text-muted">{ledgerVol.toFixed(1)} / {tank.capacity_bbl} BBL</span>
                                  <span className="text-faint">{Math.round((ledgerVol / tank.capacity_bbl) * 100)}%</span>
                                </div>
                                <div className="w-full rounded-full overflow-hidden mb-2.5" style={{ height: 4, background: "rgba(63,63,70,0.6)" }}>
                                  <div style={{ height: "100%", width: `${Math.min(100, (ledgerVol / tank.capacity_bbl) * 100).toFixed(1)}%`, background: "rgba(245,158,11,0.7)", borderRadius: "9999px" }} />
                                </div>
                              </>
                            )}
                            {assignment && (
                              <p className="text-xs text-faint mb-2">since {fmtDate(assignment.assigned_at)}</p>
                            )}
                            {combinedAssignments.map((a) => {
                              const otherBatch = a.brew_batches;
                              if (!otherBatch) return null;
                              return (
                                <div key={a.id} className="flex items-center justify-between gap-2 mb-2 pt-2 border-t border-line">
                                  <div className="flex items-center gap-2 min-w-0">
                                    {otherBatch.batch_number && <span className="text-muted font-mono text-xs shrink-0">#{otherBatch.batch_number}</span>}
                                    <span className="text-strong text-sm truncate">{otherBatch.beer_name} <span className="text-faint text-xs">+combined</span></span>
                                  </div>
                                  {!editMode && (
                                    <button
                                      onClick={() => { setTransferTankId(tank.id); setTransferBatchId(otherBatch.id); setTransferFromVol(volFor(otherBatch)); setTransferInitialMode(undefined); setTransferInitialDestId(undefined); setTransferInitialConvert(undefined); }}
                                      className="text-xs text-accent-emphasis hover:text-accent border border-accent-border hover:border-accent-border px-3 py-1.5 rounded transition-colors shrink-0"
                                    >
                                      Transfer
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                            {!editMode && (
                              <button
                                onClick={() => { setTransferTankId(tank.id); setTransferBatchId(batch.id); setTransferFromVol(volFor(batch)); setTransferInitialMode(undefined); setTransferInitialDestId(undefined); setTransferInitialConvert(undefined); }}
                                className="text-xs text-accent-emphasis hover:text-accent border border-accent-border hover:border-accent-border px-3 py-1.5 rounded transition-colors"
                              >
                                Transfer
                              </button>
                            )}
                          </>
                        ) : (() => {
                          const nextPlanned = nextPlannedByTank.get(tank.id);
                          return (
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                {nextPlanned && nextPlanned.brew_batches ? (
                                  <NextPlannedBox
                                    batchNumber={nextPlanned.brew_batches.batch_number}
                                    beerName={nextPlanned.brew_batches.beer_name}
                                    plannedStart={nextPlanned.planned_start}
                                    volumeBbl={nextPlanned.brew_batches.volume_bbl}
                                    size="sm"
                                  />
                                ) : (
                                  <p className="text-sm text-faint">Empty</p>
                                )}
                              </div>
                              {!editMode && tank.type === "brewhouse" && unassignedBatches.length > 0 && (
                                <button
                                  onClick={() => assign.openAssign(tank.id)}
                                  className="text-xs text-accent-emphasis hover:text-accent border border-accent-border hover:border-accent-border px-3 py-1.5 rounded transition-colors shrink-0"
                                >
                                  Assign
                                </button>
                              )}
                            </div>
                          );
                        })()}
                      </>
                    ) : isColdStorage ? (
                      <>
                        {(() => {
                          const coldXfers = transfers.filter(
                            (tr) => tr.to_tank_id === tank.id && (tr.transfer_type === "kegging" || tr.transfer_type === "canning")
                          );
                          return coldXfers.length === 0 ? (
                            <p className="text-sm text-faint">Empty</p>
                          ) : (
                            <div className="space-y-1.5">
                              {coldXfers.map((tr) => {
                                const b = batchById[tr.batch_id];
                                return (
                                  <div key={tr.id} className="flex items-baseline justify-between gap-2">
                                    <span className="text-sm text-body truncate">{b?.beer_name ?? "—"}</span>
                                    <span className="text-xs text-muted shrink-0">
                                      {tr.quantity != null && tr.packaging_variations
                                        ? `${tr.quantity}× ${tr.packaging_variations.name}`
                                        : fmtDate(tr.transferred_at)}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </>
                    ) : (
                      // Kegging / Canning
                      (() => {
                        const pkgBatches = [...new Map(
                          transfers
                            .filter((tr) => tr.to_tank_id === tank.id)
                            .sort((a, b) => new Date(b.transferred_at).getTime() - new Date(a.transferred_at).getTime())
                            .map((tr) => batchById[tr.batch_id])
                            .filter((b): b is BrewBatch => !!b && b.status !== "complete")
                            .map((b) => [b.id, b] as [string, BrewBatch])
                        ).values()];
                        return pkgBatches.length === 0 ? (
                          <p className="text-sm text-faint">Empty</p>
                        ) : (
                          <div className="space-y-2">
                            {pkgBatches.map((b) => (
                              <div key={b.id}>
                                {b.batch_number && <span className="text-xs text-muted font-mono mr-1">#{b.batch_number}</span>}
                                <span className="text-sm text-strong font-medium">{b.beer_name}</span>
                              </div>
                            ))}
                          </div>
                        );
                      })()
                    )}
                  </div>
                </div>
              );
            })}
          {placed.filter((t) => mobileFilter === "all" || t.type === mobileFilter).length === 0 && (
            <p className="text-sm text-faint text-center py-8">No equipment of this type on the floorplan.</p>
          )}
        </div>
      </div>

      {/* ── Desktop-only: unplaced equipment, grid controls, and grid ── */}
      {/* Unplaced equipment — visible in edit mode for brewers/admins */}
      {editMode && canEditEquipment && unplaced.length > 0 && (
        <div
          className={`mb-4 p-3 rounded-lg border border-dashed transition-colors ${
            dragging ? "border-line-subtle bg-surface/40" : "border-line-strong"
          }`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onUnplacedDrop}
        >
          <p className="text-xs text-muted font-medium uppercase tracking-wide mb-2">
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
                  className={`rounded border px-3 py-2 bg-surface ${eq.border} cursor-grab active:cursor-grabbing ${
                    dragging?.id === tank.id ? "opacity-40" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-strong">{tank.name}</span>
                    <span className={`text-xs px-1.5 py-px rounded border ${eq.badge}`}>{eq.label}</span>
                    {tank.capacity_bbl && <span className="text-xs text-faint">{tank.capacity_bbl} BBL</span>}
                    <span className="text-xs text-disabled">{tank.grid_width}×{tank.grid_height}</span>
                  </div>
                  <div className="flex gap-3 mt-1">
                    <button onClick={() => eqCrud.openEdit(tank)} onMouseDown={(e) => e.stopPropagation()} className="text-xs text-faint hover:text-secondary transition-colors">Edit</button>
                    <button onClick={() => eqCrud.handleDeleteEq(tank.id, tank.name)} onMouseDown={(e) => e.stopPropagation()} className="text-xs text-faint hover:text-danger transition-colors">Delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Grid size controls — edit mode, admin only */}
      {editMode && isAdmin && (
        <div className="flex items-center gap-4 mb-3 text-xs text-muted">
          <span className="font-medium text-secondary">Grid size:</span>
          <label className="flex items-center gap-1.5">
            Cols
            <input type="number" min={16} max={80} value={gridCols}
              onChange={(e) => {
                const v = Math.max(16, Math.min(80, parseInt(e.target.value) || GRID_COLS));
                setGridCols(v);
                saveGridSize(v, gridRows);
              }}
              className="w-16 bg-surface-mid border border-line-strong rounded px-1.5 py-0.5 text-strong text-xs" />
          </label>
          <label className="flex items-center gap-1.5">
            Rows
            <input type="number" min={8} max={64} value={gridRows}
              onChange={(e) => {
                const v = Math.max(8, Math.min(64, parseInt(e.target.value) || GRID_ROWS));
                setGridRows(v);
                saveGridSize(gridCols, v);
              }}
              className="w-16 bg-surface-mid border border-line-strong rounded px-1.5 py-0.5 text-strong text-xs" />
          </label>
          <span className="text-disabled">{gridCols * cell}×{gridRows * cell}px</span>
        </div>
      )}

      {/* Grid — scales to fit available width/height (desktop only) */}
      <div ref={scaleContainerRef} className="hidden md:block w-full mb-6" style={{ height: gridRows * cell * gridScale }}>
        <div className="rounded-lg border border-line overflow-hidden origin-top-left" style={{ width: gridCols * cell, height: gridRows * cell, transform: `scale(${gridScale})`, transformOrigin: "top left" }}>
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
            onDragOver={editMode && canEditEquipment ? onGridDragOver : undefined}
            onDrop={editMode && canEditEquipment ? onGridDrop : undefined}
            onDragLeave={() => clearDrag()}
          >
          {placed.map((tank) => {
            const eq          = EQ[tank.type];
            if (!eq) return null;
            const assignment  = assignmentByTank[tank.id];
            const batch       = assignment?.brew_batches;
            // Same-recipe batches can combine in one tank — list any others
            // sharing this tank alongside the primary occupant.
            const combinedAssignments = (assignmentsByTank[tank.id] ?? []).filter((a) => a.id !== assignment?.id);
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
                draggable={editMode && canEditEquipment}
                onDragStart={editMode && canEditEquipment ? (e) => onDragStart(e, tank) : undefined}
                onDragEnd={clearDrag}
                className={`absolute flex flex-col rounded border transition-opacity select-none ${
                  isDragging ? "opacity-30" : "opacity-100"
                } ${editMode && canEditEquipment ? "cursor-grab active:cursor-grabbing" : ""} ${eq.border}`}
                style={{ ...style, background: "rgba(9,9,11,0.88)" }}
              >
                {/* Header: name + type badge + upcoming-plans button on one line */}
                <div className={`shrink-0 px-1.5 py-1 flex items-center justify-between gap-1 min-w-0 ${eq.headerBg}`}>
                  <span className="font-semibold text-primary truncate leading-tight" style={{ fontSize: tiny ? 8 : 10 }}>
                    {tank.name}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    {!tiny && (
                      <span className={`px-1 py-px rounded border leading-none ${eq.badge}`} style={{ fontSize: 7 }}>
                        {eq.label}
                      </span>
                    )}
                    {!tiny && (
                      <button
                        onClick={() => setPlansEquipmentId(tank.id)}
                        onMouseDown={(e) => e.stopPropagation()}
                        title="Upcoming plans for this equipment"
                        className="flex items-center leading-none text-muted hover:text-accent transition-colors"
                      >
                        <CalendarIcon />
                      </button>
                    )}
                  </div>
                </div>

                {/* Body — own scroll region per section, so fixed controls (Transfer/+New)
                    never get pushed out of view by a long or variable-length list above them. */}
                {!tiny && (
                  <div className="flex-1 min-h-0 overflow-hidden px-1.5 py-1 flex flex-col gap-0.5">

                    {/* === Backlog === */}
                    {isBacklog && (
                      <div className="flex-1 min-h-0 flex flex-col gap-0.5">
                        <div className="flex-1 min-h-0 overflow-y-auto">
                          {planningBatches.length === 0 ? (
                            <p className="text-disabled text-center mt-1" style={{ fontSize: 9 }}>No planned batches</p>
                          ) : (
                            <div className="space-y-1.5">
                              {groupByDate(planningBatches, (b) => b.planned_brew_date).map((group) => (
                                <div key={group.date}>
                                  <p className="text-muted font-semibold uppercase tracking-wide" style={{ fontSize: 7 }}>{fmtDate(group.date)}</p>
                                  <div className="space-y-0.5 mt-0.5">
                                    {group.items.map((b) => (
                                      <div key={b.id} className="leading-tight">
                                        <div className="flex items-center justify-between gap-1 min-w-0">
                                          <span className="text-faint font-mono shrink-0" style={{ fontSize: 8 }}>{b.batch_number ? `#${b.batch_number}` : "—"}</span>
                                          {b.volume_bbl != null && (
                                            <span className="text-accent-emphasis/80 font-mono shrink-0" style={{ fontSize: 8 }}>{Number(b.volume_bbl).toFixed(1)} BBL</span>
                                          )}
                                        </div>
                                        <p className="text-body truncate" style={{ fontSize: 9 }} title={b.beer_name}>{b.beer_name}</p>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        {!editMode && (
                          <div className="shrink-0">
                            <button
                              onClick={() => { setBatchForm(BATCH_EMPTY); setShowNewBatch(true); }}
                              onMouseDown={(e) => e.stopPropagation()}
                              className="w-full text-accent-emphasis hover:text-accent border border-accent-border hover:border-accent-border px-1.5 rounded transition-colors"
                              style={{ fontSize: 9 }}
                            >
                              + New Batch
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {/* === Cold Storage === */}
                    {isColdStorage && (
                      <div className="flex-1 min-h-0 overflow-y-auto">
                        {coldTransfers.length === 0 ? (
                          <p className="text-disabled text-center mt-1" style={{ fontSize: 9 }}>Empty</p>
                        ) : (
                          <div className="space-y-1">
                            {coldTransfers.map((tr) => {
                              const b = batchById[tr.batch_id];
                              return (
                                <div key={tr.id} className="flex flex-col gap-0 leading-tight">
                                  <div className="flex items-center gap-1 min-w-0">
                                    <span className="text-body truncate flex-1 min-w-0 font-medium" style={{ fontSize: 9 }} title={b?.beer_name}>{b?.beer_name ?? "—"}</span>
                                    <span className="text-faint shrink-0" style={{ fontSize: 8 }}>{fmtDate(tr.transferred_at)}</span>
                                  </div>
                                  {tr.quantity != null && tr.packaging_variations && (
                                    <span className="text-muted pl-1" style={{ fontSize: 8 }}>{tr.quantity}× {tr.packaging_variations.name}</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {/* === Regular tank (fermenter / brite / brewhouse) === */}
                    {isTank && (() => {
                      // Ledger volume in THIS specific tank, summed across every
                      // batch combined into it (may be a partial split per batch).
                      const volFor = (b: typeof batch) => b ? (tankVolumesByBatch[b.id]?.[tank.id] ?? Number(b.volume_bbl ?? 0)) : 0;
                      const ledgerVol = volFor(batch) + combinedAssignments.reduce((s, a) => s + volFor(a.brew_batches), 0);
                      // Next planned occupant — shown even while this tank is in use, hidden
                      // when it's actually the same batch (e.g. an in-place fermenter → brite move).
                      const nextPlanned = nextPlannedByTank.get(tank.id);
                      const occupantIds = new Set([batch?.id, ...combinedAssignments.map(a => a.brew_batches?.id)]);
                      const nextOccupant = (nextPlanned?.brew_batches && !occupantIds.has(nextPlanned.batch_id)) ? nextPlanned : null;

                      return (
                      <div className="flex-1 min-h-0 flex flex-col gap-0.5">
                        {/* Capacity + fill bar — fixed, always visible */}
                        {!isUnconstrained && tank.capacity_bbl && (
                          <div className="shrink-0">
                            <p className="text-faint" style={{ fontSize: 9 }}>
                              {batch ? `${ledgerVol.toFixed(1)} / ${tank.capacity_bbl} BBL` : `${tank.capacity_bbl} BBL`}
                            </p>
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
                          </div>
                        )}
                        {batch ? (
                          <>
                            {/* Batch identity — fixed, single line, ellipsized rather than wrapped */}
                            <div className="shrink-0 flex items-center gap-1 min-w-0">
                              {batch.batch_number && (
                                <span className="text-muted font-mono shrink-0" style={{ fontSize: 9 }}>#{batch.batch_number}</span>
                              )}
                              <span className="text-strong font-medium truncate flex-1 min-w-0" style={{ fontSize: 10 }} title={batch.beer_name}>
                                {batch.beer_name}
                              </span>
                            </div>
                            {assignment && (
                              <p className="shrink-0 text-faint truncate" style={{ fontSize: 8 }}>since {fmtDate(assignment.assigned_at)}</p>
                            )}

                            {/* Always rendered (even empty) so the Transfer button below stays
                                bottom-pinned at the same position regardless of tile contents —
                                keeps fully-loaded, plan-only, and occupied-only tiles aligned. */}
                            <div className="flex-1 min-h-0 overflow-y-auto space-y-0.5">
                                {nextOccupant && (
                                  <div className="pt-0.5 border-t border-line/60">
                                    <NextPlannedBox
                                      batchNumber={nextOccupant.brew_batches!.batch_number}
                                      beerName={nextOccupant.brew_batches!.beer_name}
                                      plannedStart={nextOccupant.planned_start}
                                      volumeBbl={null}
                                    />
                                  </div>
                                )}
                                {/* Same-recipe batches combined into this tank */}
                                {combinedAssignments.map((a) => {
                                  const otherBatch = a.brew_batches;
                                  if (!otherBatch) return null;
                                  const otherVol = volFor(otherBatch);
                                  return (
                                    <div key={a.id} className="flex items-center gap-1 min-w-0 pt-0.5 border-t border-line/60">
                                      {otherBatch.batch_number && (
                                        <span className="text-muted font-mono shrink-0" style={{ fontSize: 9 }}>#{otherBatch.batch_number}</span>
                                      )}
                                      <span className="text-body truncate flex-1 min-w-0" style={{ fontSize: 9 }} title={otherBatch.beer_name}>
                                        {otherBatch.beer_name} <span className="text-faint">+combined</span>
                                      </span>
                                      {!editMode && (
                                        <button
                                          onClick={() => { setTransferTankId(tank.id); setTransferBatchId(otherBatch.id); setTransferFromVol(otherVol); setTransferInitialMode(undefined); setTransferInitialDestId(undefined); setTransferInitialConvert(undefined); }}
                                          onMouseDown={(e) => e.stopPropagation()}
                                          className="text-accent-emphasis hover:text-accent shrink-0"
                                          style={{ fontSize: 8 }}
                                        >
                                          Transfer
                                        </button>
                                      )}
                                    </div>
                                  );
                                })}
                            </div>

                            {/* Transfer button — fixed, always reachable without scrolling */}
                            {!editMode && (
                              <div className="shrink-0">
                                <button
                                  onClick={() => { setTransferTankId(tank.id); setTransferBatchId(batch.id); setTransferFromVol(volFor(batch)); setTransferInitialMode(undefined); setTransferInitialDestId(undefined); setTransferInitialConvert(undefined); }}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  className="w-full text-accent-emphasis hover:text-accent border border-accent-border hover:border-accent-border px-1.5 rounded transition-colors"
                                  style={{ fontSize: 9 }}
                                >
                                  Transfer
                                </button>
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="flex-1 min-h-0 flex flex-col gap-0.5">
                            {/* Spacer — pushes Next planned + button slot to the bottom,
                                same position they occupy on an occupied tile. */}
                            <div className="flex-1 min-h-0" />
                            {nextPlanned?.brew_batches && (
                              <div className="shrink-0">
                                <NextPlannedBox
                                  batchNumber={nextPlanned.brew_batches.batch_number}
                                  beerName={nextPlanned.brew_batches.beer_name}
                                  plannedStart={nextPlanned.planned_start}
                                  volumeBbl={nextPlanned.brew_batches.volume_bbl}
                                />
                              </div>
                            )}
                            {!nextPlanned?.brew_batches && (
                              <p className="shrink-0 text-disabled" style={{ fontSize: 9 }}>Empty</p>
                            )}
                            {/* Button slot — always reserved, even when no button renders,
                                so Next planned sits at the same height as the Transfer slot
                                on an occupied tile. */}
                            <div className="shrink-0" style={{ minHeight: !editMode && tank.type === "brewhouse" && unassignedBatches.length > 0 ? undefined : 18 }}>
                              {!editMode && tank.type === "brewhouse" && unassignedBatches.length > 0 && (
                                <button
                                  onClick={() => assign.openAssign(tank.id)}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  className="w-full text-accent-emphasis hover:text-accent border border-accent-border hover:border-accent-border px-1.5 rounded transition-colors"
                                  style={{ fontSize: 9 }}
                                >
                                  Assign
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                      ); })()}

                    {/* === Kegging / Canning (unconstrained — derive active batches from transfers) === */}
                    {!isTank && !isColdStorage && !isBacklog && (
                      (() => {
                        // Most-recent incoming pkg transfer per batch → used to show packaging output
                        const incomingByBatch = new Map<string, typeof transfers[0][]>();
                        for (const tr of transfers) {
                          if (tr.to_tank_id !== tank.id) continue;
                          if (tr.transfer_type !== "kegging" && tr.transfer_type !== "canning") continue;
                          const existing = incomingByBatch.get(tr.batch_id) ?? [];
                          if (existing.length === 0) {
                            incomingByBatch.set(tr.batch_id, [tr]);
                          } else if (new Date(tr.transferred_at).getTime() === new Date(existing[0].transferred_at).getTime()) {
                            incomingByBatch.set(tr.batch_id, [...existing, tr]);
                          } else if (new Date(tr.transferred_at) > new Date(existing[0].transferred_at)) {
                            incomingByBatch.set(tr.batch_id, [tr]);
                          }
                        }

                        const pkgBatches = [...new Map(
                          transfers
                            .filter((tr) => tr.to_tank_id === tank.id)
                            .sort((a, b) => new Date(b.transferred_at).getTime() - new Date(a.transferred_at).getTime())
                            .map((tr) => batchById[tr.batch_id])
                            .filter((b): b is BrewBatch => !!b && b.status !== "complete")
                            .map((b) => [b.id, b] as [string, BrewBatch])
                        ).values()];

                        // Upcoming kegging/canning days scheduled at this tank — not yet executed.
                        const upcomingPkg = upcomingByEquipment.get(tank.id) ?? [];

                        const upcomingSection = upcomingPkg.length > 0 && (
                          <div className={pkgBatches.length > 0 ? "mt-1.5 pt-1.5 border-t border-line/60 space-y-1.5" : "space-y-1.5"}>
                            <p className="text-muted font-semibold uppercase tracking-wide" style={{ fontSize: 7 }}>Upcoming</p>
                            {groupByDate(upcomingPkg, (e) => e.planned_start).map((group) => (
                              <div key={group.date}>
                                <p className="text-muted" style={{ fontSize: 8 }}>{fmtDate(group.date)}</p>
                                <div className="space-y-0.5 mt-0.5">
                                  {group.items.map((e) => (
                                    <div key={e.id} className="leading-tight">
                                      <div className="flex items-center justify-between gap-1 min-w-0">
                                        <span className="text-faint font-mono shrink-0" style={{ fontSize: 8 }}>{e.brew_batches?.batch_number ? `#${e.brew_batches.batch_number}` : "—"}</span>
                                        {e.volume_bbl != null && (
                                          <span className="text-accent-emphasis/80 font-mono shrink-0" style={{ fontSize: 8 }}>{Number(e.volume_bbl).toFixed(1)} BBL</span>
                                        )}
                                      </div>
                                      <p className="text-body truncate" style={{ fontSize: 9 }} title={e.brew_batches?.beer_name}>{e.brew_batches?.beer_name ?? "—"}</p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        );

                        return (
                          <div className="flex-1 min-h-0 overflow-y-auto">
                            {pkgBatches.length > 0 ? (
                              <div className="space-y-1.5">
                                {pkgBatches.map((b) => {
                                  const incoming = incomingByBatch.get(b.id) ?? [];
                                  return (
                                    <div key={b.id} className="flex flex-col gap-0.5">
                                      {/* Batch identity */}
                                      <div className="flex items-center gap-1 min-w-0">
                                        {b.batch_number && (
                                          <span className="text-muted font-mono shrink-0" style={{ fontSize: 9 }}>#{b.batch_number}</span>
                                        )}
                                        <span className="text-strong font-medium truncate flex-1 min-w-0" style={{ fontSize: 10 }} title={b.beer_name}>
                                          {b.beer_name}
                                        </span>
                                      </div>

                                      {/* Packaging output */}
                                      {incoming.filter((tr) => tr.variation_id && tr.packaging_variations).length > 0 && (
                                        <div className="space-y-px">
                                          {incoming.filter((tr) => tr.variation_id && tr.packaging_variations).map((tr) => (
                                            <div key={tr.id} className="flex items-center gap-1 min-w-0">
                                              <span className="text-accent font-mono font-semibold shrink-0" style={{ fontSize: 9 }}>{tr.quantity}×</span>
                                              <span className="text-secondary truncate" style={{ fontSize: 9 }} title={tr.packaging_variations!.name}>{tr.packaging_variations!.name}</span>
                                            </div>
                                          ))}
                                        </div>
                                      )}

                                    </div>
                                  );
                                })}
                                {upcomingSection}
                              </div>
                            ) : (
                              <div className="flex flex-col gap-1">
                                {upcomingPkg.length === 0 && (
                                  <p className="text-disabled text-center" style={{ fontSize: 9 }}>Empty</p>
                                )}
                                {upcomingSection}
                              </div>
                            )}
                          </div>
                        );
                      })()
                    )}

                    {/* Edit mode controls — brewer/admin only */}
                    {editMode && canEditEquipment && (
                      <div className="mt-auto pt-1 flex gap-1.5">
                        <button onClick={() => eqCrud.openEdit(tank)} onMouseDown={(e) => e.stopPropagation()} className="text-faint hover:text-body transition-colors" style={{ fontSize: 9 }}>Edit</button>
                        <button onClick={() => removeFromGrid(tank.id)} onMouseDown={(e) => e.stopPropagation()} className="text-faint hover:text-accent transition-colors" style={{ fontSize: 9 }}>Unplace</button>
                        {!assignment && <button onClick={() => eqCrud.handleDeleteEq(tank.id, tank.name)} onMouseDown={(e) => e.stopPropagation()} className="text-faint hover:text-danger transition-colors" style={{ fontSize: 9 }}>Del</button>}
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
                dropPreview.valid ? "border-accent bg-accent-muted/15" : "border-danger-border bg-danger-surface/15"
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
                        ? "border-accent-border bg-accent-muted/30 text-accent-soft"
                        : "border-line-strong bg-surface-mid/50 text-secondary hover:border-line-subtle"
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
                  <p className="text-xs text-faint mt-0.5">No capacity constraint for this type</p>
                )}
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Width (cells)">
                  <input type="number" min="1" max="20" className="inp" value={eqCrud.eqForm.grid_width}
                    onChange={(e) => eqCrud.setEqForm((f) => ({ ...f, grid_width: e.target.value }))} />
                </Field>
                <Field label="Height (cells)">
                  <input type="number" min="1" max="20" className="inp" value={eqCrud.eqForm.grid_height}
                    onChange={(e) => eqCrud.setEqForm((f) => ({ ...f, grid_height: e.target.value }))} />
                </Field>
              </div>
            </div>
            <Field label="Notes">
              <input className="inp" value={eqCrud.eqForm.notes}
                onChange={(e) => eqCrud.setEqForm((f) => ({ ...f, notes: e.target.value }))} />
            </Field>
            <p className="text-xs text-faint">
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
          occupiedTankRecipeIds={occupiedTankRecipeIds}
          recipePackagingVariations={recipePackagingVariations}
          allPackagingVariations={allPackagingVariations}
          recipes={recipes}
          batches={batches}
          fromTankVolume={transferFromVol}
          plannedEntry={transferPlannedEntry}
          initialDestId={transferInitialDestId}
          initialMode={transferInitialMode}
          initialConvert={transferInitialConvert}
          onClose={() => {
            setTransferTankId(null);
            setTransferBatchId(null);
            setTransferFromVol(undefined);
            setTransferInitialDestId(undefined);
            setTransferInitialMode(undefined);
            setTransferInitialConvert(undefined);
          }}
          onDone={handleTransferDone}
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
                  <option key={r.id} value={r.id}>{r.beer_name}{r.partner?.company_name ? ` · ${r.partner.company_name}` : ""}</option>
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
                  <p className="text-xs text-faint mt-1">Auto-set from recipe lead time: {leadDays} days</p>
                ) : null;
              })()}
            </Field>
            <Field label={`Turns (${BREWHOUSE_BBL} BBL brewhouse)`} required>
              <input type="number" min="1" step="1" className="inp" value={batchForm.turns} required
                onChange={(e) => setBatchForm((f) => ({ ...f, turns: e.target.value }))} />
              {(() => {
                const r = recipes.find((r) => r.id === batchForm.recipe_id);
                const brewVol = (BREWHOUSE_BBL * (parseInt(batchForm.turns) || 1)).toFixed(2);
                const expectedYield = r?.expected_yield_bbl != null ? (r.expected_yield_bbl * (parseInt(batchForm.turns) || 1)).toFixed(2) : null;
                return (
                  <p className="text-xs text-muted mt-1">
                    Brew volume: <span className="text-body font-medium">{brewVol} BBL</span>
                    {expectedYield && <span className="text-faint ml-1">· expected yield {expectedYield} BBL after shrinkage</span>}
                  </p>
                );
              })()}</Field>
            <Field label="Notes">
              <textarea className="inp resize-none" rows={2} value={batchForm.notes}
                onChange={(e) => setBatchForm((f) => ({ ...f, notes: e.target.value }))} />
            </Field>
            <ModalActions submitting={batchSubmitting} onCancel={() => setShowNewBatch(false)} label="Create Batch" />
          </form>
        </Modal>
      )}

      {/* Upcoming plans for a single piece of equipment */}
      {plansEquipment && (
        <Modal title={`Upcoming plans — ${plansEquipment.name}`} onClose={() => setPlansEquipmentId(null)}>
          {(upcomingByEquipment.get(plansEquipment.id) ?? []).length === 0 ? (
            <p className="text-sm text-muted">Nothing scheduled for this equipment.</p>
          ) : (
            <div className="space-y-2 max-h-[60vh] overflow-y-auto">
              {(upcomingByEquipment.get(plansEquipment.id) ?? []).map((e) => {
                const overdue = e.planned_start.slice(0, 10) < new Date().toISOString().slice(0, 10);
                return (
                  <div key={e.id} className={`rounded border px-3 py-2 ${overdue ? "border-danger-border/60 bg-danger-surface/20" : "border-line-strong bg-surface-mid/40"}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-xs font-semibold uppercase tracking-wide ${overdue ? "text-danger" : "text-accent-emphasis"}`}>
                        {STAGE_LABELS[e.stage] ?? e.stage}
                      </span>
                      <span className="text-xs text-muted">{fmtDate(e.planned_start)} → {fmtDate(e.planned_end)}</span>
                    </div>
                    <p className="text-sm text-strong mt-0.5">
                      {e.brew_batches ? `#${e.brew_batches.batch_number} ${e.brew_batches.beer_name}` : "—"}
                    </p>
                    {e.volume_bbl != null && (
                      <p className="text-xs text-muted mt-0.5">{Number(e.volume_bbl).toFixed(2)} BBL</p>
                    )}
                    {e.notes && (
                      <p className="text-xs text-faint mt-0.5 italic">{e.notes}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
