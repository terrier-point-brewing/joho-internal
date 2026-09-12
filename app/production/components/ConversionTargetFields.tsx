"use client";

/**
 * The one conversion-details block every path shares.
 *
 * Five different surfaces can start a conversion (plan into existing, plan a
 * new child, execute into existing, execute a new child, in-keg), and each
 * used to ask its own subset of questions — free-text names on one, silent
 * dates on another. This component is the standard set: what it becomes, how
 * much, when, and when it delivers. Callers own everything around it
 * (destination tanks, shrinkage, packaging lines, submit).
 *
 * The beer name is never typed: a conversion produces a recipe's beer, so the
 * name IS the recipe's name. The delivery date auto-follows the conversion
 * date + the recipe's brite time until the operator edits it by hand.
 */

import React, { useRef } from "react";
import type { BrewBatch, Recipe } from "../types";
import ToggleChip from "@/app/components/ui/ToggleChip";
import { baseMapOf, lineageDescendants } from "@/lib/production/recipeLineage";
import { addDaysStr } from "@/lib/utils/datetime";

export interface ConversionTargetValue {
  targetMode: "existing" | "new";
  targetBatchId: string;
  newRecipeId: string;
  volumeBbl: string;
  /** YYYY-MM-DD — the day the conversion happens (plan) or happened (execute). */
  conversionDate: string;
  /** YYYY-MM-DD — auto-derived until the operator edits it. */
  expectedDeliveryDate: string;
  notes: string;
}

export function emptyConversionTarget(conversionDate: string): ConversionTargetValue {
  return {
    targetMode: "existing",
    targetBatchId: "",
    newRecipeId: "",
    volumeBbl: "",
    conversionDate,
    expectedDeliveryDate: conversionDate,
    notes: "",
  };
}

/** Conversion day + the recipe's remaining (brite) lead time — the client-side
 *  twin of the server's deriveConversionDeliveryDate. */
export function deriveDeliveryDate(recipe: Recipe | null | undefined, conversionDate: string): string {
  const briteDays = Number(recipe?.days_brite ?? 0);
  return briteDays > 0 && conversionDate ? addDaysStr(conversionDate, briteDays) : conversionDate;
}

