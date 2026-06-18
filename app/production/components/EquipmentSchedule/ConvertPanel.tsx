"use client";

import React, { useState } from "react";
import type { Recipe } from "../../types";
import type { ScheduleEntry } from "../../hooks/queries";
import { STAGE_LABELS } from "./constants";

export function ConvertPanel({
  batchId,
  sourceEntry,
  totalBbl,
  recipes,
  onSaved,
  onClose,
}: {
  batchId: string;
  sourceEntry: ScheduleEntry;
  totalBbl: number;
  recipes: Recipe[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const [recipeId, setRecipeId]   = useState("");
  const [beerName, setBeerName]   = useState("");
  const [volBbl,   setVolBbl]     = useState((totalBbl * 0.5).toFixed(2));
  const [notes,    setNotes]      = useState("");
  const [saving,   setSaving]     = useState(false);

  const stageLabel = STAGE_LABELS[sourceEntry.stage] ?? sourceEntry.stage;

  async function save() {
    if (!recipeId)    { alert("Select a recipe for the new batch."); return; }
    if (!beerName)    { alert("Enter a beer name for the new batch."); return; }
    const vol = Number(volBbl);
    if (!vol || vol <= 0) { alert("Volume must be greater than 0."); return; }

    setSaving(true);
    try {
      // Create the child batch in backlog
      const batchRes = await fetch("/api/production/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beer_name:               beerName,
          recipe_id:               recipeId,
          volume_bbl:              vol,
          status:                  "backlog",
          converted_from_batch_id: batchId,
          converted_volume_bbl:    vol,
          notes:                   notes || null,
        }),
      });
      if (!batchRes.ok) throw new Error((await batchRes.json()).error ?? "Failed to create batch");
      const newBatch = await batchRes.json();

      // Create a planned_conversion marker on the source batch's schedule
      // so it appears in the flow as a planned conversion terminal node
      await fetch("/api/production/batch-schedule", {
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
          <label className="block text-[10px] mb-1 text-zinc-500">Notes (optional)</label>
          <input type="text" className="inp text-xs w-full" placeholder="e.g. dry-hop variant"
            value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
      </div>

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
