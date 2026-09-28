"use client";

import React, { useMemo, useState } from "react";
import type { BrewBatch, Equipment, Recipe } from "../../types";
import type { ScheduleEntry } from "../../hooks/queries";
import { STAGE_LABELS, IN_PACKAGE_STAGES } from "./constants";
import ConversionTargetFields, { emptyConversionTarget } from "../ConversionTargetFields";
import { pickConversionTank } from "@/lib/production/tankSlots";

export function ConvertPanel({
  batchId,
  sourceEntry,
  totalBbl,
  allBatches,
  sourceRecipeId,
  recipes,
  equipment,
  allScheduleEntries,
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
  equipment: Equipment[];
  allScheduleEntries: ScheduleEntry[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const stageLabel = STAGE_LABELS[sourceEntry.stage] ?? sourceEntry.stage;
  // Converting from a kegging/canning run = dosing in the keg/can: the new beer
  // is born in the container on that run, with no vessel in between.
  const inPackage = IN_PACKAGE_STAGES.has(sourceEntry.stage);
  const container = sourceEntry.stage === "canning" ? "can" : "keg";
  const defaultDate = ((inPackage ? sourceEntry.planned_start : sourceEntry.planned_end) ?? new Date().toISOString()).slice(0, 10);

  const [value, setValue] = useState(() => ({
    ...emptyConversionTarget(defaultDate),
    ...(inPackage ? { targetMode: "new" as const } : {}),
    volumeBbl: (totalBbl * (inPackage ? 0.25 : 0.5)).toFixed(2),
  }));
  const [tankId, setTankId] = useState("");
  const [saving, setSaving] = useState(false);

  // Candidate target batches: not this batch, not already a conversion child of
  // this batch (the server reuses those on its own), and still active.
  const candidateBatches = allBatches.filter(b =>
    b.id !== batchId &&
    b.converted_from_batch_id !== batchId &&
    b.status !== "complete"
  );

  const sourceBeerName = allBatches.find(b => b.id === batchId)?.beer_name ?? "this batch";

  // Where a new tank-conversion child will condition: the operator's pick when
  // it is free, else the first free vessel that holds the volume. The server
  // re-checks with the same rule on save.
  const vessels = useMemo(
    () => equipment.filter(e => e.type === "brite" || e.type === "fermenter")
      .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, undefined, { numeric: true })),
    [equipment],
  );
  const showTankPicker = !inPackage && value.targetMode === "new";
  const span = { start: value.conversionDate, end: value.expectedDeliveryDate || value.conversionDate };
  const vol = Number(value.volumeBbl) || 0;
  const pick = (preferredId: string | null) => pickConversionTank({
    tanks: vessels.map(v => ({ id: v.id, name: v.name, type: v.type, capacity_bbl: v.capacity_bbl ?? null })),
    entries: allScheduleEntries, volumeBbl: vol, ...span, preferredId,
  });
  const chosen = showTankPicker && span.start ? pick(tankId || null) : null;
  const pickIsBusy = !!tankId && chosen?.id !== tankId;
  const isFree = (id: string) => pick(id)?.id === id;

  async function save() {
    if (value.targetMode === "existing" && !value.targetBatchId) { alert("Select a target batch."); return; }
    if (value.targetMode === "new" && !value.newRecipeId) { alert("Select the beer the conversion produces."); return; }
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
          method:              inPackage ? "in_package" : "tank",
          destination_equipment_id: showTankPicker ? (chosen?.id ?? null) : null,
          volume_bbl:          vol,
          planned_date:        value.conversionDate || null,
          expected_delivery_date: inPackage ? (value.conversionDate || null) : (value.expectedDeliveryDate || null),
          notes:               value.notes || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to plan conversion");
      if (body.schedule_warning) alert(`Conversion planned. ${body.schedule_warning}`);
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
        <span className="text-xs font-medium text-[var(--cat-amber-fg)]">
          {inPackage ? `Plan In-${container === "can" ? "Can" : "Keg"} Conversion on ${stageLabel}` : `Plan Conversion from ${stageLabel}`}
        </span>
        <button type="button" onClick={onClose} className="text-xs text-faint hover:text-secondary">✕</button>
      </div>

      <p className="text-[11px] text-muted">
        {inPackage
          ? `Part of this ${stageLabel.toLowerCase()} run is dosed in the ${container} and becomes another beer. It gets its own batch, finished on the run — no tank.`
          : "Moves part of this batch into a tank where it becomes another beer — an existing batch, or a new one created now."}
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
        newOnly={inPackage}
        hideDelivery={inPackage}
        newModeHint={inPackage
          ? `Record the run under “Packaging as” this beer and it lands on this plan.`
          : "Creates the batch now and books its tank, kegging and canning."}
      />

      {showTankPicker && (
        <div>
          <label className="block text-xs mb-1 text-muted">Conditioning Tank</label>
          <select className="inp text-xs w-full" value={tankId} onChange={e => setTankId(e.target.value)}>
            <option value="">Auto — first free tank</option>
            {vessels.map(v => (
              <option key={v.id} value={v.id}>
                {v.name}{v.capacity_bbl ? ` (${v.capacity_bbl} bbl)` : ""}{span.start && !isFree(v.id) ? " — busy" : ""}
              </option>
            ))}
          </select>
          <p className={`text-[10px] mt-0.5 ${chosen && !pickIsBusy ? "text-faint" : "text-[var(--cat-amber-fg)]"}`}>
            {!span.start
              ? "Set a conversion date to check tanks."
              : chosen
                ? `${pickIsBusy ? "That tank is busy or too small — " : ""}Books ${chosen.name} ${span.start} → ${span.end}.`
                : `No brite or fermenter holding ${vol.toFixed(2)} bbl is free ${span.start} → ${span.end}. Conditioning will be left unassigned.`}
          </p>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button type="button" onClick={save} disabled={saving}
          className="btn-primary">
          {saving ? "Planning…" : "Plan Conversion"}
        </button>
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-muted hover:text-body">Cancel</button>
      </div>
    </div>
  );
}
