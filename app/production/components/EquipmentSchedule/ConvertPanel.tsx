"use client";

import React, { useState } from "react";
import type { BrewBatch, Recipe } from "../../types";
import type { ScheduleEntry } from "../../hooks/queries";
import { STAGE_LABELS } from "./constants";
import ConversionTargetFields, { emptyConversionTarget } from "../ConversionTargetFields";

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
  const stageLabel = STAGE_LABELS[sourceEntry.stage] ?? sourceEntry.stage;
  const defaultDate = (sourceEntry.planned_end ?? new Date().toISOString()).slice(0, 10);

  const [value, setValue] = useState(() => ({
    ...emptyConversionTarget(defaultDate),
    volumeBbl: (totalBbl * 0.5).toFixed(2),
  }));
  const [saving, setSaving] = useState(false);

  // Candidate target batches: not this batch, not already a conversion child of
  // this batch (the server reuses those on its own), and still active.
  const candidateBatches = allBatches.filter(b =>
    b.id !== batchId &&
    b.converted_from_batch_id !== batchId &&
    b.status !== "complete"
  );

  const sourceBeerName = allBatches.find(b => b.id === batchId)?.beer_name ?? "this batch";

  async function save() {
    if (value.targetMode === "existing" && !value.targetBatchId) { alert("Select a target batch."); return; }
    if (value.targetMode === "new" && !value.newRecipeId) { alert("Select the beer the conversion produces."); return; }
    const vol = Number(value.volumeBbl);
    if (!vol || vol <= 0) { alert("Volume must be greater than 0."); return; }

    setSaving(true);
    try {
      const res = await fetch("/api/production/batch-conversions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_batch_id:     batchId,
          ...(value.targetMode === "existing"
            ? { target_batch_id: value.targetBatchId }
            : { new_target: { recipe_id: value.newRecipeId } }),
          source_equipment_id: sourceEntry.equipment_id ?? null,
          volume_bbl:          vol,
          planned_date:        value.conversionDate || null,
          expected_delivery_date: value.expectedDeliveryDate || null,
          notes:               value.notes || null,
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
        Links a portion of this batch to a target batch as a conversion — an existing batch,
        or a new one created now for a conversion that happens in the keg or can.
      </p>

      <ConversionTargetFields
        sourceBeerName={sourceBeerName}
        sourceRecipeId={sourceRecipeId}
        recipes={recipes}
        candidateBatches={candidateBatches}
        value={value}
        onChange={setValue}
        volumeMax={totalBbl}
        showNotes
        newModeHint={"Creates the batch now (reserving what the conversion adds) — the kegging or canning run that declares this beer under “Packaging as” lands on it."}
      />

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
