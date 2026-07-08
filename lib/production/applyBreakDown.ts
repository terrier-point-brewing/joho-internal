// lib/production/applyBreakDown.ts
//
// IO layer for cold-storage pack break-downs. Resolves the target variation's
// can-identity family (same container + lid + label + partner, differing only by
// tier), tops up the target tier by cracking higher tiers per planBreakDown, and
// journals each break to cold_storage_breaks. Breaks stay within a single batch so
// attribution is preserved. Scoped to the taproom fungible path — the caller
// (recordTaproomConsumption) invokes this only when the target tier is short.

import type { SupabaseClient } from "@supabase/supabase-js";
import { planBreakDown, deriveCansEach, type Tier } from "./coldStorageBreak";

export interface AppliedBreak {
  batchId: string;
  fromVariationId: string;
  toVariationId: string;
  toUnits: number;
}

export interface ApplyBreakResult {
  applied: AppliedBreak[];
  shortfall: number;
  warnings: string[];
}

const CAN_FORMATS = new Set(["loose", "4-pack", "6-pack", "case"]);
const DUST = 1e-4;

const nullSafeEq = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

export async function applyBreakDown(
  supabase: SupabaseClient,
  params: { recipeId: string; variationId: string; needed: number; sourceRef?: string | null },
): Promise<ApplyBreakResult> {
  const { recipeId, variationId, needed } = params;
  const sourceRef = params.sourceRef ?? null;

  // 1. Target identity.
  const { data: target, error: tErr } = await supabase
    .from("packaging_variations")
    .select("container_id, lid_id, label_id, partner_id")
    .eq("id", variationId)
    .single();
  if (tErr) throw new Error(tErr.message);
  if (!target) return { applied: [], shortfall: 0, warnings: [] };

  // 2. Candidate siblings by (indexed) container_id, then full null-safe identity in JS.
  const { data: candidates, error: cErr } = await supabase
    .from("packaging_variations")
    .select("id, format, total_volume_fl_oz, container_id, lid_id, label_id, partner_id")
    .eq("container_id", target.container_id);
  if (cErr) throw new Error(cErr.message);

  const family = (candidates ?? []).filter(
    (v) =>
      CAN_FORMATS.has(v.format) &&
      nullSafeEq(v.lid_id, target.lid_id) &&
      nullSafeEq(v.label_id, target.label_id) &&
      nullSafeEq(v.partner_id, target.partner_id),
  );

  // 3. No higher tier to break -> nothing to do (kegs, or a can with only its own tier).
  if (family.length < 2) return { applied: [], shortfall: 0, warnings: [] };

  // 4. Tier sizes from volume (+ validation warnings).
  const { tiers: derived, warnings } = deriveCansEach({
    variations: family.map((v) => ({ variationId: v.id, format: v.format, totalVolumeFlOz: Number(v.total_volume_fl_oz) })),
  });

  // 5. Current on-hand per tier for this recipe.
  const varIds = derived.map((t) => t.variationId);
  const { data: onHandRows, error: ohErr } = await supabase
    .from("cold_storage_inventory")
    .select("variation_id, quantity_on_hand")
    .eq("recipe_id", recipeId)
    .in("variation_id", varIds);
  if (ohErr) throw new Error(ohErr.message);
  const onHandByVar = new Map<string, number>();
  for (const r of onHandRows ?? []) onHandByVar.set(r.variation_id, (onHandByVar.get(r.variation_id) ?? 0) + Number(r.quantity_on_hand));

  const tiers: Tier[] = derived.map((t) => ({ ...t, onHand: onHandByVar.get(t.variationId) ?? 0 }));

  // 6. Plan.
  const plan = planBreakDown({ tiers, targetVariationId: variationId, needed });

  // 7. Execute each op within a single batch.
  const applied: AppliedBreak[] = [];
  for (const op of plan.ops) {
    // Oldest cold-storage row of the parent tier for this recipe -> its batch.
    const { data: srcRows, error: sErr } = await supabase
      .from("cold_storage_inventory")
      .select("id, batch_id, quantity_on_hand, created_at")
      .eq("recipe_id", recipeId)
      .eq("variation_id", op.fromVariationId)
      .order("created_at", { ascending: true })
      .limit(1);
    if (sErr) throw new Error(sErr.message);
    const srcRow = (srcRows ?? [])[0];
    if (!srcRow) continue; // raced away since planning; skip (caller re-checks availability)
    const batchId = srcRow.batch_id;

    // Decrement one parent unit (delete at dust).
    const remaining = Number(srcRow.quantity_on_hand) - 1;
    if (remaining <= DUST) {
      const { error } = await supabase.from("cold_storage_inventory").delete().eq("id", srcRow.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from("cold_storage_inventory")
        .update({ quantity_on_hand: remaining, updated_at: new Date().toISOString() }).eq("id", srcRow.id);
      if (error) throw new Error(error.message);
    }

    // Add child units to the SAME batch's child row (create if missing).
    const { data: childRows, error: chErr } = await supabase
      .from("cold_storage_inventory")
      .select("id, quantity_on_hand")
      .eq("recipe_id", recipeId)
      .eq("variation_id", op.toVariationId)
      .eq("batch_id", batchId)
      .limit(1);
    if (chErr) throw new Error(chErr.message);
    const childRow = (childRows ?? [])[0];
    if (childRow) {
      const { error } = await supabase.from("cold_storage_inventory")
        .update({ quantity_on_hand: Number(childRow.quantity_on_hand) + op.toUnits, updated_at: new Date().toISOString() })
        .eq("id", childRow.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from("cold_storage_inventory")
        .insert({ batch_id: batchId, recipe_id: recipeId, variation_id: op.toVariationId, quantity_on_hand: op.toUnits });
      if (error) throw new Error(error.message);
    }

    // Journal the break.
    const { error: jErr } = await supabase.from("cold_storage_breaks").insert({
      batch_id: batchId,
      recipe_id: recipeId,
      from_variation_id: op.fromVariationId,
      to_variation_id: op.toVariationId,
      from_units: op.fromUnits,
      to_units: op.toUnits,
      source_ref: sourceRef,
    });
    if (jErr) throw new Error(jErr.message);

    applied.push({ batchId, fromVariationId: op.fromVariationId, toVariationId: op.toVariationId, toUnits: op.toUnits });
  }

  return { applied, shortfall: plan.shortfall, warnings };
}
