"use client";

import React, { useState } from "react";
import type { BrewBatch, Recipe } from "../../types";
import type { ScheduleEntry } from "../../hooks/queries";
import { STAGE_LABELS } from "./constants";
import { baseMapOf, lineageDescendants } from "@/lib/production/recipeLineage";

export function ConvertPanel({
  batchId,
  sourceEntry,
  totalBbl,
  allBatches,
  sourceRecipeId,
  recipes,
  onSaved,
  onClose,
}: {
  batchId: string;
  sourceEntry: ScheduleEntry;
  totalBbl: number;
  allBatches: BrewBatch[];
  /** Recipe of the batch being drawn from — the base a target may be linked to. */
  sourceRecipeId: string | null;
  recipes: Recipe[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const [toBatchId, setToBatchId] = useState("");
  const [volBbl,    setVolBbl]    = useState((totalBbl * 0.5).toFixed(2));
  const [notes,     setNotes]     = useState("");
  const [saving,    setSaving]    = useState(false);

  const stageLabel = STAGE_LABELS[sourceEntry.stage] ?? sourceEntry.stage;
  const plannedDate = (sourceEntry.planned_end ?? new Date().toISOString()).slice(0, 10);

  // Candidate target batches: not this batch, not already a conversion child of
  // this batch, and still in an active (not complete/archived) state.
  const candidateBatches = allBatches.filter(b =>
    b.id !== batchId &&
    b.converted_from_batch_id !== batchId &&
    b.status !== "complete"
  );

  // A target whose recipe converts from this batch's beer — at any depth — is
  // one whose additions can be reserved and charged: the difference between the
  // two bills. Depth does not matter because the subtraction is always against
  // the beer actually in the tank, so drawing Transfusion Lager straight off a
  // Pace Yourself Pilsner batch charges ginger, lime AND grape juice. Everything
  // else stays selectable and simply warns: converting into an unrelated beer is
  // a real thing to do, it just cannot be costed.
  const derivedRecipeIds = sourceRecipeId
    ? lineageDescendants(sourceRecipeId, baseMapOf(recipes))
    : new Set<string>();
  const linkedBatches   = candidateBatches.filter(b => b.recipe_id != null && derivedRecipeIds.has(b.recipe_id));
  const unlinkedBatches = candidateBatches.filter(b => !(b.recipe_id != null && derivedRecipeIds.has(b.recipe_id)));

  const selectedRecipeId = candidateBatches.find(b => b.id === toBatchId)?.recipe_id ?? null;
  const targetUnlinked = Boolean(toBatchId) && !(selectedRecipeId != null && derivedRecipeIds.has(selectedRecipeId));
  const sourceBeerName = allBatches.find(b => b.id === batchId)?.beer_name ?? "this batch";

  async function save() {
    if (!toBatchId) { alert("Select a target batch."); return; }
    const vol = Number(volBbl);
    if (!vol || vol <= 0) { alert("Volume must be greater than 0."); return; }

    setSaving(true);
    try {
      const res = await fetch("/api/production/batch-conversions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_batch_id:     batchId,
          target_batch_id:     toBatchId,
          source_equipment_id: sourceEntry.equipment_id ?? null,
          volume_bbl:          vol,
          planned_date:        plannedDate,
          notes:               notes || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to plan conversion");
      onSaved();
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 rounded border border-[var(--cat-amber-bd)]/50 bg-[var(--cat-amber-bg)]/20 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--cat-amber-fg)]">Plan Conversion from {stageLabel}</span>
        <button type="button" onClick={onClose} className="text-xs text-faint hover:text-secondary">✕</button>
      </div>

      <p className="text-[11px] text-muted">
        Links a portion of this batch to an existing target batch as a conversion. Create the target batch first if it does not exist yet.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-[10px] mb-1 text-muted">Target Batch</label>
          <select className="inp text-xs w-full" value={toBatchId} onChange={e => setToBatchId(e.target.value)}>
            <option value="">— select batch —</option>
            {linkedBatches.length > 0 && (
              <optgroup label={`Based on ${sourceBeerName}`}>
                {linkedBatches.map(b => (
                  <option key={b.id} value={b.id}>
                    {b.batch_number ? `#${b.batch_number} ` : ""}{b.beer_name}
                  </option>
                ))}
              </optgroup>
            )}
            {unlinkedBatches.length > 0 && (
              <optgroup label={linkedBatches.length > 0 ? "Other batches" : "All batches"}>
                {unlinkedBatches.map(b => (
                  <option key={b.id} value={b.id}>
                    {b.batch_number ? `#${b.batch_number} ` : ""}{b.beer_name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {targetUnlinked && (
            <p className="text-[11px] text-[var(--cat-amber-fg)] mt-1">
              Not based on {sourceBeerName} — no added ingredients will be reserved or charged.
              The conversion still goes through.
            </p>
          )}
        </div>
        <div>
          <label className="block text-[10px] mb-1 text-muted">Volume to Convert (BBL)</label>
          <input type="number" step="0.01" min="0" className="inp text-xs w-full"
            value={volBbl} onChange={e => setVolBbl(e.target.value)} />
        </div>
        <div>
          <label className="block text-[10px] mb-1 text-muted">Notes (optional)</label>
          <input type="text" className="inp text-xs w-full" placeholder="e.g. dry-hop variant"
            value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <button type="button" onClick={save} disabled={saving}
          className="px-3 py-1.5 text-xs bg-accent-emphasis hover:bg-accent disabled:opacity-50 text-white rounded font-medium">
          {saving ? "Planning…" : "Plan Conversion"}
        </button>
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-muted hover:text-body">Cancel</button>
      </div>
    </div>
  );
}
