"use client";

import React, { useState } from "react";
import { Equipment, BrewBatch, PackagingVariation, Recipe, RecipePackagingVariation, UNCONSTRAINED_EQUIPMENT_TYPES } from "../types";
import { Modal, Field, ModalActions } from "./shared";
import { EQ } from "../equipmentMeta";
import { fmtBbl2 as fmtBbl } from "@/lib/utils/formatting";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import type { ScheduleEntry } from "../hooks/queries";
import { format, parseISO } from "date-fns";

// Allowed destinations by source equipment type. Fermenters and brite tanks
// are interchangeable for the fermenting→conditioning move (many breweries
// dual-purpose fermenters as brite tanks) — including staying in the SAME
// tank for an in-place conditioning transition (see `sameTankAllowed` below).
const DEST_RULES: Partial<Record<string, string[]>> = {
  brewhouse: ["fermenter"],
  fermenter: ["brite", "fermenter", "kegging", "canning"],
  brite:     ["brite", "fermenter", "kegging", "canning"],
  kegging:   ["cold_storage", "export_bay"],
  canning:   ["cold_storage", "export_bay"],
};

// Source types where staying in the same tank is a meaningful move (in-place
// fermenting → conditioning), rather than a no-op.
const SAME_TANK_ALLOWED_SOURCE_TYPES = new Set(["fermenter", "brite"]);

// Valid conversion-destination tank types by source type — conversion can be
// drawn off during fermenting OR conditioning, landing in whichever tank type
// matches that stage.
const CONVERT_DEST_TYPES: Partial<Record<string, string[]>> = {
  fermenter: ["fermenter"],
  brite:     ["brite", "fermenter"],
};

// Tank types where only one batch is allowed at a time
const SINGLE_OCCUPANCY_TYPES = new Set(["brewhouse", "fermenter", "brite"]);

interface TransferModalProps {
  batch: BrewBatch;
  fromTank: Equipment;
  allTanks: Equipment[];
  /** IDs of tanks that currently have an active batch assignment */
  occupiedTankIds: Set<string>;
  /** recipe_id(s) of whichever batch(es) currently occupy each tank, keyed by tank id */
  occupiedTankRecipeIds?: Record<string, (string | null)[]>;
  recipePackagingVariations: RecipePackagingVariation[];
  recipes: Recipe[];
  /** Ledger volume currently in fromTank; falls back to batch.volume_bbl if omitted */
  fromTankVolume?: number;
  /** Next planned schedule entry for the next stage of this batch (from batch_schedule_entries) */
  plannedEntry?: ScheduleEntry | null;
  /** Pre-select this destination tank on open, overriding the planned-entry auto-select, if it's a valid destination */
  initialDestId?: string;
  /** Open directly into Convert mode instead of the default Transfer mode */
  initialMode?: "transfer" | "convert";
  /** Pre-fill the Convert-mode fields (used when opened from a planned conversion's "Convert" action) */
  initialConvert?: { recipeId: string; beerName: string; bbl: string };
  onClose: () => void;
  onDone: (response?: { schedule_update?: { action: string; was_deviation?: boolean; equipment_name?: string }[] }) => Promise<void>;
}

