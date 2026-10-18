"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Equipment, BrewBatch, BatchTankAssignment, UNCONSTRAINED_EQUIPMENT_TYPES } from "../types";
import { computeTankVolumes, hasLedgerActivity } from "@/lib/production/volumeLedger";
import { Modal, Field, ModalActions } from "./shared";
import { EQ, EQ_TYPES } from "../equipmentMeta";
import { GRID_CELL_PX as CELL, GRID_COLS, GRID_ROWS, GRID_GAP_PX as GAP } from "@/lib/constants/production";
import { fmtDate } from "@/lib/utils/formatting";
import TransferModal from "./TransferModal";
import UndoTransferActions from "./UndoTransferActions";
import NextPlannedBox from "./FloorplanTile/NextPlannedBox";
import IngredientShortfallModal from "./IngredientShortfallModal";
import type { IngredientShortfall } from "@/lib/production/commitments";
import { useTankDragDrop } from "../hooks/useTankDragDrop";
import { useEquipmentCrud } from "../hooks/useEquipmentCrud";
import { useBatchAssign } from "../hooks/useBatchAssign";
import {
  useRecipePackagingVariationsQuery, usePackagingVariationsQuery, useEquipmentQuery, useAssignmentsQuery, useBatchesQuery,
  useTransfersQuery, useRecipesQuery, useBatchScheduleQuery, useBatchConversionsQuery, useColdStorageQuery,
  productionKeys, type ScheduleEntry,
} from "../hooks/queries";
import { usePermissions } from "@/lib/hooks/useUserRole";
import { CAP } from "@/lib/auth/capabilities";
import { STAGE_LABELS } from "./EquipmentSchedule/constants";
import { isInPlaceConditioning } from "@/lib/production/inPlaceConditioning";
import ToggleChip from "@/app/components/ui/ToggleChip";
import ScheduleBatchModal from "./intake/ScheduleBatchModal";


const TANK_TYPES = new Set(["fermenter", "brite", "brewhouse"]);
// Stages whose schedule entries carry a packaging volume that can be fulfilled
// by a different run — see isPendingWork.
const PACKAGING_STAGES = new Set(["kegging", "canning"]);

// The Up next strip shows this many rows before folding the rest behind "+N more".
const UP_NEXT_VISIBLE = 5;
// Collapsed desktop banner: this many chips before "+N more".
const UP_NEXT_CHIPS = 3;
// On a wide monitor the grid grows past its natural 1152px up to this factor, so
// the right-hand third of a 1920px screen is not left empty.
const GRID_MAX_SCALE = 1.5;

// A brewed batch whose ingredients were not all drawn. Each turn's draw
// happens when the turn starts (tank-assignments route), and `turns_completed`
// counts the turns that drew. A gap means the grain is still on the Raw
// Materials shelf AND costed into the batch, so the books double-count it
// until the next ingredient count — flag it the day it happens.
function drawGap(b: BrewBatch | null | undefined): string | null {
  if (!b || b.status === "planning" || b.status === "complete" || b.converted_from_batch_id) return null;
  const drawn = Number(b.turns_completed ?? 0);
  const turns = Number(b.turns ?? 1);
  if (drawn >= turns) return null;
  return `Ingredients drawn for ${drawn} of ${turns} turn${turns === 1 ? "" : "s"} — start the remaining turn(s) from the tank so the grain leaves the shelf`;
}

// A packaging variation is usually named "<Beer> - <package>" ("CBC Epic Hazy
// IPA - 16oz Labeled Can 4-Pack"). Next to the beer's own column that prefix is
// noise, so show just the package part when the name has one.
function packageLabel(variation: string | null | undefined): string {
  if (!variation) return "";
  const i = variation.indexOf(" - ");
  return i > 0 ? variation.slice(i + 3) : variation;
}

type LotRow = { key: string; title: string; subtitle?: string; pkg: string; qty: number | string | null; onClick?: () => void };

