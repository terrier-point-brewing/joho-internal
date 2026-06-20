"use client";

import React, { useState, useCallback, useMemo } from "react";
import { addDays, parseISO } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import {
  ReactFlow, Background, BackgroundVariant, Controls,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  useBatchScheduleQuery, useTransfersQuery, useBatchesQuery, productionKeys,
  type ScheduleEntry,
} from "../../hooks/queries";
import type { BrewBatch, Equipment, Recipe } from "../../types";
import {
  PLANNING_STAGES, STAGE_LABELS, STAGE_TO_EQ_TYPES, computeBranchPackagingStatus,
  findEquipmentConflict, conflictBatchLabel, suggestAlternativeEquipment,
} from "./constants";
import { buildGraphData } from "./buildGraphData";
import { EntryNode, GhostNode, ConversionNode } from "./nodes";
import { GhostFlowChain } from "./GhostFlowChain";
import { AddStagePanel } from "./AddStagePanel";
import { BuildSchedulePanel } from "./BuildSchedulePanel";
import { SplitPanel } from "./SplitPanel";
import { ConvertPanel } from "./ConvertPanel";

type ActivePanel =
  | { kind: "none" }
  | { kind: "build" }
  | { kind: "add_stage"; branch?: string }
  | { kind: "split"; entry: ScheduleEntry }
  | { kind: "convert"; entry: ScheduleEntry };

