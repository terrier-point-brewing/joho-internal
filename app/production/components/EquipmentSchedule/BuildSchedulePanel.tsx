"use client";

import React, { useState } from "react";
import { addDays, parseISO } from "date-fns";
import type { BrewBatch, Equipment, Recipe } from "../../types";
import type { ScheduleEntry } from "../../hooks/queries";
import { useBatchScheduleQuery } from "../../hooks/queries";
import {
  PIPELINE, OPTIONAL_PIPELINE, BUILD_STAGE_LABELS, BUILD_STAGE_COLORS, EQ_TYPES_FOR_SLOT,
  findEquipmentConflict, conflictBatchLabel, suggestAlternativeEquipment,
  type BuildSlot,
} from "./constants";
import type { Equipment as EquipmentType } from "../../types";

function PackagingDaysSummary({
  stage,
  excludeBatchId,
  conditioningEnd,
  onPickDate,
}: {
  stage: "kegging" | "canning";
  excludeBatchId: string;
  /** Planned end of the relevant Conditioning stage — used to limit to "valid" join days. */
  conditioningEnd?: string | null;
  onPickDate: (date: string, equipmentId: string | null) => void;
}) {
  const { data: allEntries = [] } = useBatchScheduleQuery();
  const today = new Date().toISOString().slice(0, 10);
  // A valid day to join is at least 5 days before the conditioning stage's planned end.
  const latestValidDate = conditioningEnd
    ? addDays(parseISO(conditioningEnd.slice(0, 10) + "T12:00:00"), -5).toISOString().slice(0, 10)
    : null;

  const dayMap = new Map<string, { totalBbl: number; batchCount: number; equipmentCounts: Map<string, number> }>();
  for (const e of allEntries) {
    if (e.stage !== stage || e.batch_id === excludeBatchId || e.cancelled_at) continue;
    const date = e.planned_start.slice(0, 10);
    if (date < today) continue;
    if (latestValidDate && date > latestValidDate) continue;
    const existing = dayMap.get(date) ?? { totalBbl: 0, batchCount: 0, equipmentCounts: new Map<string, number>() };
    if (e.equipment_id) existing.equipmentCounts.set(e.equipment_id, (existing.equipmentCounts.get(e.equipment_id) ?? 0) + 1);
    dayMap.set(date, {
      totalBbl:   existing.totalBbl + Number(e.volume_bbl ?? 0),
      batchCount: existing.batchCount + 1,
      equipmentCounts: existing.equipmentCounts,
    });
  }

  const days = [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, 5);
  if (days.length === 0) return null;

  function mostCommonEquipment(equipmentCounts: Map<string, number>): string | null {
    let best: string | null = null, bestCount = 0;
    for (const [id, count] of equipmentCounts) if (count > bestCount) { best = id; bestCount = count; }
    return best;
  }

  return (
    <div className="rounded border border-line bg-surface/40 p-2 space-y-1">
      <p className="text-[10px] text-faint uppercase tracking-wide">
        Upcoming {stage === "kegging" ? "keg" : "can"} days — click to join
      </p>
      {days.map(([date, { totalBbl, batchCount, equipmentCounts }]) => (
        <button key={date} type="button" onClick={() => onPickDate(date, mostCommonEquipment(equipmentCounts))}
          className="w-full flex items-center justify-between text-[11px] px-2 py-1 rounded hover:bg-surface-mid text-secondary hover:text-strong transition-colors">
          <span>{new Date(date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
          <span className="text-faint">
            {batchCount} batch{batchCount !== 1 ? "es" : ""}
            {totalBbl > 0 ? ` · ${totalBbl.toFixed(2)} BBL planned` : ""}
          </span>
        </button>
      ))}
    </div>
  );
}

export function BuildSchedulePanel({
  batchId,
  batch,
  recipes,
  equipment,
  entries,
  allScheduleEntries,
  plannedBranch,
  onSaved,
  onClose,
}: {
  batchId: string;
  batch: BrewBatch;
  recipes: Recipe[];
  equipment: Equipment[];
  entries: ScheduleEntry[];
  allScheduleEntries?: ScheduleEntry[];
  plannedBranch?: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const recipe = recipes.find(r => r.id === batch.recipe_id);
  // Packaging (kegging/canning) is a point-in-time event: end defaults to start.
  const stageDays: Record<BuildSlot["stage"], number> = {
    brewhouse: recipe?.days_brewhouse ?? 1,
    fermenter: recipe?.days_fermenter ?? 14,
    brite:     recipe?.days_brite ?? 7,
    kegging:   0,
    canning:   0,
  };
  const isPackagingSlot = (s: BuildSlot["stage"]) => s === "kegging" || s === "canning";

  const activeEntryByDbStage = Object.fromEntries(
    entries.filter(e => !e.cancelled_at).map(e => [e.stage, e])
  );
  const conditioningEnd = activeEntryByDbStage["conditioning"]?.planned_end ?? null;
  // A batch created from a conversion has no upstream (brewhouse/fermenting)
  // requirement — it only ever needs downstream stages from Conditioning on.
  const PIPELINE_EFFECTIVE = batch.converted_from_batch_id ? PIPELINE.filter(p => p.slot === "brite") : PIPELINE;
  const missingPipeline = PIPELINE_EFFECTIVE.filter(({ dbStage }) => !activeEntryByDbStage[dbStage]);

  const poolFor = (stage: BuildSlot["stage"]): EquipmentType[] =>
    equipment.filter(e => EQ_TYPES_FOR_SLOT[stage]?.includes(e.type));

  // Auto-select equipment when only one option exists for a slot's stage.
  const defaultEquipmentFor = (stage: BuildSlot["stage"]): string => {
    const pool = poolFor(stage);
    return pool.length === 1 ? pool[0].id : "";
  };

  const [slots, setSlots] = useState<BuildSlot[]>(() =>
    missingPipeline.map(({ slot }) => ({ stage: slot, equipment_id: defaultEquipmentFor(slot), scheduled_start: "", scheduled_end: "" }))
  );
  const [suggesting, setSuggesting] = useState(false);
  const [saving,     setSaving]     = useState(false);

  function computeStartsForSlots(currentSlots: BuildSlot[]): Partial<Record<BuildSlot["stage"], Date>> {
    if (!batch.planned_brew_date) return {};
    let cursor = parseISO(batch.planned_brew_date.slice(0, 10) + "T12:00:00");
    const startForSlot: Partial<Record<BuildSlot["stage"], Date>> = {};

    for (const { slot, dbStage } of PIPELINE_EFFECTIVE) {
      const existing = activeEntryByDbStage[dbStage];
      if (existing) {
        if (slot !== "brewhouse") cursor = parseISO(existing.planned_end.slice(0, 10) + "T12:00:00");
      } else {
        startForSlot[slot] = cursor;
        if (slot !== "brewhouse") cursor = addDays(cursor, stageDays[slot]);
      }
    }
    for (const { slot, dbStage } of OPTIONAL_PIPELINE) {
      const existing = activeEntryByDbStage[dbStage];
      if (existing) {
        cursor = parseISO(existing.planned_end.slice(0, 10) + "T12:00:00");
      } else if (currentSlots.some(s => s.stage === slot)) {
        startForSlot[slot] = cursor;
        // Packaging is instantaneous (end = start); when multiple packaging
        // slots are added together, offset each by 1 day from the previous.
        cursor = addDays(cursor, 1);
      }
    }
    return startForSlot;
  }

  function autoFill() {
    const starts = computeStartsForSlots(slots);
    setSlots(prev => prev.map(s => {
      const start = starts[s.stage];
      if (!start) return s;
      return {
        ...s,
        scheduled_start: start.toISOString().slice(0, 10),
        scheduled_end:   isPackagingSlot(s.stage) ? start.toISOString().slice(0, 10) : addDays(start, stageDays[s.stage]).toISOString().slice(0, 10),
      };
    }));
  }

  function addOptionalSlot(slot: "kegging" | "canning", pinDate?: string, pinEquipmentId?: string | null) {
    if (slots.some(s => s.stage === slot)) return;
    const newSlots = [...slots, { stage: slot as BuildSlot["stage"], equipment_id: pinEquipmentId || defaultEquipmentFor(slot), scheduled_start: "", scheduled_end: "" }];
    const starts = computeStartsForSlots(newSlots);
    const autoStart = starts[slot];
    setSlots(newSlots.map(s => {
      if (s.stage !== slot) return s;
      const startDate = pinDate ? parseISO(pinDate + "T12:00:00") : autoStart;
      if (!startDate) return s;
      return {
        ...s,
        scheduled_start: startDate.toISOString().slice(0, 10),
        scheduled_end:   startDate.toISOString().slice(0, 10),
      };
    }));
  }

  async function suggest() {
    if (!batch.recipe_id) return;
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
        equipment_sequence: { stage: BuildSlot["stage"]; equipment_id: string; scheduled_start: string; scheduled_end: string; volume_bbl?: number }[];
      };
      const missingSlugs = new Set(missingPipeline.map(p => p.slot));
      setSlots(
        result.equipment_sequence
          .filter(s => missingSlugs.has(s.stage))
          .map(s => ({ stage: s.stage, equipment_id: s.equipment_id, scheduled_start: s.scheduled_start, scheduled_end: s.scheduled_end, volume_bbl: s.volume_bbl != null ? String(s.volume_bbl) : undefined }))
      );
    } catch (e) {
      alert(e instanceof Error ? e.message : "Suggestion failed");
    } finally {
      setSuggesting(false);
    }
  }

  async function save() {
    if (slots.some(s => !s.scheduled_start || !s.scheduled_end)) {
      alert("Fill in start and end dates for all stages before saving."); return;
    }
    if (allScheduleEntries) {
      for (const s of slots) {
        if (!s.equipment_id) continue;
        const conflict = findEquipmentConflict(allScheduleEntries, s.equipment_id, s.scheduled_start, s.scheduled_end, batchId);
        if (conflict && !confirm(`${BUILD_STAGE_LABELS[s.stage]}: this equipment is already scheduled for ${conflictBatchLabel(conflict)} during these dates. Save anyway?`)) return;
      }
    }
    setSaving(true);
    try {
      const resolvedIds: Partial<Record<BuildSlot["stage"], string>> = {};
      for (const { slot, dbStage } of [...PIPELINE_EFFECTIVE, ...OPTIONAL_PIPELINE]) {
        const existing = activeEntryByDbStage[dbStage];
        if (existing) resolvedIds[slot] = existing.id;
      }

      for (const slot of slots) {
        const def = [...PIPELINE_EFFECTIVE, ...OPTIONAL_PIPELINE].find(p => p.slot === slot.stage);
        if (!def) continue;
        const existing   = activeEntryByDbStage[def.dbStage];
        const payload: Record<string, unknown> = {
          batch_id:      batchId,
          equipment_id:  slot.equipment_id || null,
          stage:         def.dbStage,
          planned_start: slot.scheduled_start + "T12:00:00",
          planned_end:   slot.scheduled_end   + "T12:00:00",
          ...(slot.volume_bbl ? { volume_bbl: Number(slot.volume_bbl) } : {}),
          ...(plannedBranch ? { planned_branch: plannedBranch } : {}),
        };
        const url    = existing ? `/api/production/batch-schedule/${existing.id}` : "/api/production/batch-schedule";
        const method = existing ? "PATCH" : "POST";
        const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
        resolvedIds[slot.stage] = (await res.json()).id;
      }

      // Condition tank held until last packaging date
      const allPkgEnds = [
        ...entries.filter(e => !e.cancelled_at && (e.stage === "kegging" || e.stage === "canning")).map(e => e.planned_end.slice(0, 10)),
        ...slots.filter(s => s.stage === "kegging" || s.stage === "canning").map(s => s.scheduled_end).filter(Boolean),
      ].sort();
      const latestPkg = allPkgEnds.at(-1);
      if (latestPkg) {
        const condId = resolvedIds["brite"] ?? activeEntryByDbStage["conditioning"]?.id;
        if (condId) {
          await fetch(`/api/production/batch-schedule/${condId}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ planned_end: latestPkg + "T12:00:00" }),
          });
        }
      }

      // Wire downstream chain
      const activeOptional = OPTIONAL_PIPELINE.filter(({ slot }) => resolvedIds[slot]);
      const chain = [...PIPELINE_EFFECTIVE, ...activeOptional];
      for (let i = 0; i < chain.length - 1; i++) {
        const from = resolvedIds[chain[i].slot];
        const to   = resolvedIds[chain[i + 1].slot];
        if (from && to) {
          await fetch(`/api/production/batch-schedule/${from}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ downstream_entry_id: to }),
          });
        }
      }

      onSaved();
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const hasExisting  = missingPipeline.length < PIPELINE_EFFECTIVE.length;
  const sectionTitle = plannedBranch
    ? `Build schedule — ${plannedBranch}`
    : hasExisting
      ? `Add stages (${missingPipeline.map(p => BUILD_STAGE_LABELS[p.slot]).join(", ")} missing)`
      : "Build Equipment Schedule";

  return (
    <div className="mt-2 rounded border border-line-strong bg-surface/60 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-secondary">{sectionTitle}</span>
        <div className="flex gap-2">
          <button type="button" onClick={suggest} disabled={suggesting || !batch.recipe_id}
            className="text-xs text-accent hover:text-accent-emphasis disabled:opacity-40">
            {suggesting ? "Suggesting…" : "✦ Auto-suggest"}
          </button>
          <button type="button" onClick={autoFill} disabled={!batch.planned_brew_date}
            className="text-xs text-muted hover:text-body disabled:opacity-40">
            Auto-fill dates
          </button>
          <button type="button" onClick={onClose} className="text-xs text-faint hover:text-secondary">✕</button>
        </div>
      </div>

      {slots.map((slot, idx) => {
        const pool       = poolFor(slot.stage);
        const isOptional = OPTIONAL_PIPELINE.some(p => p.slot === slot.stage);
        const conflict = allScheduleEntries && slot.equipment_id && slot.scheduled_start && slot.scheduled_end
          ? findEquipmentConflict(allScheduleEntries, slot.equipment_id, slot.scheduled_start, slot.scheduled_end, batchId)
          : null;
        const suggestion = conflict && allScheduleEntries
          ? suggestAlternativeEquipment(pool, allScheduleEntries, slot.scheduled_start, slot.scheduled_end, batchId, slot.equipment_id)
          : null;
        return (
          <div key={slot.stage} className={`rounded border px-2.5 py-2 space-y-1.5 ${BUILD_STAGE_COLORS[slot.stage]}`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-medium">{BUILD_STAGE_LABELS[slot.stage]}</span>
              {isOptional && (
                <button type="button"
                  onClick={() => setSlots(prev => prev.filter(s => s.stage !== slot.stage))}
                  className="text-[10px] text-muted hover:text-danger transition-colors">✕ Remove</button>
              )}
            </div>
            <div className="grid gap-2 grid-cols-4">
              <div>
                <label className="block text-[10px] mb-0.5 opacity-70">Tank</label>
                <select className="inp text-xs w-full" value={slot.equipment_id}
                  onChange={e => setSlots(prev => prev.map((s, i) => i === idx ? { ...s, equipment_id: e.target.value } : s))}>
                  <option value="">— select —</option>
                  {pool.map(eq => <option key={eq.id} value={eq.id}>{eq.name}{eq.capacity_bbl ? ` (${eq.capacity_bbl} BBL)` : ""}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] mb-0.5 opacity-70">Start</label>
                <input type="date" className="inp text-xs w-full" value={slot.scheduled_start}
                  onChange={e => setSlots(prev => prev.map((s, i) => i === idx ? { ...s, scheduled_start: e.target.value } : s))} />
              </div>
              <div>
                <label className="block text-[10px] mb-0.5 opacity-70">End</label>
                <input type="date" className="inp text-xs w-full" value={slot.scheduled_end}
                  onChange={e => setSlots(prev => prev.map((s, i) => i === idx ? { ...s, scheduled_end: e.target.value } : s))} />
              </div>
              <div>
                <label className="block text-[10px] mb-0.5 opacity-70">Planned BBL</label>
                <input type="number" step="0.01" min="0" placeholder="e.g. 3.5" className="inp text-xs w-full"
                  value={slot.volume_bbl ?? ""}
                  onChange={e => setSlots(prev => prev.map((s, i) => i === idx ? { ...s, volume_bbl: e.target.value } : s))} />
              </div>
            </div>
            {conflict && (
              <div className="px-2 py-1.5 rounded border border-danger-border/50 bg-danger-surface/30 text-[11px] text-danger leading-relaxed">
                <span className="font-semibold">⚠ Equipment conflict</span> — already scheduled for {conflictBatchLabel(conflict)} during these dates.
                {suggestion && (
                  <> Try <button type="button" onClick={() => setSlots(prev => prev.map((s, i) => i === idx ? { ...s, equipment_id: suggestion.id } : s))} className="underline underline-offset-2 hover:text-danger">{suggestion.name}</button> instead.</>
                )}
                {!suggestion && " No conflict-free equipment of this type is available for these dates."}
              </div>
            )}
          </div>
        );
      })}

      {OPTIONAL_PIPELINE.filter(({ slot, dbStage }) =>
        !slots.some(s => s.stage === slot) && !activeEntryByDbStage[dbStage]
      ).map(({ slot, label }) => (
        <div key={slot} className="space-y-1">
          <button type="button" onClick={() => addOptionalSlot(slot as "kegging" | "canning")}
            className="text-xs text-muted hover:text-body border border-dashed border-line-strong hover:border-line-subtle px-2 py-1 rounded transition-colors w-full text-left">
            {label}
          </button>
          <PackagingDaysSummary stage={slot as "kegging" | "canning"} excludeBatchId={batchId} conditioningEnd={conditioningEnd}
            onPickDate={(date, equipmentId) => addOptionalSlot(slot as "kegging" | "canning", date, equipmentId)} />
        </div>
      ))}

      <div className="flex gap-2 pt-1">
        <button type="button" onClick={save} disabled={saving}
          className="px-3 py-1.5 text-xs bg-accent-emphasis hover:bg-accent disabled:opacity-50 text-white rounded font-medium">
          {saving ? "Saving…" : "Save schedule"}
        </button>
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-muted hover:text-body">Cancel</button>
      </div>
    </div>
  );
}