// The dense three-column table used by the Cold Storage, Kegging and Canning
// tiles: what | package | qty. Fixed column widths so the eye scans a column
// instead of re-parsing every line; header only when there is room for it.
function LotTable({ rows, empty, qtyLabel }: { rows: LotRow[]; empty: string; qtyLabel: string }) {
  if (rows.length === 0) return <p className="text-disabled text-center mt-1" style={{ fontSize: 11 }}>{empty}</p>;
  return (
    <table className="w-full table-fixed border-collapse" style={{ fontSize: 11 }}>
      <colgroup><col style={{ width: "48%" }} /><col style={{ width: "40%" }} /><col style={{ width: "12%" }} /></colgroup>
      <thead className="sticky top-0 bg-surface">
        <tr className="text-faint uppercase tracking-wide" style={{ fontSize: 11 }}>
          <th className="text-left font-semibold py-px">Beer</th>
          <th className="text-left font-semibold py-px">Package</th>
          <th className="text-right font-semibold py-px">{qtyLabel}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-line/40 leading-tight">
            <td className="py-px pr-1 truncate text-strong font-medium" title={r.subtitle ? `${r.title} · ${r.subtitle}` : r.title}>
              {r.subtitle && <span className="text-muted font-mono font-normal">{r.subtitle} </span>}{r.title}
            </td>
            <td className="py-px pr-1 truncate text-muted" title={r.pkg}>{r.pkg}</td>
            <td className="py-px text-right font-mono text-strong">{r.qty ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
  const { can } = usePermissions();
  const canEditEquipment = can(CAP.equipmentManage);
  const canOperate = can(CAP.brewingOperate);
  const { data: tanks = [] } = useEquipmentQuery();
  const { data: assignments = [] } = useAssignmentsQuery();
  const { data: batches = [] } = useBatchesQuery();
  const { data: transfers = [] } = useTransfersQuery();
  const { data: coldStorageLots = [] } = useColdStorageQuery();
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
    qc.invalidateQueries({ queryKey: productionKeys.coldStorage }),
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
  const [upNextExpanded, setUpNextExpanded] = useState(false);
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

  // New batches are created by the one Schedule form (tanks + allocations at birth).
  const [showNewBatch, setShowNewBatch] = useState(false);

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
  // Batches the ledger has anything to say about. A batch missing from this set
  // has no recorded movements at all, so a tile showing it may fall back to the
  // batch's headline volume; a batch IN the set is described entirely by
  // tankVolumesByBatch, and a tank absent from that map holds nothing.
  const batchesWithLedger = new Set<string>();
  for (const b of batches) {
    tankVolumesByBatch[b.id] = computeTankVolumes(b.id, Number(b.volume_bbl ?? 0), transfers);
    if (hasLedgerActivity(b.id, transfers)) batchesWithLedger.add(b.id);
  }

  // Volume this batch holds in one specific tank.
  //
  // The fallback to the batch's headline volume answers "the ledger has never
  // heard of this batch, so assume it is all here" — true for a batch dropped
  // straight into a tank with no transfer behind it. It must NOT answer "the
  // ledger knows this batch but places none of it here": that reads a tank the
  // ledger says is empty as holding the entire batch, which is how B-059 and
  // B-060 each appeared in two tanks at once after a 0 BBL transfer.
  const volumeInTank = (batchId: string | undefined, headlineVol: number, tankId: string): number => {
    if (!batchId) return 0;
    const known = tankVolumesByBatch[batchId]?.[tankId];
    if (known != null) return known;
    return batchesWithLedger.has(batchId) ? 0 : headlineVol;
  };

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

  // An entry only represents outstanding work if it hasn't started, hasn't been
  // cancelled, belongs to a batch that is still in progress, and still has volume
  // attached. The last two matter for packaging: a completed batch has nothing
  // left to keg or can, and a packaging entry whose volume was clawed back to
  // zero by an unscheduled run was already fulfilled elsewhere. Without these,
  // B-038 kept advertising a 2026-07-14 Canning action months after completing.
  // Flattened, globally-sorted pending tasks — the top "what's next" banner.
  const upcomingTasks = React.useMemo(() => {
    const statusByBatchId = new Map(batches.map((b) => [b.id, b.status]));
    const isPendingWork = (entry: ScheduleEntry) => {
      if (!entry.equipment_id || entry.cancelled_at || entry.actual_start) return false;
      const batchStatus = entry.brew_batches?.status ?? statusByBatchId.get(entry.batch_id);
      if (batchStatus === "complete") return false;
      if (PACKAGING_STAGES.has(entry.stage) && entry.volume_bbl != null && Number(entry.volume_bbl) <= 0.001) return false;
      return true;
    };
    return scheduleEntries
      .filter(isPendingWork)
      .sort((a, b) => a.planned_start.localeCompare(b.planned_start));
  }, [scheduleEntries, batches]);

  // The same pending entries bucketed per equipment, earliest first — backs the
  // per-equipment "Plans" popup. Derived from upcomingTasks so both views can
  // never disagree about what counts as outstanding work.
  const upcomingByEquipment = React.useMemo(() => {
    const map = new Map<string, ScheduleEntry[]>();
    for (const entry of upcomingTasks) {
      (map.get(entry.equipment_id!) ?? map.set(entry.equipment_id!, []).get(entry.equipment_id!)!).push(entry);
    }
    return map;
  }, [upcomingTasks]);

  // The Up Next banner is for things a brewer has to do. Conditioning in the
  // same fermenter isn't one — it starts on its planned date by itself. Nor is
  // a leftover plan for a vessel stage the batch has already entered in that
  // same tank (B-033 kept a stale 8/1 brite 34 card after moving in on 8/14).
  const upNextTasks = React.useMemo(() => {
    const alreadyThere = (e: ScheduleEntry) => !PACKAGING_STAGES.has(e.stage) && scheduleEntries.some((o) =>
      o.id !== e.id && o.batch_id === e.batch_id && o.stage === e.stage
      && o.equipment_id === e.equipment_id && !o.cancelled_at && !!o.actual_start,
    );
    return upcomingTasks.filter((e) => !isInPlaceConditioning(e, scheduleEntries) && !alreadyThere(e));
  }, [upcomingTasks, scheduleEntries]);

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
    // A transfer to a specific planned tank: open Transfer mode with that tank pre-selected as the
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
    // Fit the width, and also the viewport height left below the grid's top edge
    // so the whole floorplan is on screen without scrolling — but never shrink
    // below 0.9 for height alone, or the 11px tile text stops being readable.
    const obs = new ResizeObserver(([entry]) => {
      const { width } = entry.contentRect;
      const naturalW = gridCols * cell;
      const naturalH = gridRows * cell;
      const availH = window.innerHeight - el.getBoundingClientRect().top - 24;
      const heightScale = availH > 0 ? Math.max(0.9, availH / naturalH) : 1;
      setGridScale(Math.min(GRID_MAX_SCALE, width / naturalW, heightScale));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [gridCols, gridRows, cell]);

  // Destructure so the ref (gridRef) and state (dragging/dropPreview/…) keep
  // distinct identities — otherwise the React Compiler taints every access on
  // the returned object as "accessing refs during render".
  const {
    dragging, dropPreview, gridRef, draggingTank, ghost,
    onPointerDown, removeFromGrid,
  } = useTankDragDrop(tanks, onRefresh, gridScale, gridCols, gridRows);
  const eqCrud = useEquipmentCrud(onRefresh);
  const assign = useBatchAssign(unassignedBatches, onRefresh);
  // Shortfall detail opened from a blocked brewhouse assignment.
  const [shortfallDetail, setShortfallDetail] =
    useState<{ shortfalls: IngredientShortfall[]; batchLabel: string | null } | null>(null);

  return (
    <>
      {/* Deviation toast */}
      {deviationToast && (
        <div className="fixed bottom-[calc(1.5rem+var(--mobile-nav-space))] right-6 z-50 flex items-start gap-3 px-4 py-3 rounded-lg border border-accent-border/60 bg-accent-muted shadow-xl text-sm text-accent-soft max-w-sm">
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

      {/* Up next — one row per pending task or conversion, soonest first,
          with the floorplan controls (Undo / Edit Layout) on the header row
          so they don't need a row of their own. */}
      {(() => {
        const today = new Date().toISOString().slice(0, 10);
        type Row = { key: string; overdue: boolean; stage: string; where: string; what: string; when: string; action: string | null; onClick: () => void; isConversion: boolean };
        const rows: Row[] = [
          ...upNextTasks.map((e): Row => {
            const b = e.brew_batches ?? (e.batch_id ? batchById[e.batch_id] : null);
            const eqName = e.equipment?.name ?? tanks.find(t => t.id === e.equipment_id)?.name ?? "—";
            return {
              key: e.id,
              overdue: e.planned_start.slice(0, 10) < today,
              stage: STAGE_LABELS[e.stage] ?? e.stage,
              where: eqName,
              what: b ? `#${b.batch_number} ${b.beer_name}` : "—",
              when: `${fmtDate(e.planned_start)}${e.volume_bbl != null ? ` · ${Number(e.volume_bbl).toFixed(1)} BBL` : ""}`,
              action: currentTankByBatchId[e.batch_id] ? "Transfer" : null,
              onClick: () => openUpNextAction(e),
              isConversion: false,
            };
          }),
          ...pendingConversions.map((conv): Row => {
            const sourceBatch = batchById[conv.source_batch_id];
            const sourceTank = conv.source_equipment_id ? tanks.find(t => t.id === conv.source_equipment_id) : null;
            return {
              key: conv.id,
              overdue: conv.planned_date ? conv.planned_date < today : false,
              stage: "Conversion",
              where: sourceTank?.name ?? "—",
              what: `${sourceBatch ? `#${sourceBatch.batch_number} ${sourceBatch.beer_name}` : "—"}${conv.target_batch ? ` → ${conv.target_batch.beer_name}` : ""}`,
              when: `${conv.planned_date ? fmtDate(conv.planned_date) : "—"} · ${Number(conv.volume_bbl).toFixed(1)} BBL`,
              action: sourceTank ? "Convert" : null,
              onClick: () => openPendingConversionAction(conv.id),
              isConversion: true,
            };
          }),
        ];
        const overdueCount = rows.filter((r) => r.overdue).length;
        // Collapsed: one line — count, overdue count, then the soonest few as
        // clickable chips. Expanded: every row. Height is the scarce resource on a
        // laptop (the grid alone is 768px), so the banner stays one line by default.
        return (
          <div className="mb-3 rounded-lg border border-line bg-surface/50 px-3 py-1.5">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setUpNextExpanded((v) => !v)}
                  aria-expanded={upNextExpanded}
                  className="shrink-0 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-strong transition-colors"
                >
                  <span aria-hidden className="inline-block transition-transform" style={{ transform: upNextExpanded ? "rotate(90deg)" : "none" }}>▸</span>
                  Up next
                  {rows.length > 0 && <span className="font-normal normal-case tracking-normal text-faint">· {rows.length}</span>}
                  {overdueCount > 0 && <span className="font-normal normal-case tracking-normal text-danger">· {overdueCount} overdue</span>}
                </button>
                {!upNextExpanded && rows.length > 0 && (
                  <div className="hidden md:flex items-center gap-1.5 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
                    {rows.slice(0, UP_NEXT_CHIPS).map((r) => (
                      <button
                        key={r.key}
                        onClick={r.onClick}
                        title={`${r.stage} · ${r.where} · ${r.what} · ${r.when}`}
                        className={`shrink-0 max-w-[220px] truncate text-xs px-2 py-px rounded border transition-colors ${
                          r.overdue
                            ? "border-danger-border/60 text-danger hover:bg-danger-surface/40"
                            : "border-line-strong/60 text-body hover:bg-surface-mid/60"
                        }`}
                      >
                        <span className={`font-semibold ${r.overdue ? "" : r.isConversion ? "text-accent" : "text-accent-emphasis"}`}>{r.stage}</span>
                        <span className="text-muted"> {r.where.toLowerCase() === r.stage.toLowerCase() ? "" : `${r.where} · `}</span>{r.what}
                        <span className="text-muted"> · {r.when.split(" · ")[0]}</span>
                      </button>
                    ))}
                    </div>
                    {rows.length > UP_NEXT_CHIPS && (
                      <button onClick={() => setUpNextExpanded(true)} className="shrink-0 text-xs text-accent-emphasis hover:underline whitespace-nowrap">
                        +{rows.length - UP_NEXT_CHIPS} more
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="hidden md:flex items-center gap-2 shrink-0">
                {canOperate && <UndoTransferActions onUndone={onRefresh} />}
                {canEditEquipment && (
                  <>
                    <button onClick={() => setEditMode((v) => !v)} aria-pressed={editMode} className="btn-secondary">
                      {editMode ? "🔓 Editing Layout" : "🔒 Edit Layout"}
                    </button>
                    {editMode && <button onClick={eqCrud.openNew} className="btn-primary">+ Add Equipment</button>}
                  </>
                )}
              </div>
            </div>
            {rows.length === 0 ? (
              <p className="text-xs text-faint mt-1">Nothing scheduled.</p>
            ) : (
              /* Mobile has no chip row, so it always lists the first few; desktop lists only when expanded. */
              <ul className={`mt-0.5 divide-y divide-line/60 ${upNextExpanded ? "" : "md:hidden"}`}>
                {(upNextExpanded ? rows : rows.slice(0, UP_NEXT_VISIBLE)).map((r) => (
                  <li key={r.key}>
                    <button
                      onClick={r.onClick}
                      className={`w-full flex items-center gap-2 text-left py-0.5 text-xs rounded transition-colors hover:bg-surface-mid/60 ${r.overdue ? "text-danger" : "text-body"}`}
                    >
                      <span className={`font-semibold uppercase tracking-wide shrink-0 w-24 truncate ${r.overdue ? "text-danger" : r.isConversion ? "text-accent" : "text-accent-emphasis"}`}>{r.stage}</span>
                      <span className="shrink-0 w-24 truncate text-secondary" title={r.where}>{r.where}</span>
                      <span className="flex-1 min-w-0 truncate text-strong" title={r.what}>{r.what}</span>
                      <span className="shrink-0 text-muted">{r.when}</span>
                      {r.action && <span className="shrink-0 w-16 text-right text-accent-emphasis font-medium">{r.action} →</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {upNextExpanded && (
              <button onClick={() => setUpNextExpanded(false)} className="mt-0.5 text-xs text-accent-emphasis hover:underline">
                Collapse
              </button>
            )}
          </div>
        );
      })()}

      {/* Mobile-only: New Batch shortcut + Undo (desktop controls live on the Up next row) */}
      <div className="md:hidden flex items-center justify-between gap-2 mb-4">
        <button onClick={() => setShowNewBatch(true)} className="btn-primary">+ New Batch</button>
        {canOperate && <UndoTransferActions onUndone={onRefresh} />}
      </div>

      {/* ── Mobile card list (hidden on md+) ── */}
      <div className="md:hidden">
        {/* Filter bar */}
        <div className="flex gap-2 mb-4 -mx-4 px-4 scroll-x pb-1">
          <ToggleChip active={mobileFilter === "all"} onClick={() => setMobileFilter("all")} className="whitespace-nowrap">
            All
          </ToggleChip>
          {EQ_TYPES.map(([type, meta]) => (
            <ToggleChip
              key={type}
              active={mobileFilter === type}
              onClick={() => setMobileFilter(type)}
              className={`whitespace-nowrap ${mobileFilter === type ? meta.badge : ""}`}
            >
              {meta.label}
            </ToggleChip>
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
              const volFor = (b: typeof batch) => volumeInTank(b?.id, Number(b?.volume_bbl ?? 0), tank.id);
              const ledgerVol = volFor(batch) + combinedAssignments.reduce((s, a) => s + volFor(a.brew_batches), 0);

              return (
                <div key={tank.id} className={`rounded-lg border ${eq.border} overflow-hidden`} style={{ background: "color-mix(in srgb, var(--color-surface) 95%, transparent)" }}>
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
                              {drawGap(batchById[batch.id]) && (
                                <span className="text-xs px-1.5 py-px rounded border border-danger-border bg-danger-surface/40 text-danger shrink-0" title={drawGap(batchById[batch.id])!}>
                                  Ingredients not drawn
                                </span>
                              )}
                            </div>
                            {!isUnconstrained && tank.capacity_bbl && (
                              <>
                                <div className="flex items-center justify-between text-xs mb-1">
                                  <span className="text-muted">{ledgerVol.toFixed(1)} / {tank.capacity_bbl} BBL</span>
                                  <span className="text-faint">{Math.round((ledgerVol / tank.capacity_bbl) * 100)}%</span>
                                </div>
                                <div className="w-full rounded-full overflow-hidden mb-2.5" style={{ height: 4, background: "color-mix(in srgb, var(--color-line-strong) 60%, transparent)" }}>
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
                                      className="btn-primary btn-xxs shrink-0"
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
                                className="btn-primary btn-xxs"
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
                                  className="btn-primary btn-xxs shrink-0"
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
                          return coldStorageLots.length === 0 ? (
                            <p className="text-sm text-faint">Empty</p>
                          ) : (
                            <div className="space-y-1.5">
                              {coldStorageLots.map((lot) => (
                                <div key={lot.id} className="flex items-baseline justify-between gap-2">
                                  <span className="text-sm text-body truncate">{lot.beer_name ?? "—"}</span>
                                  <span className="text-xs text-muted shrink-0">
                                    {lot.quantity_on_hand}{lot.variation_name ? `× ${lot.variation_name}` : ""}
                                  </span>
                                </div>
                              ))}
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
        >
          <p className="text-xs text-muted font-medium uppercase tracking-wide mb-2">
            Unplaced Equipment — drag onto the grid to place; drag a tile off the grid to unplace
          </p>
          <div className="flex flex-wrap gap-2">
            {unplaced.map((tank) => {
              const eq = EQ[tank.type];
              if (!eq) return null;
              return (
                <div
                  key={tank.id}
                  onPointerDown={(e) => onPointerDown(e, tank, false)}
                  className={`rounded border px-3 py-2 bg-surface ${eq.border} cursor-grab active:cursor-grabbing touch-none ${
                    dragging?.id === tank.id ? "opacity-40" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-strong">{tank.name}</span>
                    <span className={`text-xs px-1.5 py-px rounded border ${eq.badge}`}>{eq.label}</span>
                    {tank.capacity_bbl && <span className="text-xs text-faint">{tank.capacity_bbl} BBL</span>}
                    <span className="text-xs text-disabled">{tank.grid_width}×{tank.grid_height}</span>
                  </div>
                  <div className="flex gap-1 mt-1">
                    <button onClick={() => eqCrud.openEdit(tank)} onMouseDown={(e) => e.stopPropagation()} className="btn-secondary btn-xxs">Edit</button>
                    <button onClick={() => eqCrud.handleDeleteEq(tank.id, tank.name)} onMouseDown={(e) => e.stopPropagation()} className="btn-danger btn-xxs">Delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Grid size controls — edit mode, requires equipment manage */}
      {editMode && canEditEquipment && (
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
              className="inp-sm w-16" />
          </label>
          <label className="flex items-center gap-1.5">
            Rows
            <input type="number" min={8} max={64} value={gridRows}
              onChange={(e) => {
                const v = Math.max(8, Math.min(64, parseInt(e.target.value) || GRID_ROWS));
                setGridRows(v);
                saveGridSize(gridCols, v);
              }}
              className="inp-sm w-16" />
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
                `linear-gradient(to right, color-mix(in srgb, var(--color-line-strong) 22%, transparent) 1px, transparent 1px)`,
                `linear-gradient(to bottom, color-mix(in srgb, var(--color-line-strong) 22%, transparent) 1px, transparent 1px)`,
              ].join(","),
              backgroundSize: `${cell}px ${cell}px`,
            }}
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
            const isBrewhouse = tank.type === "brewhouse";
            const isUnconstrained = UNCONSTRAINED_EQUIPMENT_TYPES.includes(tank.type);

            const style = eqStyle(tank, cell);
            const pixW  = tank.grid_width  * cell - GAP * 2;
            const pixH  = tank.grid_height * cell - GAP * 2;
            const tiny  = pixW < 56 || pixH < 56;

            return (
              <div
                key={tank.id}
                onPointerDown={editMode && canEditEquipment ? (e) => onPointerDown(e, tank, true) : undefined}
                className={`group absolute flex flex-col rounded border select-none ${
                  isDragging ? "opacity-80 shadow-2xl z-30 pointer-events-none" : "opacity-100 transition-opacity"
                } ${editMode && canEditEquipment ? "cursor-grab active:cursor-grabbing touch-none" : ""} ${eq.border}`}
                style={{
                  ...style,
                  // In flight the tile follows the pointer; the dashed preview marks where it lands.
                  ...(isDragging && ghost ? { left: ghost.x + GAP, top: ghost.y + GAP } : {}),
                  background: "color-mix(in srgb, var(--color-surface) 88%, transparent)",
                }}
              >
                {/* Header: the name alone — the border colour already says the type,
                    and clicking the name opens this equipment's upcoming plans. */}
                <div className={`shrink-0 px-1.5 py-1 flex items-center min-w-0 ${eq.headerBg}`}>
                  <button
                    type="button"
                    onClick={() => setPlansEquipmentId(tank.id)}
                    onMouseDown={(e) => e.stopPropagation()}
                    title={`${eq.label} · upcoming plans`}
                    className="font-semibold text-primary truncate leading-tight text-left min-w-0 max-w-full hover:text-accent transition-colors"
                    style={{ fontSize: tiny ? 11 : 12 }}
                  >
                    {tank.name}
                  </button>
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
                            <p className="text-disabled text-center mt-1" style={{ fontSize: 11 }}>No planned batches</p>
                          ) : (
                            <div className="space-y-1.5">
                              {groupByDate(planningBatches, (b) => b.planned_brew_date).map((group) => (
                                <div key={group.date}>
                                  <p className="text-muted font-semibold uppercase tracking-wide" style={{ fontSize: 11 }}>{fmtDate(group.date)}</p>
                                  <div className="space-y-0.5 mt-0.5">
                                    {group.items.map((b) => (
                                      <div key={b.id} className="leading-tight">
                                        <div className="flex items-center justify-between gap-1 min-w-0">
                                          <span className="text-faint font-mono shrink-0" style={{ fontSize: 11 }}>{b.batch_number ? `#${b.batch_number}` : "—"}</span>
                                          {b.volume_bbl != null && (
                                            <span className="text-accent-emphasis/80 font-mono shrink-0" style={{ fontSize: 11 }}>{Number(b.volume_bbl).toFixed(1)} BBL</span>
                                          )}
                                        </div>
                                        <p className="text-body truncate" style={{ fontSize: 11 }} title={b.beer_name}>{b.beer_name}</p>
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
                              onClick={() => setShowNewBatch(true)}
                              onMouseDown={(e) => e.stopPropagation()}
                              className="btn-primary btn-xxs w-full"
                              style={{ fontSize: 11 }}
                            >
                              + New Batch
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {/* === Cold Storage === beer | package | on hand */}
                    {isColdStorage && (
                      <div className="flex-1 min-h-0 overflow-y-auto">
                        <LotTable
                          empty="Empty"
                          qtyLabel="Qty"
                          rows={coldStorageLots.map((lot) => ({
                            key: lot.id,
                            title: lot.beer_name ?? "—",
                            pkg: packageLabel(lot.variation_name),
                            qty: lot.quantity_on_hand,
                          }))}
                        />
                      </div>
                    )}

                    {/* === Brewhouse === pass-through: beer is in it for a day at most, so the
                        tile is about what is planned next and getting to Assign in one click. */}
                    {isBrewhouse && (() => {
                      const plans = (upcomingByEquipment.get(tank.id) ?? []).filter((e) => e.batch_id !== batch?.id).slice(0, 3);
                      const openTransfer = (b: NonNullable<typeof batch>) => {
                        setTransferTankId(tank.id); setTransferBatchId(b.id); setTransferFromVol(volumeInTank(b.id, Number(b.volume_bbl ?? 0), tank.id));
                        setTransferInitialMode(undefined); setTransferInitialDestId(undefined); setTransferInitialConvert(undefined);
                      };
                      return (
                        <div className="flex-1 min-h-0 flex flex-col gap-1">
                          {!editMode && !batch && unassignedBatches.length > 0 && (
                            <button onClick={() => assign.openAssign(tank.id)} onMouseDown={(e) => e.stopPropagation()} className="btn-primary btn-xxs w-full shrink-0" style={{ fontSize: 11 }}>
                              Assign a batch
                            </button>
                          )}
                          {batch && (
                            <div className="shrink-0 flex items-center gap-1 min-w-0 px-1 py-0.5 rounded bg-accent-muted/30 border border-accent-border/40">
                              <span className="text-strong font-medium truncate flex-1 min-w-0" style={{ fontSize: 11 }} title={`#${batch.batch_number ?? "?"} ${batch.beer_name}`}>
                                {batch.batch_number && <span className="text-muted font-mono">#{batch.batch_number} </span>}{batch.beer_name}
                                {assignment && <span className="text-faint"> · {fmtDate(assignment.assigned_at)}</span>}
                              </span>
                              {!editMode && (
                                <button onClick={() => openTransfer(batch)} onMouseDown={(e) => e.stopPropagation()} className="btn-primary btn-xxs shrink-0" style={{ fontSize: 11 }}>Transfer</button>
                              )}
                            </div>
                          )}
                          <div className="flex-1 min-h-0 overflow-y-auto">
                            <p className="text-faint uppercase tracking-wide font-semibold" style={{ fontSize: 11 }}>Next up</p>
                            {plans.length === 0 ? (
                              <p className="text-disabled" style={{ fontSize: 11 }}>Nothing planned</p>
                            ) : plans.map((e) => {
                              const b = e.brew_batches ?? batchById[e.batch_id];
                              const overdue = e.planned_start.slice(0, 10) < new Date().toISOString().slice(0, 10);
                              return (
                                <div key={e.id} className="flex items-center gap-1 min-w-0 leading-tight" style={{ fontSize: 11 }}>
                                  <span className={`font-mono shrink-0 ${overdue ? "text-danger" : "text-muted"}`}>{fmtDate(e.planned_start)}</span>
                                  <span className="text-body truncate flex-1 min-w-0" title={b ? `#${b.batch_number ?? "?"} ${b.beer_name}` : "—"}>
                                    {b ? <>{b.batch_number && <span className="text-muted font-mono">#{b.batch_number} </span>}{b.beer_name}</> : "—"}
                                  </span>
                                  {e.volume_bbl != null && <span className="text-faint font-mono shrink-0">{Number(e.volume_bbl).toFixed(0)}</span>}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* === Regular tank (fermenter / brite) === */}
                    {isTank && !isBrewhouse && (() => {
                      // Ledger volume in THIS specific tank, summed across every
                      // batch combined into it (may be a partial split per batch).
                      const volFor = (b: typeof batch) => volumeInTank(b?.id, Number(b?.volume_bbl ?? 0), tank.id);
                      const ledgerVol = volFor(batch) + combinedAssignments.reduce((s, a) => s + volFor(a.brew_batches), 0);
                      // Next planned occupant — only an EMPTY tile says it; an occupied
                      // tank's next occupant is already a row in the Up next strip.
                      const nextPlanned = nextPlannedByTank.get(tank.id);
                      const hasCapacity = !isUnconstrained && !!tank.capacity_bbl;
                      const openTransfer = (b: NonNullable<typeof batch>) => {
                        setTransferTankId(tank.id); setTransferBatchId(b.id); setTransferFromVol(volFor(b));
                        setTransferInitialMode(undefined); setTransferInitialDestId(undefined); setTransferInitialConvert(undefined);
                      };

                      return (
                      <div className="flex-1 min-h-0 flex flex-col gap-0.5">
                        {batch ? (
                          <>
                            {/* Line 1 — identity, ellipsized rather than wrapped */}
                            <div className="shrink-0 flex items-center gap-1 min-w-0">
                              <span className="text-strong font-medium truncate flex-1 min-w-0" style={{ fontSize: 12 }} title={`#${batch.batch_number ?? "?"} ${batch.beer_name}`}>
                                {batch.batch_number && <span className="text-muted font-mono">#{batch.batch_number} </span>}
                                {batch.beer_name}
                              </span>
                              {drawGap(batchById[batch.id]) && (
                                <span className="px-1 py-px rounded border border-danger-border bg-danger-surface/40 text-danger shrink-0 leading-none" style={{ fontSize: 11 }} title={drawGap(batchById[batch.id])!}>
                                  No draw
                                </span>
                              )}
                            </div>
                            {/* Line 2 — volume · since */}
                            <p className="shrink-0 text-faint truncate" style={{ fontSize: 11 }}>
                              {hasCapacity ? `${ledgerVol.toFixed(1)} / ${tank.capacity_bbl} BBL` : `${ledgerVol.toFixed(1)} BBL`}
                              {assignment && ` · since ${fmtDate(assignment.assigned_at)}`}
                            </p>
                            {hasCapacity && (
                              <div className="shrink-0 w-full rounded-full overflow-hidden" style={{ height: 3, background: "color-mix(in srgb, var(--color-line-strong) 60%, transparent)" }}>
                                <div style={{ height: "100%", width: `${Math.min(100, (ledgerVol / tank.capacity_bbl!) * 100).toFixed(1)}%`, background: "rgba(245,158,11,0.7)", borderRadius: "9999px" }} />
                              </div>
                            )}

                            {/* Same-recipe batches combined into this tank */}
                            <div className="flex-1 min-h-0 overflow-y-auto space-y-0.5">
                              {combinedAssignments.map((a) => {
                                const otherBatch = a.brew_batches;
                                if (!otherBatch) return null;
                                return (
                                  <div key={a.id} className="flex items-center gap-1 min-w-0 pt-0.5 border-t border-line/60">
                                    <span className="text-body truncate flex-1 min-w-0" style={{ fontSize: 11 }} title={otherBatch.beer_name}>
                                      {otherBatch.batch_number && <span className="text-muted font-mono">#{otherBatch.batch_number} </span>}
                                      {otherBatch.beer_name} <span className="text-faint">+combined</span>
                                    </span>
                                    {!editMode && (
                                      <button
                                        onClick={() => openTransfer(otherBatch)}
                                        onMouseDown={(e) => e.stopPropagation()}
                                        className="btn-primary btn-xxs shrink-0"
                                        style={{ fontSize: 11 }}
                                      >
                                        Transfer
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>

                            {/* Transfer —
                                always visible — brewers must see what they can do. */}
                            {!editMode && (
                              <div className="shrink-0">
                                <button
                                  onClick={() => openTransfer(batch)}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  className="btn-primary btn-xxs w-full"
                                  style={{ fontSize: 11 }}
                                >
                                  Transfer
                                </button>
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="flex-1 min-h-0 flex flex-col gap-0.5">
                            {hasCapacity && (
                              <p className="shrink-0 text-faint" style={{ fontSize: 11 }}>{tank.capacity_bbl} BBL</p>
                            )}
                            <div className="flex-1 min-h-0" />
                            {nextPlanned?.brew_batches ? (
                              <NextPlannedBox
                                batchNumber={nextPlanned.brew_batches.batch_number}
                                beerName={nextPlanned.brew_batches.beer_name}
                                plannedStart={nextPlanned.planned_start}
                                volumeBbl={null}
                              />
                            ) : (
                              <p className="shrink-0 text-disabled" style={{ fontSize: 11 }}>Empty</p>
                            )}
                            {!editMode && tank.type === "brewhouse" && unassignedBatches.length > 0 && (
                              <div className="shrink-0">
                                <button
                                  onClick={() => assign.openAssign(tank.id)}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  className="btn-primary btn-xxs w-full"
                                  style={{ fontSize: 11 }}
                                >
                                  Assign
                                </button>
                              </div>
                            )}
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

                        // Upcoming kegging/canning days live behind the tile name (plans popup).
                        // One line per packaging lot: "#B-0xx Beer · Pkg  qty"; a batch
                        // with no recorded packaging output gets one line on its own.
                        return (
                          <div className="flex-1 min-h-0 overflow-y-auto">
                            <LotTable
                              empty="Empty"
                              qtyLabel="Run"
                              rows={pkgBatches.flatMap((b): LotRow[] => {
                                const lots = (incomingByBatch.get(b.id) ?? []).filter((tr) => tr.variation_id && tr.packaging_variations);
                                const sub = b.batch_number ? `#${b.batch_number}` : undefined;
                                return lots.length === 0
                                  ? [{ key: b.id, title: b.beer_name, subtitle: sub, pkg: "", qty: null }]
                                  : lots.map((tr) => ({ key: tr.id, title: b.beer_name, subtitle: sub, pkg: packageLabel(tr.packaging_variations!.name), qty: tr.quantity }));
                              })}
                            />
                          </div>
                        );
                      })()
                    )}

                    {/* Edit mode controls — brewer/admin only */}
                    {editMode && canEditEquipment && (
                      <div className="mt-auto pt-1 flex gap-1.5">
                        <button onClick={() => eqCrud.openEdit(tank)} onMouseDown={(e) => e.stopPropagation()} className="btn-secondary btn-xxs">Edit</button>
                        <button onClick={() => removeFromGrid(tank.id)} onMouseDown={(e) => e.stopPropagation()} className="btn-secondary btn-xxs">Unplace</button>
                        {!assignment && <button onClick={() => eqCrud.handleDeleteEq(tank.id, tank.name)} onMouseDown={(e) => e.stopPropagation()} className="btn-danger btn-xxs">Del</button>}
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
                  <ToggleChip
                    key={type}
                    active={eqCrud.eqForm.type === type}
                    onClick={() => eqCrud.setEqForm((f) => ({
                      ...f, type,
                      grid_width:  String(meta.defaultW),
                      grid_height: String(meta.defaultH),
                      capacity_bbl: UNCONSTRAINED_EQUIPMENT_TYPES.includes(type) ? "" : f.capacity_bbl,
                    }))}
                  >
                    {meta.label}
                  </ToggleChip>
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
            {/* Yeast re-pitch — skips consuming the recipe's yeast only. */}
            <div className="rounded border border-line bg-surface/40 p-3 space-y-2">
              <label className="flex items-center gap-2 text-sm text-body cursor-pointer">
                <input type="checkbox" checked={assign.yeastRepitch}
                  onChange={(e) => assign.setYeastRepitch(e.target.checked)} />
                Yeast is a re-pitch
              </label>
              {assign.yeastRepitch && (
                <Field label="Re-pitch note">
                  <input className="inp" placeholder="e.g. 3rd gen from B-041"
                    value={assign.yeastRepitchNote}
                    onChange={(e) => assign.setYeastRepitchNote(e.target.value)} />
                </Field>
              )}
              <p className="text-xs text-faint">
                Leaves the recipe&rsquo;s yeast in inventory. Ingredient deposits and every other
                ingredient are unaffected.
              </p>
            </div>
            {assign.assignShortfalls && assign.assignShortfalls.length > 0 && (
              <div className="rounded border border-danger-border bg-danger-surface/40 px-3 py-2 flex items-center justify-between gap-3">
                <p className="text-xs text-danger">
                  Blocked — {assign.assignShortfalls.length} ingredient
                  {assign.assignShortfalls.length > 1 ? "s" : ""} short.
                </p>
                <button type="button" className="btn-secondary"
                  onClick={() => setShortfallDetail({
                    shortfalls: assign.assignShortfalls!,
                    batchLabel: (() => {
                      const b = batchById[assign.assignBatchId];
                      return b ? `${b.batch_number ?? "?"} · ${b.beer_name}` : null;
                    })(),
                  })}>
                  View detail
                </button>
              </div>
            )}
            <ModalActions submitting={assign.assignSubmitting} onCancel={() => assign.setShowAssignModal(false)} label="Assign" />
          </form>
        </Modal>
      )}

      {/* Ingredient shortfall detail — opened from a blocked assignment */}
      {shortfallDetail && (
        <IngredientShortfallModal
          shortfalls={shortfallDetail.shortfalls}
          batchLabel={shortfallDetail.batchLabel}
          blockedMessage="This batch can't be assigned to a brewhouse until the shortfall is resolved."
          onClose={() => setShortfallDetail(null)}
        />
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

      {/* New batch (triggered from Backlog) */}
      {showNewBatch && (
        <ScheduleBatchModal
          recipeId={null}
          onClose={() => setShowNewBatch(false)}
          onCommitted={async () => { setShowNewBatch(false); await onBatchCreated(); await onRefresh(); }}
        />
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