export default function ConversionTargetFields({
  sourceBeerName,
  sourceRecipeId,
  recipes,
  candidateBatches,
  value,
  onChange,
  volumeMax,
  showNotes = false,
  newModeHint,
}: {
  sourceBeerName: string;
  /** Recipe of the batch being drawn from — the base a target may be linked to. */
  sourceRecipeId: string | null;
  recipes: Recipe[];
  /** Existing-mode target options, already filtered by the caller's rules. */
  candidateBatches: BrewBatch[];
  value: ConversionTargetValue;
  onChange: (v: ConversionTargetValue) => void;
  volumeMax?: number;
  showNotes?: boolean;
  /** Per-path hint rendered under the new-batch recipe select. */
  newModeHint?: string;
}) {
  // The last delivery date this component derived on its own. While the field
  // still holds that value the operator hasn't touched it, so recipe/date
  // changes keep re-deriving; one manual edit and it's theirs.
  const lastAutoDelivery = useRef(value.expectedDeliveryDate);

  const derivedRecipeIds = sourceRecipeId
    ? lineageDescendants(sourceRecipeId, baseMapOf(recipes))
    : new Set<string>();

  const linkedBatches   = candidateBatches.filter(b => b.recipe_id != null && derivedRecipeIds.has(b.recipe_id));
  const unlinkedBatches = candidateBatches.filter(b => !(b.recipe_id != null && derivedRecipeIds.has(b.recipe_id)));
  const linkedRecipes   = recipes.filter(r => derivedRecipeIds.has(r.id)).sort((a, b) => a.beer_name.localeCompare(b.beer_name));
  const unlinkedRecipes = recipes.filter(r => !derivedRecipeIds.has(r.id)).sort((a, b) => a.beer_name.localeCompare(b.beer_name));

  const selectedRecipeId = value.targetMode === "new"
    ? (value.newRecipeId || null)
    : (candidateBatches.find(b => b.id === value.targetBatchId)?.recipe_id ?? null);
  const selectedRecipe = selectedRecipeId ? recipes.find(r => r.id === selectedRecipeId) ?? null : null;
  const unlinked = selectedRecipeId != null && !derivedRecipeIds.has(selectedRecipeId);

  /** Apply a change and re-derive the delivery date when it is still ours. */
  function update(patch: Partial<ConversionTargetValue>) {
    const next = { ...value, ...patch };
    const recipeAfter = next.targetMode === "new"
      ? (next.newRecipeId ? recipes.find(r => r.id === next.newRecipeId) ?? null : null)
      : (candidateBatches.find(b => b.id === next.targetBatchId)?.recipe_id
          ? recipes.find(r => r.id === candidateBatches.find(b => b.id === next.targetBatchId)!.recipe_id) ?? null
          : null);
    if (patch.expectedDeliveryDate === undefined) {
      const auto = deriveDeliveryDate(recipeAfter, next.conversionDate);
      if (value.expectedDeliveryDate === lastAutoDelivery.current || !value.expectedDeliveryDate) {
        next.expectedDeliveryDate = auto;
        lastAutoDelivery.current = auto;
      }
    }
    onChange(next);
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-1">
        <ToggleChip active={value.targetMode === "existing"} onClick={() => update({ targetMode: "existing" })}>
          Existing batch
        </ToggleChip>
        <ToggleChip active={value.targetMode === "new"} onClick={() => update({ targetMode: "new" })}>
          New batch
        </ToggleChip>
      </div>

      {value.targetMode === "existing" ? (
        <div>
          <label className="block text-xs mb-1 text-muted">Target Batch <span className="text-danger">*</span></label>
          <select className="inp text-xs w-full" value={value.targetBatchId} onChange={e => update({ targetBatchId: e.target.value })}>
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
              <optgroup label={linkedBatches.length > 0 ? "Other batches (additions won't be costed)" : "All batches"}>
                {unlinkedBatches.map(b => (
                  <option key={b.id} value={b.id}>
                    {b.batch_number ? `#${b.batch_number} ` : ""}{b.beer_name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
      ) : (
        <div>
          <label className="block text-xs mb-1 text-muted">Produces <span className="text-danger">*</span></label>
          <select className="inp text-xs w-full" value={value.newRecipeId} onChange={e => update({ newRecipeId: e.target.value })}>
            <option value="">— select beer —</option>
            {linkedRecipes.length > 0 && (
              <optgroup label={`Based on ${sourceBeerName}`}>
                {linkedRecipes.map(r => (
                  <option key={r.id} value={r.id}>{r.beer_name}</option>
                ))}
              </optgroup>
            )}
            {unlinkedRecipes.length > 0 && (
              <optgroup label={linkedRecipes.length > 0 ? "Other recipes (additions won't be costed)" : "All recipes"}>
                {unlinkedRecipes.map(r => (
                  <option key={r.id} value={r.id}>{r.beer_name}</option>
                ))}
              </optgroup>
            )}
          </select>
          {newModeHint && <p className="text-xs text-muted mt-1">{newModeHint}</p>}
        </div>
      )}

      {/* A warning, never a block: converting into an unrelated beer is a real
        * thing to do — it just cannot be costed, so say so plainly. */}
      {unlinked && (
        <p className="text-xs text-[var(--cat-amber-fg)]">
          Not based on {sourceBeerName} — no added ingredients will be reserved or charged.
          Set &ldquo;Based On&rdquo; under Recipes to have the additions costed. The conversion
          itself goes through either way.
        </p>
      )}

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-xs mb-1 text-muted">Volume (BBL) <span className="text-danger">*</span></label>
          <input type="number" step="0.001" min="0.001" {...(volumeMax != null ? { max: volumeMax } : {})}
            className="inp text-xs w-full" placeholder="0.000"
            value={value.volumeBbl} onChange={e => update({ volumeBbl: e.target.value })} />
        </div>
        <div>
          <label className="block text-xs mb-1 text-muted">Conversion Date</label>
          <input type="date" className="inp text-xs w-full"
            value={value.conversionDate} onChange={e => update({ conversionDate: e.target.value })} />
        </div>
        <div>
          <label className="block text-xs mb-1 text-muted">Expected Delivery</label>
          <input type="date" className="inp text-xs w-full"
            value={value.expectedDeliveryDate}
            onChange={e => { lastAutoDelivery.current = ""; update({ expectedDeliveryDate: e.target.value }); }} />
          {selectedRecipe != null && (
            <p className="text-[10px] text-faint mt-0.5">
              {Number(selectedRecipe.days_brite ?? 0) > 0
                ? `Auto: conversion + ${selectedRecipe.days_brite}d conditioning`
                : "Auto: same day (no conditioning time on recipe)"}
            </p>
          )}
        </div>
      </div>

      {showNotes && (
        <div>
          <label className="block text-xs mb-1 text-muted">Notes (optional)</label>
          <input type="text" className="inp text-xs w-full" placeholder="e.g. dry-hop variant"
            value={value.notes} onChange={e => update({ notes: e.target.value })} />
        </div>
      )}
    </div>
  );
}
