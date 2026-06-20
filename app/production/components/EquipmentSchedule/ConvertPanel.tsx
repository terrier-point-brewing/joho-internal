"use client";

import React, { useState } from "react";
import type { Equipment, Recipe } from "../../types";
import type { ScheduleEntry } from "../../hooks/queries";
import {
  STAGE_LABELS, STAGE_TO_EQ_TYPES,
  findEquipmentConflict, conflictBatchLabel, suggestAlternativeEquipment,
} from "./constants";

const FULL_PIPELINE = ["brewhouse", "fermenting", "conditioning", "kegging", "canning"];
function stagesAfter(stage: string): string[] {
  const norm = stage === "fermenter" ? "fermenting" : stage;
  const idx = FULL_PIPELINE.indexOf(norm);
  return idx >= 0 ? FULL_PIPELINE.slice(idx + 1) : [];
}

export function ConvertPanel({
  batchId,
  sourceEntry,
  totalBbl,
  recipes,
  equipment,
  allScheduleEntries,
  onSaved,
  onClose,
}: {
  batchId: string;
  sourceEntry: ScheduleEntry;
  totalBbl: number;
  recipes: Recipe[];
  equipment: Equipment[];
  allScheduleEntries?: ScheduleEntry[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const [recipeId, setRecipeId]   = useState("");
  const [beerName, setBeerName]   = useState("");
  // Volume is always exactly the amount converted — not based on turns/recipe.
  const [volBbl,   setVolBbl]     = useState((totalBbl * 0.5).toFixed(2));
  const [notes,    setNotes]      = useState("");
  const [tankId,   setTankId]     = useState("");
  const [saving,   setSaving]     = useState(false);

  const destStage  = sourceEntry.stage === "fermenter" ? "fermenting" : sourceEntry.stage;
  const stageLabel = STAGE_LABELS[sourceEntry.stage] ?? sourceEntry.stage;
  const eligibleEq = equipment.filter(eq => STAGE_TO_EQ_TYPES[destStage]?.includes(eq.type));

  const defaultStart = (sourceEntry.planned_end ?? new Date().toISOString()).slice(0, 10);
  const defaultDays  = destStage === "conditioning" ? 21 : 14;
  const defaultEnd   = new Date(new Date(defaultStart + "T12:00:00").getTime() + defaultDays * 86400000).toISOString().slice(0, 10);

  // Defaulted from the source stage's end date, but adjustable — the receiving
  // tank's planned start/end drives both the new batch's planned_brew_date and
  // its first schedule entry.
  const [convertDate, setConvertDate] = useState(defaultStart);
  const [convertEnd,  setConvertEnd]  = useState(defaultEnd);

  const conflict = tankId
    ? findEquipmentConflict(allScheduleEntries ?? [], tankId, convertDate, convertEnd, batchId)
    : null;
  const suggestion = conflict
    ? suggestAlternativeEquipment(eligibleEq, allScheduleEntries ?? [], convertDate, convertEnd, batchId, tankId)
    : null;

  async function save() {
    if (!recipeId)    { alert("Select a recipe for the new batch."); return; }
    if (!convertDate || !convertEnd) { alert("Set a planned start and end date for the receiving tank."); return; }
    if (convertEnd < convertDate) { alert("Planned end must be on or after planned start."); return; }
    if (!beerName)    { alert("Enter a beer name for the new batch."); return; }
    if (!tankId)      { alert("Select the receiving tank for the new batch."); return; }
    const vol = Number(volBbl);
    if (!vol || vol <= 0) { alert("Volume must be greater than 0."); return; }
    if (conflict && !confirm(`This equipment is already scheduled for ${conflictBatchLabel(conflict)} during these dates. Save anyway?`)) return;

    setSaving(true);
    try {
      // Create the child batch in backlog. Its volume is exactly the converted
      // amount (not turns-derived) and it starts its workflow at the receiving
      // tank's stage — no upstream brewhouse/fermenting schedule is required.
      const batchRes = await fetch("/api/production/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beer_name:               beerName,
          recipe_id:               recipeId,
          // A converted batch has no brewhouse stage, but planned_brew_date is
          // NOT NULL — use the receiving tank's planned start date, since that's
          // genuinely when this batch's workflow begins.
          planned_brew_date:       convertDate,
          volume_bbl:              vol,
          // A planned conversion is intent, not a completed transfer — the new
          // batch isn't actually fermenting/conditioning yet. It starts in
          // "planning" and is promoted to the real stage by the normal arrival
          // reconciliation (transfers/route.ts) once the conversion physically
          // happens and its first schedule entry gets actual_start stamped.
          status:                  "planning",
          converted_from_batch_id: batchId,
          converted_volume_bbl:    vol,
          notes:                   notes || null,
        }),
      });
      if (!batchRes.ok) throw new Error((await batchRes.json()).error ?? "Failed to create batch");
      const newBatch = await batchRes.json();

      // Create the new batch's first real schedule entry at the receiving tank.
      const entryRes = await fetch("/api/production/batch-schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batch_id:      newBatch.id,
          equipment_id:  tankId,
          stage:         destStage,
          planned_start: convertDate + "T12:00:00",
          planned_end:   convertEnd  + "T12:00:00",
          volume_bbl:    vol,
          notes:         `Converted from batch ${batchId}`,
        }),
      });
      if (!entryRes.ok) throw new Error((await entryRes.json()).error ?? "Failed to schedule the new batch's first stage");

      // Create a planned_conversion marker on the source batch's schedule
      // so it appears in the flow as a terminal conversion branch node.
      const markerRes = await fetch("/api/production/batch-schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batch_id:       batchId,
          equipment_id:   sourceEntry.equipment_id,
          stage:          "planned_conversion",
          planned_start:  sourceEntry.planned_end ?? new Date().toISOString(),
          planned_end:    sourceEntry.planned_end ?? new Date().toISOString(),
          volume_bbl:     vol,
          notes:          JSON.stringify({ beer_name: beerName, child_batch_id: newBatch.id }),
        }),
      });
      if (!markerRes.ok) throw new Error((await markerRes.json()).error ?? "Failed to record the conversion marker on the source batch");

      // Reduce the source batch's own not-yet-occurred downstream stages
      // (conditioning/kegging/canning on the same branch) proportionally, so
      // its schedule reflects that this volume left via conversion rather
      // than appearing as unexplained shrinkage.
      const ratio = totalBbl > 0 ? (totalBbl - vol) / totalBbl : 0;
      const downstream = stagesAfter(sourceEntry.stage);
      const sourceDownstreamEntries = (allScheduleEntries ?? []).filter(e =>
        e.batch_id === batchId &&
        !e.cancelled_at &&
        !e.actual_start &&
        e.planned_branch === sourceEntry.planned_branch &&
        downstream.includes(e.stage === "fermenter" ? "fermenting" : e.stage) &&
        e.volume_bbl != null
      );
      await Promise.all(sourceDownstreamEntries.map(e =>
        fetch(`/api/production/batch-schedule/${e.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ volume_bbl: Math.round(Number(e.volume_bbl) * ratio * 100) / 100 }),
        })
      ));

      // Copy any "conversion" allocations earmarked for this recipe from the
      // source batch onto the new batch, as standard allocations. If multiple
      // commitments were earmarked (e.g. partner C + partner D), the new
      // batch's allocations are set proportionally to their relative share.
      type SourceAllocation = {
        id: string; channel: string; percentage: number;
        partner_id: string | null; contract_request_id: string | null;
        conversion_target_recipe_id: string | null;
        commitments?: { channel?: string } | null;
      };
      const sourceAllocations: SourceAllocation[] = await fetch(`/api/production/allocations?batch_id=${batchId}`)
        .then(r => r.ok ? r.json() : []);
      const matching = sourceAllocations.filter(
        a => a.channel === "conversion" && a.conversion_target_recipe_id === recipeId
      );
      const totalMatchedPct = matching.reduce((s, a) => s + Number(a.percentage), 0);
      if (matching.length > 0 && totalMatchedPct > 0) {
        await Promise.all(matching.map(a => {
          const sharePct = (Number(a.percentage) / totalMatchedPct) * 100;
          return fetch("/api/production/allocations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              batch_id: newBatch.id,
              channel: a.commitments?.channel ?? "contract_brewing",
              percentage: sharePct,
              partner_id: a.partner_id,
              contract_request_id: a.contract_request_id,
            }),
          });
        }));
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
    <div className="mt-2 rounded border border-amber-800/50 bg-amber-950/20 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-amber-300">Plan Conversion from {stageLabel}</span>
        <button type="button" onClick={onClose} className="text-xs text-zinc-600 hover:text-zinc-400">✕</button>
      </div>

      <p className="text-[11px] text-zinc-500">
        Plans a partial conversion of this batch into a new batch under a different recipe.
        A child batch will be created in Backlog and linked here.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-[10px] mb-1 text-zinc-500">Child Beer Name</label>
          <input type="text" className="inp text-xs w-full" placeholder="e.g. Hazy IPA v2"
            value={beerName} onChange={e => setBeerName(e.target.value)} />
        </div>
        <div>
          <label className="block text-[10px] mb-1 text-zinc-500">Recipe</label>
          <select className="inp text-xs w-full" value={recipeId} onChange={e => setRecipeId(e.target.value)}>
            <option value="">— select recipe —</option>
            {recipes.map(r => (
              <option key={r.id} value={r.id}>{r.beer_name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] mb-1 text-zinc-500">Volume to Convert (BBL)</label>
          <input type="number" step="0.01" min="0" className="inp text-xs w-full"
            value={volBbl} onChange={e => setVolBbl(e.target.value)} />
        </div>
        <div className="col-span-2">
          <label className="block text-[10px] mb-1 text-zinc-500">
            Receiving tank ({STAGE_LABELS[destStage] ?? destStage})
          </label>
          <select className="inp text-xs w-full" value={tankId} onChange={e => setTankId(e.target.value)}>
            <option value="">— select tank —</option>
            {eligibleEq.map(eq => (
              <option key={eq.id} value={eq.id}>{eq.name}{eq.type === "fermenter" ? " (fermenter)" : ""}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] mb-1 text-zinc-500">Planned Start</label>
          <input type="date" className="inp text-xs w-full"
            value={convertDate} onChange={e => setConvertDate(e.target.value)} />
        </div>
        <div>
          <label className="block text-[10px] mb-1 text-zinc-500">Planned End</label>
          <input type="date" className="inp text-xs w-full"
            value={convertEnd} onChange={e => setConvertEnd(e.target.value)} />
        </div>
        <div className="col-span-2">
          <label className="block text-[10px] mb-1 text-zinc-500">Notes (optional)</label>
          <input type="text" className="inp text-xs w-full" placeholder="e.g. dry-hop variant"
            value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
      </div>

      {conflict && (
        <div className="px-3 py-2 rounded border border-red-700/50 bg-red-950/30 text-xs text-red-400 leading-relaxed">
          <span className="font-semibold">⚠ Equipment conflict</span> — already scheduled for {conflictBatchLabel(conflict)} during these dates.
          {suggestion && (
            <> Try <button type="button" onClick={() => setTankId(suggestion.id)} className="underline underline-offset-2 hover:text-red-300">{suggestion.name}</button> instead.</>
          )}
          {!suggestion && " No conflict-free equipment of this type is available for these dates."}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button type="button" onClick={save} disabled={saving}
          className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded font-medium">
          {saving ? "Creating…" : "Plan Conversion"}
        </button>
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
      </div>
    </div>
  );
}