export function EquipmentScheduleSection({
  batchId,
  entries,
  equipment,
  batch,
  recipes,
}: {
  batchId:   string;
  entries:   ScheduleEntry[];
  equipment: Equipment[];
  batch?:    BrewBatch;
  recipes?:  Recipe[];
}) {
  const qc     = useQueryClient();
  const reload = () => qc.invalidateQueries({ queryKey: productionKeys.batchSchedule });

  const { data: allScheduleEntries = [] } = useBatchScheduleQuery();
  const { data: allTransfers = [] }        = useTransfersQuery();
  const { data: allBatches  = [] }         = useBatchesQuery();

  const [panel,    setPanel]    = useState<ActivePanel>({ kind: "none" });
  const [editing,  setEditing]  = useState<ScheduleEntry | null>(null);
  const [editForm, setEditForm] = useState({
    equipment_id: "", stage: "fermenting",
    planned_start: "", planned_end: "",
    actual_start: "", actual_end: "",
    volume_bbl: "", notes: "",
  });
  const [editSaving, setEditSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  function closePanel() { setPanel({ kind: "none" }); }

  // Group entries by planned_branch: null = main flow, string = named split branch
  const activeEntries  = entries.filter(e => !e.cancelled_at);
  const mainEntries    = activeEntries.filter(e => !e.planned_branch);
  const splitBranches  = [...new Set(activeEntries.filter(e => e.planned_branch).map(e => e.planned_branch!))].sort();
  const branchEntries  = (name: string) => activeEntries.filter(e => e.planned_branch === name);

  // Per-branch planning completeness: required quantity for a branch is the BBL
  // recorded on that branch's Conditioning entry; flag when kegging+canning
  // scheduled for that branch don't yet exhaust it (or none is scheduled at all).
  const pkgStatuses = batch?.status !== "archived" ? computeBranchPackagingStatus(activeEntries) : [];
  // Both under- and over-allocation are surfaced as "planning incomplete" — in
  // either direction, the schedule doesn't accurately account for what's
  // actually been (or needs to be) packaged out of conditioning.
  const pkgMismatches = pkgStatuses
    .filter(s => s.status !== "ok")
    .map(s => ({
      label: s.label,
      detail: s.status === "no_packaging"
        ? "no packaging scheduled"
        : s.status === "incomplete"
          ? `${s.pkgBbl.toFixed(2)} BBL packaged vs ${s.condBbl.toFixed(2)} BBL in conditioning`
          : `${s.pkgBbl.toFixed(2)} BBL packaged exceeds ${s.condBbl.toFixed(2)} BBL in conditioning`,
    }));
  const existingSplits = splitBranches.length;

  const batchTransfers = allTransfers.filter(t => t.batch_id === batchId);
  const { nodes: rawNodes, edges } = buildGraphData(activeEntries, allBatches, batch, allTransfers, allScheduleEntries);
  const conversionCount = allBatches.filter(b => b.converted_from_batch_id === batchId).length;

  // ── Auto-suggest ──────────────────────────────────────────────────────────
  async function autoSuggest() {
    if (!batch?.recipe_id) return;
    setSuggesting(true);
    try {
      const res = await fetch("/api/production/batch-scheduler/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipe_id:      batch.recipe_id,
          earliest_start: batch.planned_brew_date || undefined,
          volume_bbl:     Number(batch.volume_bbl) || undefined,
          turns:          batch.turns || 1,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Suggestion failed");

      const result = await res.json() as {
        feasible: boolean;
        equipment_sequence: { stage: string; equipment_id: string; scheduled_start: string; scheduled_end: string }[];
      };
      if (!result.feasible) { alert("No available equipment found for this recipe and volume."); return; }

      // The suggest API uses equipment-type names; map to DB stage names
      const API_TO_DB_STAGE: Record<string, string> = {
        brite:     "conditioning",
        fermenter: "fermenting",
      };

      const existingStages = new Set(mainEntries.map(e => e.stage));
      const toCreate = result.equipment_sequence.filter(s => {
        const dbStage = API_TO_DB_STAGE[s.stage] ?? s.stage;
        return !existingStages.has(dbStage);
      });

      // Determine conditioning end for packaging date calculations
      const condEntry = mainEntries.find(e => e.stage === "conditioning");
      const suggestedBrite = result.equipment_sequence.find(s => s.stage === "brite" || s.stage === "conditioning");
      const condEnd = condEntry?.planned_end?.slice(0, 10)
        ?? suggestedBrite?.scheduled_end?.slice(0, 10)
        ?? null;

      for (const s of toCreate) {
        const dbStage = API_TO_DB_STAGE[s.stage] ?? s.stage;
        await fetch("/api/production/batch-schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            batch_id:      batchId,
            equipment_id:  s.equipment_id || null,
            stage:         dbStage,
            planned_start: s.scheduled_start,
            planned_end:   s.scheduled_end,
          }),
        });
      }

      // Packaging: schedule kegging + canning to exhaust the batch's expected yield.
      // Target = turns × recipe.expected_yield_bbl (falls back to batch volume_bbl).
      // Any existing packaging volume counts toward the target.
      // Default split: 70% kegging / 30% canning, 1 day each starting at condEnd.
      if (condEnd) {
        const yieldPerTurn = Number(batch.recipes?.expected_yield_bbl ?? 0);
        const turns        = Number(batch.turns ?? 1);
        const targetBbl    = yieldPerTurn > 0 ? yieldPerTurn * turns : Number(batch.volume_bbl ?? 0);

        const existingKegBbl = mainEntries
          .filter(e => e.stage === "kegging").reduce((s, e) => s + Number(e.volume_bbl ?? 0), 0);
        const existingCanBbl = mainEntries
          .filter(e => e.stage === "canning").reduce((s, e) => s + Number(e.volume_bbl ?? 0), 0);
        const allocatedBbl = existingKegBbl + existingCanBbl;
        const remainingBbl = Math.max(0, targetBbl - allocatedBbl);

        // Both kegging and canning are same-day tasks anchored to condEnd
        const existingKegDate = mainEntries.find(e => e.stage === "kegging")?.planned_start?.slice(0, 10) ?? condEnd;
        const existingCanDate = mainEntries.find(e => e.stage === "canning")?.planned_start?.slice(0, 10) ?? condEnd;

        const pkgSlots = [
          { stage: "kegging", type: "kegging", startDate: existingKegDate, volBbl: remainingBbl * 0.7 },
          { stage: "canning", type: "canning", startDate: existingCanDate, volBbl: remainingBbl * 0.3 },
        ];

        for (const slot of pkgSlots) {
          if (existingStages.has(slot.stage)) continue;
          const eq = equipment.find(eq => eq.type === slot.type);
          await fetch("/api/production/batch-schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              batch_id:      batchId,
              equipment_id:  eq?.id ?? null,
              stage:         slot.stage,
              planned_start: slot.startDate + "T12:00:00",
              planned_end:   slot.startDate + "T12:00:00",
              volume_bbl:    slot.volBbl > 0 ? slot.volBbl : null,
            }),
          });
        }
      }

      await reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Suggestion failed");
    } finally {
      setSuggesting(false);
    }
  }

  // ── Edit entry ────────────────────────────────────────────────────────────
  const openEdit = useCallback((entry: ScheduleEntry) => {
    setEditing(entry);
    setPanel({ kind: "none" });
    setEditForm({
      equipment_id:  entry.equipment_id ?? "",
      stage:         entry.stage,
      planned_start: entry.planned_start?.slice(0, 10) ?? "",
      planned_end:   entry.planned_end?.slice(0, 10) ?? "",
      actual_start:  entry.actual_start?.slice(0, 10) ?? "",
      actual_end:    entry.actual_end?.slice(0, 10) ?? "",
      volume_bbl:    entry.volume_bbl != null ? String(entry.volume_bbl) : "",
      notes:         entry.notes ?? "",
    });
  }, []);
  const f = (k: keyof typeof editForm, v: string) => setEditForm(p => ({ ...p, [k]: v }));

  const editConflict = editForm.equipment_id && editForm.planned_start && editForm.planned_end
    ? findEquipmentConflict(allScheduleEntries, editForm.equipment_id, editForm.planned_start, editForm.planned_end, batchId, editing?.id)
    : null;
  const editSuggestion = editConflict
    ? suggestAlternativeEquipment(
        equipment.filter(eq => STAGE_TO_EQ_TYPES[editForm.stage]?.includes(eq.type)),
        allScheduleEntries, editForm.planned_start, editForm.planned_end, batchId, editForm.equipment_id, editing?.id,
      )
    : null;

  async function saveEdit() {
    if (editConflict && !confirm(`Warning: this equipment is already scheduled for ${conflictBatchLabel(editConflict)} during these dates. Save anyway?`)) return;
    setEditSaving(true);
    try {
      const payload: Record<string, unknown> = {
        batch_id:      batchId,
        equipment_id:  editForm.equipment_id || null,
        stage:         editForm.stage,
        planned_start: editForm.planned_start ? editForm.planned_start + "T12:00:00" : null,
        planned_end:   editForm.planned_end   ? editForm.planned_end   + "T12:00:00" : null,
        actual_start:  editForm.actual_start  ? editForm.actual_start  + "T12:00:00" : null,
        actual_end:    editForm.actual_end    ? editForm.actual_end    + "T12:00:00" : null,
        volume_bbl:    editForm.volume_bbl !== "" ? Number(editForm.volume_bbl) : null,
        notes:         editForm.notes || null,
      };
      const res = await fetch(`/api/production/batch-schedule/${editing!.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");

      // Keep conditioning planned_end in sync with packaging
      if ((editForm.stage === "kegging" || editForm.stage === "canning") && editForm.planned_end) {
        const otherEnds = entries
          .filter(e => !e.cancelled_at && (e.stage === "kegging" || e.stage === "canning") && e.id !== editing!.id)
          .map(e => e.planned_end.slice(0, 10));
        const latest = [...otherEnds, editForm.planned_end].sort().at(-1)!;
        const cond = entries.find(e => !e.cancelled_at && e.stage === "conditioning");
        if (cond) {
          await fetch(`/api/production/batch-schedule/${cond.id}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ planned_end: latest + "T12:00:00" }),
          });
        }
      }
      await reload();
      setEditing(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setEditSaving(false);
    }
  }

  const removeEntry = useCallback(async (id: string) => {
    if (!confirm("Remove this schedule entry?")) return;
    const removed = entries.find(e => e.id === id);
    await fetch(`/api/production/batch-schedule/${id}`, { method: "DELETE" });

    if (removed && (removed.stage === "kegging" || removed.stage === "canning")) {
      const remaining = entries
        .filter(e => !e.cancelled_at && (e.stage === "kegging" || e.stage === "canning") && e.id !== id)
        .map(e => e.planned_end.slice(0, 10)).sort();
      const cond = entries.find(e => !e.cancelled_at && e.stage === "conditioning");
      if (cond && remaining.length > 0) {
        await fetch(`/api/production/batch-schedule/${cond.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ planned_end: remaining.at(-1)! + "T12:00:00" }),
        });
      }
    }
    await reload();
    setEditing(null);
  }, [entries, reload]);

  const nodeTypes: NodeTypes = useMemo(() => ({
    entryNode:      EntryNode,
    ghostNode:      GhostNode,
    conversionNode: ConversionNode,
  }), []);

  const onBuild = useCallback(() => { setEditing(null); setPanel({ kind: "build" }); }, []);
  const onSplit = useCallback((e: ScheduleEntry) => { setEditing(null); setPanel({ kind: "split", entry: e }); }, []);
  const onConvert = useCallback((e: ScheduleEntry) => { setEditing(null); setPanel({ kind: "convert", entry: e }); }, []);

  const nodes = rawNodes.map(n => ({
    ...n,
    data: {
      ...n.data,
      onEdit:    openEdit,
      onBuild,
      onSplit,
      onConvert,
      onRemove:  removeEntry,
      editing,
    },
  }));

  return (
    <div>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Equipment Schedule</p>
        <div className="flex gap-3 items-center">
          {batch?.recipe_id && (
            <button type="button" onClick={autoSuggest} disabled={suggesting}
              className="text-xs text-amber-500 hover:text-amber-400 disabled:opacity-40 transition-colors">
              {suggesting ? "Suggesting…" : "✦ Auto-suggest"}
            </button>
          )}
          <button type="button"
            onClick={() => setPanel(p => p.kind === "add_stage" ? { kind: "none" } : { kind: "add_stage" })}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
            + Add stage
          </button>
        </div>
      </div>

      {/* ── Planning incomplete alerts ───────────────────────────────────── */}
      {pkgMismatches.map(({ label, detail }) => (
        <div key={label} className="mb-2 px-3 py-2 rounded border border-amber-700/50 bg-amber-950/20 text-xs text-amber-400 leading-relaxed">
          <span className="font-semibold">⚠ {label} — planning incomplete</span>
          {" "}— {detail}.
        </div>
      ))}

      {/* ── Main flow ───────────────────────────────────────────────────── */}
      {nodes.length === 0
        ? (
          <div className="mb-3">
            <GhostFlowChain onBuild={onBuild} />
          </div>
        )
        : (
          <div style={{ height: `${Math.max(1, 1 + splitBranches.length + conversionCount) * 150 + 80}px` }} className="mb-3 rounded-lg overflow-hidden border border-zinc-800">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              panOnDrag
              zoomOnScroll
              zoomOnPinch
              nodesDraggable={false}
              nodesConnectable={false}
              minZoom={0.2}
              maxZoom={1.5}
              colorMode="dark"
            >
              <Background color="#3f3f46" gap={20} size={1} variant={BackgroundVariant.Dots} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        )
      }


      {/* ── Active panel ────────────────────────────────────────────────── */}
      {panel.kind === "build" && batch && recipes && (
        <BuildSchedulePanel
          batchId={batchId} batch={batch} recipes={recipes} equipment={equipment}
          entries={entries} allScheduleEntries={allScheduleEntries} onSaved={reload} onClose={closePanel}
        />
      )}

      {panel.kind === "add_stage" && (
        <AddStagePanel
          batchId={batchId} equipment={equipment}
          allScheduleEntries={allScheduleEntries}
          plannedBranch={panel.branch}
          onSaved={reload} onClose={closePanel}
        />
      )}

      {panel.kind === "split" && (
        <SplitPanel
          batchId={batchId}
          sourceEntry={panel.entry}
          totalBbl={Number(panel.entry.volume_bbl ?? batch?.volume_bbl ?? 0)}
          existingSplitCount={existingSplits}
          equipment={equipment}
          entries={entries}
          allScheduleEntries={allScheduleEntries}
          onSaved={reload} onClose={closePanel}
        />
      )}

      {panel.kind === "convert" && recipes && (
        <ConvertPanel
          batchId={batchId}
          sourceEntry={panel.entry}
          totalBbl={Number(panel.entry.volume_bbl ?? batch?.volume_bbl ?? 0)}
          recipes={recipes}
          equipment={equipment}
          allScheduleEntries={allScheduleEntries}
          onSaved={reload} onClose={closePanel}
        />
      )}

      {/* ── Inline edit form ────────────────────────────────────────────── */}
      {editing !== null && (
        <div className="rounded border border-zinc-700 bg-zinc-900/60 p-3 mb-3 space-y-3">
          <p className="text-xs text-zinc-400 font-medium">Edit entry</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Stage</label>
              <select className="inp text-xs" value={editForm.stage}
                onChange={e => { f("stage", e.target.value); f("equipment_id", ""); }}>
                {PLANNING_STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s] ?? s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Equipment</label>
              <select className="inp text-xs" value={editForm.equipment_id}
                onChange={e => f("equipment_id", e.target.value)}>
                <option value="">— none —</option>
                {equipment.filter(eq => STAGE_TO_EQ_TYPES[editForm.stage]?.includes(eq.type)).map(eq => (
                  <option key={eq.id} value={eq.id}>{eq.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Planned Start</label>
              <input type="date" className="inp text-xs" value={editForm.planned_start}
                onChange={e => f("planned_start", e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Planned End</label>
              <input type="date" className="inp text-xs" value={editForm.planned_end}
                onChange={e => f("planned_end", e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Actual Start</label>
              <input type="date" className="inp text-xs" value={editForm.actual_start}
                onChange={e => f("actual_start", e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Actual End</label>
              <input type="date" className="inp text-xs" value={editForm.actual_end}
                onChange={e => f("actual_end", e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Volume (BBL)</label>
              <input type="number" step="0.01" min="0" className="inp text-xs" value={editForm.volume_bbl}
                onChange={e => f("volume_bbl", e.target.value)} placeholder="e.g. 30.00" />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Notes</label>
              <input type="text" className="inp text-xs" value={editForm.notes}
                onChange={e => f("notes", e.target.value)} placeholder="Optional" />
            </div>
          </div>
          {editConflict && (
            <div className="px-3 py-2 rounded border border-red-700/50 bg-red-950/30 text-xs text-red-400 leading-relaxed">
              <span className="font-semibold">⚠ Equipment conflict</span> — already scheduled for {conflictBatchLabel(editConflict)} during these dates.
              {editSuggestion && (
                <> Try <button type="button" onClick={() => f("equipment_id", editSuggestion.id)} className="underline underline-offset-2 hover:text-red-300">{editSuggestion.name}</button> instead.</>
              )}
              {!editSuggestion && " No conflict-free equipment of this type is available for these dates."}
            </div>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={saveEdit}
              disabled={editSaving || !editForm.planned_start || !editForm.planned_end}
              className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded font-medium">
              {editSaving ? "Saving…" : "Save changes"}
            </button>
            <button type="button" onClick={() => removeEntry(editing.id)}
              className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-red-800 text-zinc-300 rounded">Delete</button>
            <button type="button" onClick={() => setEditing(null)}
              className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
