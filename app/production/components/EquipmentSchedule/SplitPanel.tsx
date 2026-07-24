"use client";

import React, { useState } from "react";
import type { ScheduleEntry } from "../../hooks/queries";
import type { Equipment } from "../../types";
import {
  STAGE_LABELS, STAGE_TO_EQ_TYPES, PACKAGING_PIPELINE, REQUIRED_PIPELINE,
  findEquipmentConflict, conflictBatchLabel, suggestAlternativeEquipment,
} from "./constants";

const FULL_PIPELINE = [...REQUIRED_PIPELINE, ...PACKAGING_PIPELINE].map(s => s.dbStage);

// All pipeline stages that come strictly after `stage`
function stagesAfter(stage: string): string[] {
  const norm = stage === "fermenter" ? "fermenting" : stage;
  const idx = FULL_PIPELINE.indexOf(norm);
  return idx >= 0 ? FULL_PIPELINE.slice(idx + 1) : [];
}

export function SplitPanel({
  batchId,
  sourceEntry,
  totalBbl,
  existingSplitCount,
  equipment,
  entries,
  allScheduleEntries,
  onSaved,
  onClose,
}: {
  batchId: string;
  sourceEntry: ScheduleEntry;
  totalBbl: number;
  existingSplitCount: number;
  equipment: Equipment[];
  entries: ScheduleEntry[];
  allScheduleEntries: ScheduleEntry[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const branchName  = `Split ${existingSplitCount + 1}`;
  const stageLabel  = STAGE_LABELS[sourceEntry.stage] ?? sourceEntry.stage;
  const eligibleEq  = equipment.filter(eq => STAGE_TO_EQ_TYPES[sourceEntry.stage]?.includes(eq.type));

  const [mainBbl,      setMainBbl]      = useState((totalBbl * 0.5).toFixed(2));
  const [splitBbl,     setSplitBbl]     = useState((totalBbl * 0.5).toFixed(2));
  const [tankId,       setTankId]       = useState("");
  const [saving,       setSaving]       = useState(false);

  const splitStart = sourceEntry.planned_start?.slice(0, 10) ?? "";
  const splitEnd   = sourceEntry.planned_end?.slice(0, 10) ?? "";
  const conflict = tankId
    ? findEquipmentConflict(allScheduleEntries, tankId, splitStart, splitEnd, batchId)
    : null;
  const suggestion = conflict
    ? suggestAlternativeEquipment(eligibleEq, allScheduleEntries, splitStart, splitEnd, batchId, tankId)
    : null;

  function onMainChange(v: string) {
    setMainBbl(v);
    const n = Number(v);
    if (!isNaN(n)) setSplitBbl(Math.max(0, totalBbl - n).toFixed(2));
  }
  function onSplitChange(v: string) {
    setSplitBbl(v);
    const n = Number(v);
    if (!isNaN(n)) setMainBbl(Math.max(0, totalBbl - n).toFixed(2));
  }

  async function save() {
    const splitVol = Number(splitBbl);
    if (!splitVol || splitVol <= 0) { alert("Split volume must be greater than 0."); return; }
    if (splitVol >= totalBbl)       { alert("Split volume must be less than the total batch volume."); return; }
    if (conflict && !confirm(`This equipment is already scheduled for ${conflictBatchLabel(conflict)} during these dates. Save anyway?`)) return;
    setSaving(true);
    try {
      const mainVol = Number(mainBbl);
      const ratio   = totalBbl > 0 ? mainVol / totalBbl : 1;
      const downstream = stagesAfter(sourceEntry.stage);
      const sameBranch = (e: ScheduleEntry) =>
        (sourceEntry.planned_branch == null ? !e.planned_branch : e.planned_branch === sourceEntry.planned_branch);

      // 1. Reduce source entry to main branch volume
      await fetch(`/api/production/batch-schedule/${sourceEntry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ volume_bbl: mainVol }),
      });

      // 2. Scale all downstream entries on the same branch proportionally
      const downstreamEntries = entries.filter(
        e => !e.cancelled_at && sameBranch(e) && downstream.includes(e.stage === "fermenter" ? "fermenting" : e.stage) && e.volume_bbl != null,
      );
      await Promise.all(downstreamEntries.map(e =>
        fetch(`/api/production/batch-schedule/${e.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ volume_bbl: Math.round(Number(e.volume_bbl) * ratio * 100) / 100 }),
        }),
      ));

      // 3. Create the split branch entry for the same stage (the receiving tank)
      await fetch("/api/production/batch-schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batch_id:       batchId,
          stage:          sourceEntry.stage,
          equipment_id:   tankId || null,
          planned_start:  sourceEntry.planned_start ?? new Date().toISOString(),
          planned_end:    sourceEntry.planned_end   ?? new Date().toISOString(),
          volume_bbl:     splitVol,
          planned_branch: branchName,
          notes:          `Split ${splitVol} BBL from ${stageLabel}`,
        }),
      });

      // 4. Create downstream packaging ghosts with 70/30 of splitVol
      const kegVol = Math.round(splitVol * 0.7 * 100) / 100;
      const canVol = Math.round((splitVol - kegVol) * 100) / 100;
      const pkgVolumes: Record<string, number> = { kegging: kegVol, canning: canVol };

      const pkgAnchor = sourceEntry.planned_end ?? new Date().toISOString();
      for (const stage of PACKAGING_PIPELINE) {
        const pkgEq = equipment.find(eq => eq.type === stage.dbStage);
        await fetch("/api/production/batch-schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            batch_id:       batchId,
            stage:          stage.dbStage,
            equipment_id:   pkgEq?.id ?? null,
            planned_start:  pkgAnchor,
            planned_end:    pkgAnchor,
            volume_bbl:     pkgVolumes[stage.dbStage] ?? splitVol,
            planned_branch: branchName,
            notes:          `Planned split — ${stage.label} for ${branchName}`,
          }),
        });
      }

      onSaved();
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 rounded border border-info-border/50 bg-info-surface/20 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-info">Plan Split from {stageLabel}</span>
        <button type="button" onClick={onClose} className="text-xs text-faint hover:text-secondary">✕</button>
      </div>

      <p className="text-[11px] text-muted">
        Creates a new <span className="text-body">{branchName}</span> branch at{" "}
        <span className="text-body">{stageLabel}</span> with its own receiving tank, then
        auto-schedules kegging (70%) and canning (30%) downstream.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] mb-1 text-muted">Main branch BBL</label>
          <input type="number" step="0.01" min="0" className="inp text-xs w-full"
            value={mainBbl} onChange={e => onMainChange(e.target.value)} />
        </div>
        <div>
          <label className="block text-[10px] mb-1 text-muted">{branchName} BBL</label>
          <input type="number" step="0.01" min="0" className="inp text-xs w-full"
            value={splitBbl} onChange={e => onSplitChange(e.target.value)} />
        </div>
      </div>

      <div>
        <label className="block text-[10px] mb-1 text-muted">
          Receiving tank for {branchName} ({stageLabel})
        </label>
        <select className="inp text-xs w-full" value={tankId} onChange={e => setTankId(e.target.value)}>
          <option value="">— assign later —</option>
          {eligibleEq.map(eq => (
            <option key={eq.id} value={eq.id}>{eq.name}</option>
          ))}
        </select>
      </div>

      {conflict && (
        <div className="px-3 py-2 rounded border border-danger-border/50 bg-danger-surface/30 text-xs text-danger leading-relaxed">
          <span className="font-semibold">⚠ Equipment conflict</span> — already scheduled for {conflictBatchLabel(conflict)} during these dates.
          {suggestion && (
            <> Try <button type="button" onClick={() => setTankId(suggestion.id)} className="underline underline-offset-2 hover:text-danger">{suggestion.name}</button> instead.</>
          )}
          {!suggestion && " No conflict-free equipment of this type is available for these dates."}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button type="button" onClick={save} disabled={saving}
          className="px-3 py-1.5 text-xs bg-info-emphasis hover:bg-info disabled:opacity-50 text-white rounded font-medium">
          {saving ? "Creating split…" : `Create ${branchName}`}
        </button>
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-muted hover:text-body">Cancel</button>
      </div>
    </div>
  );
}