export default function TransferModal({ batch, fromTank, allTanks, occupiedTankIds, occupiedTankRecipeIds, recipePackagingVariations, recipes, fromTankVolume, plannedEntry, initialDestId, initialMode, initialConvert, onClose, onDone }: TransferModalProps) {
  const [mode, setMode] = useState<"transfer" | "convert">(initialMode ?? "transfer");

  // Same-recipe batches may combine in the same tank — only a DIFFERENT
  // recipe already occupying the tank is a real conflict.
  const hasRecipeConflict = (tankId: string) => {
    const occupants = occupiedTankRecipeIds?.[tankId];
    if (!occupants || occupants.length === 0) return occupiedTankIds.has(tankId);
    return occupants.some(r => r !== batch.recipe_id);
  };

  const allowed = DEST_RULES[fromTank.type] ?? [];
  const sameTankOk = SAME_TANK_ALLOWED_SOURCE_TYPES.has(fromTank.type);
  const destTanks = allTanks.filter((t) => {
    const sameTank = t.id === fromTank.id;
    if (sameTank && !sameTankOk) return false;
    if (!allowed.includes(t.type)) return false;
    // For conversions, destination must be a free tank of a valid type for this stage
    // (same-tank conversion isn't meaningful — the conversion always draws into a NEW batch).
    if (mode === "convert") {
      if (sameTank) return false;
      const convertTypes = CONVERT_DEST_TYPES[fromTank.type] ?? ["fermenter"];
      return convertTypes.includes(t.type) && !occupiedTankIds.has(t.id);
    }
    if (sameTank) return true; // in-place conditioning / dual-use — always allowed
    // Single-occupancy: exclude tanks already holding a different recipe
    if (SINGLE_OCCUPANCY_TYPES.has(t.type) && hasRecipeConflict(t.id)) return false;
    return true;
  });

  interface PackagingLine { variation_id: string; quantity: string }

  const recipeVariations = recipePackagingVariations
    .filter((rv) => rv.recipe_id === batch.recipe_id)
    .map((rv) => rv.packaging_variations)
    .filter((v): v is PackagingVariation => v != null && v.is_active);

  const kegVariations = recipeVariations.filter((v) => v.container?.type === "keg");
  const canVariations = recipeVariations.filter((v) => v.container?.type === "can");

  const [packagingLines, setPackagingLines] = useState<PackagingLine[]>([{ variation_id: "", quantity: "" }]);

  // Pre-select planned destination if the planned entry points to a valid available tank;
  // an explicit initialDestId (from the Up Next banner) takes priority over both.
  const plannedDestId = plannedEntry?.equipment_id ?? null;
  const plannedDestValid = plannedDestId ? destTanks.some((t) => t.id === plannedDestId) : false;
  const initialDestValid = initialDestId ? destTanks.some((t) => t.id === initialDestId) : false;
  const [destId, setDestId] = useState(
    initialDestValid && initialDestId ? initialDestId
      : plannedDestValid && plannedDestId ? plannedDestId
      : (destTanks[0]?.id ?? "")
  );
  const [volumeMode, setVolumeMode] = useState<"full" | "partial">("full");
  const [partialBbl, setPartialBbl] = useState("");
  const [shrinkage,  setShrinkage]  = useState("0");
  const [notes,      setNotes]      = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Conversion-specific state
  const [convertRecipeId, setConvertRecipeId] = useState(initialConvert?.recipeId ?? "");
  const [convertBeerName, setConvertBeerName] = useState(initialConvert?.beerName ?? "");
  const [convertBbl,      setConvertBbl]      = useState(initialConvert?.bbl ?? "");

  const destTank = allTanks.find((t) => t.id === destId);

  // Recompute destTanks when mode changes — reset destId if current selection is invalid
  const validDestIds = new Set(destTanks.map((t) => t.id));
  const effectiveDestId = validDestIds.has(destId) ? destId : (destTanks[0]?.id ?? "");

  // Whether to show keg/can packaging forms — based on SOURCE type (out-transfers) or DEST type (packaging transfers)
  const showKegDetail = mode === "transfer" && (fromTank.type === "kegging" || destTank?.type === "kegging");
  const showCanDetail = mode === "transfer" && (fromTank.type === "canning" || destTank?.type === "canning");
  const isPackagingForm = showKegDetail || showCanDetail;

  const batchVol  = fromTankVolume ?? Number(batch.volume_bbl);
  const shrinkBbl = parseFloat(shrinkage) || 0;

  let drawBbl = 0;
  if (mode === "convert") {
    drawBbl = parseFloat(convertBbl) || 0;
  } else if (isPackagingForm) {
    drawBbl = packagingLines.reduce((sum, l) => {
      const variation = recipeVariations.find((v) => v.id === l.variation_id);
      const qty = parseInt(l.quantity) || 0;
      if (!variation) return sum;
      return sum + (qty * variation.total_volume_fl_oz) / BBL_TO_FL_OZ;
    }, 0);
  } else if (volumeMode === "full") {
    drawBbl = Math.max(0, batchVol - shrinkBbl);
  } else {
    drawBbl = parseFloat(partialBbl) || 0;
  }

  const totalDraw = drawBbl + (mode === "convert" ? 0 : shrinkBbl);
  const remaining = batchVol - totalDraw;

  const destIsConstrained = destTank && !UNCONSTRAINED_EQUIPMENT_TYPES.includes(destTank.type);

  // Conversion can be drawn off mid-fermenting OR mid-conditioning
  const canConvert = fromTank.type === "fermenter" || fromTank.type === "brite";

  function handleModeChange(m: "transfer" | "convert") {
    setMode(m);
    // Reset destination to first valid option for the new mode
    const newDests = allTanks.filter((t) => {
      const sameTank = t.id === fromTank.id;
      if (sameTank && !sameTankOk) return false;
      if (!allowed.includes(t.type)) return false;
      if (m === "convert") {
        if (sameTank) return false;
        const convertTypes = CONVERT_DEST_TYPES[fromTank.type] ?? ["fermenter"];
        return convertTypes.includes(t.type) && !occupiedTankIds.has(t.id);
      }
      if (sameTank) return true;
      if (SINGLE_OCCUPANCY_TYPES.has(t.type) && hasRecipeConflict(t.id)) return false;
      return true;
    });
    setDestId(newDests[0]?.id ?? "");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!effectiveDestId) return;

    setSubmitting(true);
    try {
      if (mode === "convert") {
        if (!convertRecipeId || !convertBeerName || !convertBbl) {
          alert("Please fill in all conversion fields.");
          return;
        }
        const res = await fetch("/api/production/conversions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            batch_id:    batch.id,
            from_tank_id: fromTank.id,
            to_tank_id:  effectiveDestId,
            volume_bbl:  parseFloat(convertBbl),
            recipe_id:   convertRecipeId,
            beer_name:   convertBeerName,
            notes:       notes || null,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Error");
        await onDone();
        onClose();
        return;
      }

      // Capacity guard for constrained tanks
      if (destIsConstrained && destTank?.capacity_bbl) {
        if (drawBbl > destTank.capacity_bbl) {
          alert(`Transfer volume (${fmtBbl(drawBbl)}) exceeds ${destTank.name} capacity (${fmtBbl(destTank.capacity_bbl)} BBL).`);
          return;
        }
      }

      if (isPackagingForm && !(packagingLines.some((l) => l.variation_id && (parseInt(l.quantity) || 0) > 0))) {
        alert("Select at least one packaging variation and quantity.");
        return;
      }

      let packaging_lines: { variation_id: string; quantity: number }[] | undefined;
      let transfer_type: "transfer" | "kegging" | "canning" = "transfer";

      if (showKegDetail) {
        transfer_type = "kegging";
        packaging_lines = packagingLines
          .filter((l) => l.variation_id && (parseInt(l.quantity) || 0) > 0)
          .map((l) => ({ variation_id: l.variation_id, quantity: parseInt(l.quantity) || 0 }));
      } else if (showCanDetail) {
        transfer_type = "canning";
        packaging_lines = packagingLines
          .filter((l) => l.variation_id && (parseInt(l.quantity) || 0) > 0)
          .map((l) => ({ variation_id: l.variation_id, quantity: parseInt(l.quantity) || 0 }));
      }

      const res = await fetch("/api/production/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batch_id:      batch.id,
          from_tank_id:  fromTank.id,
          to_tank_id:    effectiveDestId,
          ...(packaging_lines ? {} : { volume_bbl: drawBbl }),
          shrinkage_bbl: shrinkBbl,
          transfer_type,
          notes:         notes || null,
          packaging_lines,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      const responseData = await res.json();
      await onDone(responseData);
      onClose();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Transfer Batch" onClose={onClose} extraWide>
      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Batch summary */}
        <div className="flex gap-3 p-2.5 rounded bg-zinc-900/60 border border-zinc-800 text-sm">
          <div>
            <span className="text-zinc-500 text-xs">Batch</span>
            <p className="text-zinc-100 font-medium">{batch.beer_name}</p>
            <p className="text-zinc-500 font-mono text-xs">{batch.batch_number ?? "—"}</p>
          </div>
          <div className="mx-2 w-px bg-zinc-800" />
          <div>
            <span className="text-zinc-500 text-xs">From</span>
            <p className="text-zinc-100">{fromTank.name}</p>
            <p className="text-zinc-500 text-xs">{EQ[fromTank.type]?.label ?? fromTank.type}</p>
          </div>
          <div className="mx-2 w-px bg-zinc-800" />
          <div>
            <span className="text-zinc-500 text-xs">Batch Volume</span>
            <p className="text-zinc-100">{fmtBbl(batchVol)}</p>
          </div>
        </div>

        {/* Mode toggle — shown for fermenters/brite, which can also draw a conversion */}
        {canConvert && (
          <div className="flex gap-2">
            <button type="button" onClick={() => handleModeChange("transfer")}
              className={`px-3 py-1.5 text-sm rounded border transition-colors ${mode === "transfer" ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
              Transfer
            </button>
            <button type="button" onClick={() => handleModeChange("convert")}
              className={`px-3 py-1.5 text-sm rounded border transition-colors ${mode === "convert" ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
              Convert
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          {/* ── Left column: where it's going (inputs only) ── */}
          <div className="space-y-3">
            {/* Convert mode description */}
            {mode === "convert" && (
              <div className="px-3 py-2 rounded border border-amber-700/40 bg-amber-950/30 text-xs text-amber-300">
                Split a partial volume into a <span className="font-semibold">new batch</span> under a different recipe. The remaining volume stays in {fromTank.name} under the original batch.
              </div>
            )}

            {/* Allowed-destinations hint (transfer mode only) */}
            {mode === "transfer" && (
              <p className="text-xs text-zinc-500 bg-zinc-800/40 px-3 py-1.5 rounded border border-zinc-700">
                {fromTank.type === "brewhouse" && "Brewhouse → Fermenter only"}
                {fromTank.type === "fermenter" && "Fermenter → Brite/Fermenter (incl. staying put for in-place conditioning), Kegging, or Canning"}
                {fromTank.type === "brite"     && "Brite → Brite/Fermenter (incl. staying put), Kegging, or Canning"}
                {(fromTank.type === "kegging" || fromTank.type === "canning") && "Packaging → Cold Storage or Export Bay only"}
              </p>
            )}

            <Field label="Destination" required>
              {/* Planned booking pill (transfer mode only) */}
              {mode === "transfer" && plannedEntry && plannedEntry.equipment_id && (
                <div className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded bg-zinc-800/60 border border-zinc-700 text-xs text-zinc-400">
                  <span>📋 Planned:</span>
                  <span className="text-zinc-200 font-medium">{plannedEntry.equipment?.name ?? "Unknown"}</span>
                  <span className="text-zinc-500">
                    {format(parseISO(plannedEntry.planned_start), "MMM d")}–{format(parseISO(plannedEntry.planned_end), "MMM d")}
                  </span>
                </div>
              )}
              <select className="inp" value={effectiveDestId} required onChange={(e) => setDestId(e.target.value)}>
                <option value="">— select —</option>
                {destTanks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({EQ[t.type]?.label ?? t.type})
                    {t.id === fromTank.id ? " · stay in place" : ""}
                    {t.capacity_bbl ? ` · ${t.capacity_bbl} BBL` : ""}
                    {(occupiedTankRecipeIds?.[t.id]?.length ?? 0) > 0 ? " · combining with existing batch" : ""}
                  </option>
                ))}
              </select>
              {destTanks.length === 0 && mode === "convert" && (
                <p className="text-xs text-zinc-500 mt-1">No free tanks available for a conversion from this stage.</p>
              )}
            </Field>
          </div>

          {/* ── Right column: how much / what's converting ── */}
          <div className="space-y-3">
            {/* ── Convert mode fields ── */}
            {mode === "convert" && (
              <>
                <Field label="New Recipe" required>
                  <select className="inp" value={convertRecipeId} required onChange={(e) => {
                    const r = recipes.find((r) => r.id === e.target.value);
                    setConvertRecipeId(e.target.value);
                    if (r && !convertBeerName) setConvertBeerName(r.beer_name);
                  }}>
                    <option value="">— select recipe —</option>
                    {recipes.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.beer_name}{r.brewery ? ` · ${r.brewery}` : ""}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="New Batch Name" required>
                  <input className="inp" value={convertBeerName} required
                    placeholder="e.g. Wheat Wit"
                    onChange={(e) => setConvertBeerName(e.target.value)} />
                </Field>

                <Field label="Volume to Convert (BBL)" required>
                  <div className="flex items-center gap-2">
                    <input type="number" step="0.001" min="0.001" max={batchVol} className="inp w-40"
                      placeholder="0.000" required
                      value={convertBbl} onChange={(e) => setConvertBbl(e.target.value)} />
                    <span className="text-zinc-500 text-sm">BBL</span>
                  </div>
                </Field>
              </>
            )}

            {/* ── Regular transfer: full / partial ── */}
            {mode === "transfer" && !isPackagingForm && (
              <Field label="Volume">
                <div className="flex gap-2 mb-2">
                  <button type="button" onClick={() => setVolumeMode("full")}
                    className={`px-3 py-1.5 text-sm rounded border transition-colors ${volumeMode === "full" ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
                    Full transfer
                  </button>
                  <button type="button" onClick={() => setVolumeMode("partial")}
                    className={`px-3 py-1.5 text-sm rounded border transition-colors ${volumeMode === "partial" ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
                    Partial
                  </button>
                </div>
                {volumeMode === "partial" && (
                  <div className="flex items-center gap-2">
                    <input type="number" step="0.001" min="0" max={batchVol} className="inp w-40" placeholder="0.000"
                      value={partialBbl} onChange={(e) => setPartialBbl(e.target.value)} />
                    <span className="text-zinc-500 text-sm">BBL</span>
                  </div>
                )}
              </Field>
            )}

            {/* Shrinkage — not applicable for packaging out-transfers or conversions */}
            {mode === "transfer" && !isPackagingForm && (
              <Field label="Shrinkage (BBL)">
                <div className="flex items-center gap-2">
                  <input type="number" step="0.001" min="0" className="inp w-40" placeholder="0.000"
                    value={shrinkage} onChange={(e) => setShrinkage(e.target.value)} />
                  <span className="text-zinc-500 text-sm">BBL lost</span>
                </div>
              </Field>
            )}
          </div>
        </div>

        {/* ── Full-width hints/warnings, kept out of the 2-col grid above so
             column heights stay in sync regardless of which warnings show ── */}
        {mode === "transfer" && destIsConstrained && destTank?.capacity_bbl && (
          <p className="text-xs text-zinc-500">Capacity: {fmtBbl(destTank.capacity_bbl)} — transfer will be rejected if it exceeds this.</p>
        )}
        {mode === "transfer" && plannedEntry && plannedEntry.equipment_id && effectiveDestId && effectiveDestId !== plannedEntry.equipment_id && (
          <div className="px-3 py-2 rounded border border-amber-700/60 bg-amber-950/40 text-xs text-amber-300">
            ⚠ <span className="font-semibold">Deviation from plan:</span> this batch was scheduled for{" "}
            <span className="text-amber-200 font-medium">{plannedEntry.equipment?.name ?? "another tank"}</span>.
            Proceeding will cancel that booking and may cause conflicts with downstream schedule entries that will need to be resolved.
          </div>
        )}
        {mode === "convert" && drawBbl > 0 && remaining <= 0 && (
          <p className="text-amber-400 text-xs">
            Full conversion — the parent batch will be marked complete after this.
          </p>
        )}

        {/* ── Packaging detail (kegging or canning) ── */}
        {isPackagingForm && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-zinc-400">{showKegDetail ? "Kegs" : "Cans"}</label>
              <button type="button" onClick={() => setPackagingLines((l) => [...l, { variation_id: "", quantity: "" }])}
                className="text-xs text-amber-500 hover:text-amber-400">+ Add line</button>
            </div>
            {(showKegDetail ? kegVariations : canVariations).length === 0 && (
              <p className="text-xs text-zinc-600">
                No packaging variations declared for this recipe — add one in Recipes → Packaging Variations.
              </p>
            )}
            <div className="space-y-2">
              {packagingLines.map((line, i) => (
                <div key={i} className="grid items-center gap-2" style={{ gridTemplateColumns: "1fr 64px auto" }}>
                  <select className="inp" value={line.variation_id}
                    onChange={(e) => setPackagingLines((ls) => ls.map((l, idx) => idx === i ? { ...l, variation_id: e.target.value } : l))}>
                    <option value="">— select variation —</option>
                    {(showKegDetail ? kegVariations : canVariations).map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                  <input type="number" min="0" className="inp" placeholder="qty"
                    value={line.quantity}
                    onChange={(e) => setPackagingLines((ls) => ls.map((l, idx) => idx === i ? { ...l, quantity: e.target.value } : l))} />
                  {packagingLines.length > 1
                    ? <button type="button" onClick={() => setPackagingLines((ls) => ls.filter((_, idx) => idx !== i))}
                        className="text-zinc-600 hover:text-red-400 text-lg leading-none">×</button>
                    : <span />}
                </div>
              ))}
            </div>
            <p className="text-xs text-zinc-500 mt-2">
              Total: {packagingLines.reduce((s, l) => s + (parseInt(l.quantity) || 0), 0)} · Draw: {fmtBbl(drawBbl)}
            </p>
          </div>
        )}

        {/* Volume summary + notes, side by side to save vertical space */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          <div>
            <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3 text-xs space-y-1">
              <div className="flex justify-between text-zinc-400">
                <span>Batch volume</span><span>{fmtBbl(batchVol)}</span>
              </div>
              <div className="flex justify-between text-zinc-400">
                <span>{mode === "convert" ? "Converted volume" : "Transfer draw"}</span>
                <span>− {fmtBbl(drawBbl)}</span>
              </div>
              {mode === "transfer" && shrinkBbl > 0 && (
                <div className="flex justify-between text-zinc-400">
                  <span>Shrinkage</span><span>− {fmtBbl(shrinkBbl)}</span>
                </div>
              )}
              <div className={`flex justify-between font-medium border-t border-zinc-800 pt-1 mt-1 ${remaining < 0 ? "text-red-400" : "text-zinc-100"}`}>
                <span>Remaining</span><span>{fmtBbl(remaining)}</span>
              </div>
            </div>
            {remaining < -0.001 && (
              <p className="text-xs text-red-400 mt-1">Warning: volume exceeds batch volume.</p>
            )}
            {mode === "transfer" && destIsConstrained && destTank?.capacity_bbl && drawBbl > destTank.capacity_bbl && (
              <p className="text-xs text-red-400 mt-1">
                Transfer ({fmtBbl(drawBbl)}) exceeds {destTank.name} capacity ({fmtBbl(destTank.capacity_bbl)}).
              </p>
            )}
          </div>
          <Field label="Notes">
            <input className="inp" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>

        <ModalActions submitting={submitting} onCancel={onClose}
          label={mode === "convert" ? "Convert Batch" : "Record Transfer"} />
      </form>
    </Modal>
  );
}
