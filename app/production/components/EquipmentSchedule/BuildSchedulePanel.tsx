"use client";

import React, { useState } from "react";
import { addDays, parseISO } from "date-fns";
import type { BrewBatch, Equipment, Recipe } from "../../types";
import type { ScheduleEntry } from "../../hooks/queries";
import { useBatchScheduleQuery } from "../../hooks/queries";
import {
  PIPELINE, OPTIONAL_PIPELINE, BUILD_STAGE_LABELS, BUILD_STAGE_COLORS, EQ_TYPE_FOR_SLOT,
  type BuildSlot,
} from "./constants";

function PackagingDaysSummary({
  stage,
  excludeBatchId,
  onPickDate,
}: {
  stage: "kegging" | "canning";
  excludeBatchId: string;
  onPickDate: (date: string) => void;
}) {
  const { data: allEntries = [] } = useBatchScheduleQuery();
  const today = new Date().toISOString().slice(0, 10);

  const dayMap = new Map<string, { totalBbl: number; batchCount: number }>();
  for (const e of allEntries) {
    if (e.stage !== stage || e.batch_id === excludeBatchId || e.cancelled_at) continue;
    const date = e.planned_start.slice(0, 10);
    if (date < today) continue;
    const existing = dayMap.get(date) ?? { totalBbl: 0, batchCount: 0 };
    dayMap.set(date, {
      totalBbl:   existing.totalBbl + Number(e.volume_bbl ?? 0),
      batchCount: existing.batchCount + 1,
    });
  }

  const days = [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, 5);
  if (days.length === 0) return null;

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-2 space-y-1">
      <p className="text-[10px] text-zinc-600 uppercase tracking-wide">
        Upcoming {stage === "kegging" ? "keg" : "can"} days — click to join
      </p>
      {days.map(([date, { totalBbl, batchCount }]) => (
        <button key={date} type="button" onClick={() => onPickDate(date)}
          className="w-full flex items-center justify-between text-[11px] px-2 py-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors">
          <span>{new Date(date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
          <span className="text-zinc-600">
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
  plannedBranch,
  onSaved,
  onClose,
}: {
  batchId: string;
  batch: BrewBatch;
  recipes: Recipe[];
  equipment: Equipment[];
  entries: ScheduleEntry[];
  plannedBranch?: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const recipe = recipes.find(r => r.id === batch.recipe_id);
  const stageDays: Record<BuildSlot["stage"], number> = {
    brewhouse: recipe?.days_brewhouse ?? 1,
    fermenter: recipe?.days_fermenter ?? 14,
    brite:     recipe?.days_brite ?? 7,
    kegging:   1,
    canning:   1,
  };

  const activeEntryByDbStage = Object.fromEntries(
    entries.filter(e => !e.cancelled_at).map(e => [e.stage, e])
  );
  const missingPipeline = PIPELINE.filter(({ dbStage }) => !activeEntryByDbStage[dbStage]);

  const [slots, setSlots] = useState<BuildSlot[]>(() =>
    missingPipeline.map(({ slot }) => ({ stage: slot, equipment_id: "", scheduled_start: "", scheduled_end: "" }))
  );
  const [suggesting, setSuggesting] = useState(false);
  const [saving,     setSaving]     = useState(false);

  const poolFor = (stage: BuildSlot["stage"]) =>
    equipment.filter(e => e.type === EQ_TYPE_FOR_SLOT[stage]);

  function computeStartsForSlots(currentSlots: BuildSlot[]): Partial<Record<BuildSlot["stage"], Date>> {
    if (!batch.planned_brew_date) return {};
    let cursor = parseISO(batch.planned_brew_date.slice(0, 10) + "T12:00:00");
    const startForSlot: Partial<Record<BuildSlot["stage"], Date>> = {};

    for (const { slot, dbStage } of PIPELINE) {
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
        cursor = addDays(cursor, stageDays[slot]);
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
        scheduled_end:   addDays(start, stageDays[s.stage]).toISOString().slice(0, 10),
      };
    }));
  }

  function addOptionalSlot(slot: "kegging" | "canning", pinDate?: string) {
    if (slots.some(s => s.stage === slot)) return;
    const newSlots = [...slots, { stage: slot as BuildSlot["stage"], equipment_id: "", scheduled_start: "", scheduled_end: "" }];
    const starts = computeStartsForSlots(newSlots);
    const autoStart = starts[slot];
    setSlots(newSlots.map(s => {
      if (s.stage !== slot) return s;
      const startDate = pinDate ? parseISO(pinDate + "T12:00:00") : autoStart;
      if (!startDate) return s;
      return {
        ...s,
        scheduled_start: startDate.toISOString().slice(0, 10),
        scheduled_end:   addDays(startDate, stageDays[slot]).toISOString().slice(0, 10),
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
        equipment_sequence: { stage: BuildSlot["stage"]; equipment_id: string; scheduled_start: string; scheduled_end: string }[];
      };
      const missingSlugs = new Set(missingPipeline.map(p => p.slot));
      setSlots(
        result.equipment_sequence
          .filter(s => missingSlugs.has(s.stage))
          .map(s => ({ stage: s.stage, equipment_id: s.equipment_id, scheduled_start: s.scheduled_start, scheduled_end: s.scheduled_end }))
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
    setSaving(true);
    try {
      const resolvedIds: Partial<Record<BuildSlot["stage"], string>> = {};
      for (const { slot, dbStage } of [...PIPELINE, ...OPTIONAL_PIPELINE]) {
        const existing = activeEntryByDbStage[dbStage];
        if (existing) resolvedIds[slot] = existing.id;
      }

      for (const slot of slots) {
        const def = [...PIPELINE, ...OPTIONAL_PIPELINE].find(p => p.slot === slot.stage);
        if (!def) continue;
        const existing   = activeEntryByDbStage[def.dbStage];
        const isPackaging = slot.stage === "kegging" || slot.stage === "canning";
        const payload: Record<string, unknown> = {
          batch_id:      batchId,
          equipment_id:  slot.equipment_id || null,
          stage:         def.dbStage,
          planned_start: slot.scheduled_start + "T12:00:00",
          planned_end:   slot.scheduled_end   + "T12:00:00",
          ...(isPackaging && slot.volume_bbl ? { volume_bbl: Number(slot.volume_bbl) } : {}),
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
      const chain = [...PIPELINE, ...activeOptional];
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

  const hasExisting  = missingPipeline.length < PIPELINE.length;
  const sectionTitle = plannedBranch
    ? `Build schedule — ${plannedBranch}`
    : hasExisting
      ? `Add stages (${missingPipeline.map(p => BUILD_STAGE_LABELS[p.slot]).join(", ")} missing)`
      : "Build Equipment Schedule";

  return (
    <div className="mt-2 rounded border border-zinc-700 bg-zinc-900/60 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400">{sectionTitle}</span>
        <div className="flex gap-2">
          <button type="button" onClick={suggest} disabled={suggesting || !batch.recipe_id}
            className="text-xs text-amber-500 hover:text-amber-400 disabled:opacity-40">
            {suggesting ? "Suggesting…" : "✦ Auto-suggest"}
          </button>
          <button type="button" onClick={autoFill} disabled={!batch.planned_brew_date}
            className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-40">
            Auto-fill dates
          </button>
          <button type="button" onClick={onClose} className="text-xs text-zinc-600 hover:text-zinc-400">✕</button>
        </div>
      </div>

      {slots.map((slot, idx) => {
        const pool       = poolFor(slot.stage);
        const isOptional = OPTIONAL_PIPELINE.some(p => p.slot === slot.stage);
        return (
          <div key={slot.stage} className={`rounded border px-2.5 py-2 space-y-1.5 ${BUILD_STAGE_COLORS[slot.stage]}`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-medium">{BUILD_STAGE_LABELS[slot.stage]}</span>
              {isOptional && (
                <button type="button"
                  onClick={() => setSlots(prev => prev.filter(s => s.stage !== slot.stage))}
                  className="text-[10px] text-zinc-500 hover:text-red-400 transition-colors">✕ Remove</button>
              )}
            </div>
            <div className={`grid gap-2 ${isOptional ? "grid-cols-4" : "grid-cols-3"}`}>
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
              {isOptional && (
                <div>
                  <label className="block text-[10px] mb-0.5 opacity-70">Planned BBL</label>
                  <input type="number" step="0.01" min="0" placeholder="e.g. 3.5" className="inp text-xs w-full"
                    value={slot.volume_bbl ?? ""}
                    onChange={e => setSlots(prev => prev.map((s, i) => i === idx ? { ...s, volume_bbl: e.target.value } : s))} />
                </div>
              )}
            </div>
          </div>
        );
      })}

      {OPTIONAL_PIPELINE.filter(({ slot, dbStage }) =>
        !slots.some(s => s.stage === slot) && !activeEntryByDbStage[dbStage]
      ).map(({ slot, label }) => (
        <div key={slot} className="space-y-1">
          <button type="button" onClick={() => addOptionalSlot(slot as "kegging" | "canning")}
            className="text-xs text-zinc-500 hover:text-zinc-300 border border-dashed border-zinc-700 hover:border-zinc-500 px-2 py-1 rounded transition-colors w-full text-left">
            {label}
          </button>
          <PackagingDaysSummary stage={slot as "kegging" | "canning"} excludeBatchId={batchId}
            onPickDate={date => addOptionalSlot(slot as "kegging" | "canning", date)} />
        </div>
      ))}

      <div className="flex gap-2 pt-1">
        <button type="button" onClick={save} disabled={saving}
          className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded font-medium">
          {saving ? "Saving…" : "Save schedule"}
        </button>
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
      </div>
    </div>
  );
}
