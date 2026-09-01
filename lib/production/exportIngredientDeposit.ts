import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateIngredientDeposit } from "@/lib/square/square-invoices";
import { computeLocationBreakdown, type LedgerTransfer } from "@/lib/production/volumeLedger";
import { baseMapOf, isDerivedFrom, lineageAncestors } from "@/lib/production/recipeLineage";

/**
 * Ingredient deposit for a shipment that is being billed as contract brewing
 * without ever having been a contract-brewing allocation.
 *
 * The normal deposit runs off the allocation, up front, and the route that
 * generates it refuses any allocation whose channel isn't contract_brewing. A
 * distribution shipment re-billed through the "Bill as" override therefore has
 * no deposit anywhere — which is why invoice #000041's $284.10 line was typed
 * by hand.
 *
 * ── The percentage ───────────────────────────────────────────────────────────
 * NOT shipped ÷ nominal batch volume. Beer is lost between the tank and the
 * package, and the ingredients that became that loss were still bought. Whoever
 * took beer out of the batch shares the whole bill, so the denominator is the
 * volume the batch YIELDS — a 20 bbl batch that yields 18 splits its $1,000 of
 * grain across those 18, not across 20.
 *
 * Nor shipped-to-date: that grows as the rest of the batch goes out, so the
 * first shipment invoiced would carry a share that shrinks with every later one.
 *
 * ── Packaging that hasn't finished ───────────────────────────────────────────
 * Beer ships before its batch is fully packaged, so packaged-to-date is NOT the
 * denominator either — dividing by it mid-run makes every early shipment look
 * like a huge share of a small batch and overcharges the partner.
 *
 * The denominator is therefore the batch's PROJECTED yield:
 *
 *     packaged so far  +  what is still unpackaged in its tanks, shrunk to the
 *                         volume that beer is expected to actually yield
 *
 * "Unpackaged" is the backlog / brewhouse / fermenter / brite side of
 * computeLocationBreakdown, NOT the sum of computeTankVolumes: a canning or
 * kegging row credits its packaging-station tank, so summing every tank counts
 * the packaged beer a second time and inflates the denominator to roughly the
 * whole batch twice over.
 *
 * ── Why the in-tank volume is shrunk ─────────────────────────────────────────
 * Beer only leaves a fermenter by being packaged or lost, so counting it at its
 * CURRENT volume puts more bbl in the denominator than the batch will ever
 * yield — and every invoice cut while beer is still in tank is divided by a
 * number that is too big. That is not a rounding artefact that later invoices
 * correct: each invoice is computed once and never restated, so the shortfall on
 * the early ones is permanent and the batch's ingredient bill is never fully
 * recovered from anybody.
 *
 * Worked example — 20 bbl brewed, $1,000 of grain, a 10% packaging loss, shipped
 * as two 9 bbl loads. At its current volume the first invoice divides 9 by
 * (9 packaged + 10 in tank) = 19 and charges $473.68; the second divides by the
 * finished 18 and charges $500. The partner took every drop of the beer and paid
 * $973.68 of a $1,000 bill.
 *
 * So the in-tank volume is multiplied by the expected packaging yield — the
 * `deposit_packaging_yield_pct` setting — before it joins the denominator. With
 * a 90% factor the first invoice divides by (9 + 10 × 0.9) = 18, the same figure
 * the finished batch produces, and the two invoices sum to the whole bill.
 *
 * The factor is a setting rather than a constant because it is a house rule
 * about this brewery's losses. Which way to err is NOT obvious, so state it: the
 * factor is in the DENOMINATOR, so a HIGHER factor makes a bigger denominator
 * and a SMALLER charge. Setting it at or a touch above the brewery's true yield
 * keeps the deposit erring low. Setting it below the true yield shrinks the
 * denominator past the batch's real yield and bills the partner for grain that
 * was never theirs — under-charging is recoverable, that is not.
 *
 * 100 is therefore the safest possible value and also the old behaviour, with
 * the full leak intact. The point is to sit just above the real yield, not at
 * either extreme.
 *
 * The dollar math is deliberately delegated to calculateIngredientDeposit, the
 * same function the allocation deposit uses, so the two can never drift.
 *
 * ── Beer that was converted, not brewed ──────────────────────────────────────
 * A conversion recipe's bill is COMPLETE: Transfusion Pilsner lists the
 * Pilsner's grain, the Mule's ginger and lime, and its own grape juice. Priced
 * whole, the deposit charges the partner for malt that was bought and charged
 * once already, against the batch the liquid was drawn off.
 *
 * So each shipped batch also reports its recipe's lineage — every recipe it
 * converts from, nearest base first — and the operator says which of them the
 * partner has already covered. Excluding those nets their bills out, leaving
 * the additions the conversion genuinely bought. It is a choice rather than a
 * default because only the operator knows whether the base was billed to this
 * partner or to somebody else.
 */
export interface ShippedDepositLine {
  batchId: string;
  batchNumber: string | null;
  beerName: string;
  /** bbl on the selected transactions from this batch. */
  shippedBbl: number;
  /** bbl the batch has packaged so far. */
  packagedBbl: number;
  /** bbl still unpackaged — in backlog, brewhouse, fermenter or brite. */
  inTankBbl: number;
  /** The expected packaging yield applied to `inTankBbl`, as a percentage. */
  packagingYieldPct: number;
  /** inTankBbl × packagingYieldPct — what that beer is expected to package out at. */
  expectedFromTankBbl: number;
  /** packagedBbl + expectedFromTankBbl — the projected yield, and the denominator. */
  projectedYieldBbl: number;
  /** shippedBbl ÷ projectedYieldBbl, as a percentage. */
  percentage: number;
  depositCents: number;
  totalIngredientCostUsd: number;
  /**
   * Beer is still in tank, so part of the denominator is the expected yield of
   * that beer rather than a measured one. The final share moves only if the real
   * loss differs from `packagingYieldPct`.
   */
  packagingInProgress: boolean;
  /**
   * Converted-from recipes netted out of this line, nearest base first. Empty
   * on an ordinary full-bill deposit.
   */
  excludedRecipes: RecipeRef[];
  /**
   * Ingredient-by-ingredient derivation of `depositCents`, for the operator to
   * check before an invoice goes to a customer. `shareCents` sums EXACTLY to
   * `depositCents` — see `allocateShares`.
   */
  breakdown: DepositBreakdownLine[];
}

/** One ingredient's contribution to a shipped deposit. */
export interface DepositBreakdownLine {
  ingredientId: string;
  name: string;
  unit: string;
  costPerUnitUsd: number;
  /** What the whole batch's bill calls for, after any conversion exclusion. */
  batchQuantity: number;
  /** What that quantity costs across the whole batch. */
  batchCostUsd: number;
  /** This shipment's share of that cost, in cents. */
  shareCents: number;
}

/**
 * Split `totalCents` across `weights` so the parts sum to exactly `totalCents`.
 *
 * Largest-remainder: floor every share, then hand the leftover cents out to the
 * lines with the biggest fractional parts. Rounding each line independently
 * leaves a cent or two unaccounted for, and a breakdown whose column does not
 * add up to the charge is worse than no breakdown at all — it makes the operator
 * distrust a number that was right.
 *
 * Exported for unit testing.
 */
export function allocateShares(totalCents: number, weights: number[]): number[] {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (sum <= 0 || weights.length === 0) return weights.map(() => 0);

  const exact = weights.map((w) => (w / sum) * totalCents);
  const shares = exact.map((v) => Math.floor(v));
  let remainder = totalCents - shares.reduce((a, v) => a + v, 0);

  // Biggest fractional part first; ties fall to the earlier line so the result
  // is deterministic rather than dependent on sort stability.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) {
    shares[order[k].i] += 1;
  }
  return shares;
}

export interface RecipeRef {
  recipeId: string;
  beerName: string;
}

/**
 * The recipes a conversion-born batch's OWN deposit must not charge for.
 *
 * The house rule is that a conversion charges only the addition: the liquid a
 * conversion target was drawn off already contained the source recipe's bill —
 * and everything above it in the lineage chain — bought and deposit-billed
 * against the parent batch. So the default exclusion set for the allocation
 * deposit is the source's recipe plus its ancestors, the same subtraction the
 * shipped-deposit flow offers per shipment.
 *
 * Empty for a brewed batch, for a target with no recorded source, and for a
 * source whose recipe is not actually in the target's chain (a blend or one-off
 * experiment) — there the full bill stands, because nothing provably covers it.
 */
export async function conversionDepositExclusions(
  supabase: SupabaseClient,
  batchId: string,
): Promise<RecipeRef[]> {
  const { data: batchRow } = await supabase
    .from("brew_batches")
    .select("recipe_id, converted_from_batch_id")
    .eq("id", batchId)
    .maybeSingle();
  const batch = batchRow as { recipe_id: string | null; converted_from_batch_id: string | null } | null;
  if (!batch?.recipe_id || !batch.converted_from_batch_id) return [];

  const { data: sourceRow } = await supabase
    .from("brew_batches")
    .select("recipe_id")
    .eq("id", batch.converted_from_batch_id)
    .maybeSingle();
  const sourceRecipeId = (sourceRow as { recipe_id: string | null } | null)?.recipe_id ?? null;
  if (!sourceRecipeId || sourceRecipeId === batch.recipe_id) return [];

  const { data: recipeRows } = await supabase
    .from("recipes")
    .select("id, beer_name, base_recipe_id");
  const recipes = (recipeRows ?? []) as Array<{ id: string; beer_name: string | null; base_recipe_id: string | null }>;
  const baseById = baseMapOf(recipes);
  if (!isDerivedFrom(batch.recipe_id, sourceRecipeId, baseById)) return [];

  const nameById = new Map(recipes.map((r) => [r.id, String(r.beer_name ?? "").trim()]));
  return [sourceRecipeId, ...lineageAncestors(sourceRecipeId, baseById)].map((id) => ({
    recipeId: id,
    beerName: nameById.get(id) || "Unknown recipe",
  }));
}

/**
 * One shipped batch whose recipe is made by converting another — and therefore
 * the only batches where excluding a base is a meaningful thing to ask for.
 *
 * `ancestors` is the whole chain, nearest base first: for Transfusion Pilsner
 * that is [Carolina Mule, Pace Yourself Pilsner]. Any subset may be excluded;
 * because the bills nest, excluding the Mule implies the Pilsner's grain is
 * gone too, so the two useful answers are "just the Pilsner" and "both".
 */
export interface ConversionDepositOption {
  batchId: string;
  batchNumber: string | null;
  beerName: string;
  recipeId: string;
  ancestors: RecipeRef[];
}

export interface ShippedDepositResult {
  lines: ShippedDepositLine[];
  warnings: string[];
  /** Per-batch conversion lineage, for the caller to offer as exclusions. */
  conversionOptions: ConversionDepositOption[];
}

type DepositTxRow = {
  batch_id: string | null;
  volume_bbl: number | null;
};

/** batch id → the recipes whose ingredients this deposit must not charge for. */
export type DepositExclusions = ReadonlyMap<string, readonly string[]>;

/**
 * Expected packaging yield when the setting has never been written — 90%, i.e.
 * a 10% loss between the fermenter and the package. A brewery that reliably
 * loses more than that should RAISE this number, not lower it: the factor is a
 * denominator, so a value above the true yield errs low and a value below it
 * overcharges.
 */
export const DEFAULT_PACKAGING_YIELD_PCT = 90;

/**
 * The house rule for how much of the beer still in tank will survive packaging.
 *
 * A missing row, an out-of-range value or a failed read all fall back to the
 * default rather than throwing: a deposit that cannot be computed at all is
 * worse than one computed on the standard assumption, and the invoice line says
 * which factor it used either way.
 */
export async function loadPackagingYieldPct(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", "deposit_packaging_yield_pct")
    .maybeSingle();
  if (error || !data) return DEFAULT_PACKAGING_YIELD_PCT;
  const pct = Number(data.value);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return DEFAULT_PACKAGING_YIELD_PCT;
  return pct;
}

export async function calculateShippedIngredientDeposits(
  supabase: SupabaseClient,
  transactionIds: string[],
  exclusions: DepositExclusions = new Map(),
): Promise<ShippedDepositResult> {
  if (transactionIds.length === 0) {
    throw new Error("At least one export transaction must be selected");
  }

  const { data: txs, error: txErr } = await supabase
    .from("export_transactions")
    .select("batch_id, volume_bbl")
    .in("id", transactionIds);
  if (txErr) throw new Error(txErr.message);

  const warnings: string[] = [];

  // The house packaging-yield rule, applied to every batch on this invoice.
  const packagingYieldPct = await loadPackagingYieldPct(supabase);

  // One deposit line per batch: two shipments off the same batch are one share
  // of one ingredient bill, not two.
  const bblByBatch = new Map<string, number>();
  let batchlessBbl = 0;
  for (const tx of (txs ?? []) as DepositTxRow[]) {
    const bbl = Number(tx.volume_bbl ?? 0);
    if (bbl <= 0) continue;
    if (!tx.batch_id) {
      batchlessBbl += bbl;
      continue;
    }
    bblByBatch.set(tx.batch_id, round4((bblByBatch.get(tx.batch_id) ?? 0) + bbl));
  }
  if (batchlessBbl > 0) {
    warnings.push(
      `${batchlessBbl.toFixed(2)} bbl on this invoice has no batch behind it, so no ingredient cost could be attributed to it.`,
    );
  }

  // Tank id → type, so the ledger can tell "still in a fermenter" apart from
  // "already through the canning line".
  const { data: equipment, error: eqErr } = await supabase.from("equipment").select("id, type");
  if (eqErr) throw new Error(eqErr.message);
  const tankTypeById: Record<string, string> = {};
  for (const e of equipment ?? []) tankTypeById[e.id as string] = e.type as string;

  // The whole recipes table — a few dozen rows — so the pure lineage walkers can
  // answer "what does this convert from?" without a recursive query. Same
  // approach conversionIngredients takes, for the same reason.
  const { data: recipeRows, error: recipeErr } = await supabase
    .from("recipes")
    .select("id, beer_name, base_recipe_id");
  if (recipeErr) throw new Error(recipeErr.message);
  const recipes = (recipeRows ?? []) as Array<{ id: string; beer_name: string | null; base_recipe_id: string | null }>;
  const baseById = baseMapOf(recipes);
  const recipeNameById = new Map(recipes.map((r) => [r.id, String(r.beer_name ?? "").trim()]));
  const recipeRef = (id: string): RecipeRef => ({ recipeId: id, beerName: recipeNameById.get(id) || "Unknown recipe" });

  const lines: ShippedDepositLine[] = [];
  const conversionOptions: ConversionDepositOption[] = [];

  for (const [batchId, shippedBbl] of bblByBatch) {
    const { data: batch, error: batchErr } = await supabase
      .from("brew_batches")
      .select("id, beer_name, batch_number, volume_bbl, recipe_id")
      .eq("id", batchId)
      .single();
    if (batchErr || !batch) {
      warnings.push(`Batch ${batchId} could not be loaded — no deposit charged for its ${shippedBbl.toFixed(2)} bbl.`);
      continue;
    }
    const beerName = String(batch.beer_name ?? "").trim();
    const label = batch.batch_number ? `${beerName} (${batch.batch_number})` : beerName;

    // ── What this batch could be converted from, and what the caller excluded ──
    const recipeId = (batch.recipe_id as string | null) ?? null;
    const ancestorIds = recipeId ? lineageAncestors(recipeId, baseById) : [];
    if (recipeId && ancestorIds.length > 0) {
      conversionOptions.push({
        batchId,
        batchNumber: batch.batch_number ?? null,
        beerName,
        recipeId,
        ancestors: ancestorIds.map(recipeRef),
      });
    }

    // Only a real ancestor can be excluded. Anything else — a stale id, a
    // recipe from a different beer — is dropped with a warning rather than
    // quietly reducing the bill by an amount nobody can account for.
    const requested = [...new Set(exclusions.get(batchId) ?? [])];
    const excludeIds = requested.filter((id) => ancestorIds.includes(id));
    for (const id of requested) {
      if (!excludeIds.includes(id)) {
        warnings.push(
          `${label} is not converted from ${recipeNameById.get(id) || id}, so that recipe's ingredients were left in its deposit.`,
        );
      }
    }

    // The batch's whole ledger: its own rows plus any sibling conversion row
    // that handed volume into its tanks. computeTankVolumes needs both.
    const { data: transfers, error: trErr } = await supabase
      .from("batch_transfers")
      .select("batch_id, from_tank_id, to_tank_id, to_batch_id, volume_bbl, shrinkage_bbl, transferred_at, transfer_type")
      .or(`batch_id.eq.${batchId},to_batch_id.eq.${batchId}`);
    if (trErr) throw new Error(trErr.message);
    const ledger = (transfers ?? []) as Array<LedgerTransfer & { transfer_type: string }>;

    if (ledger.length === 0) {
      warnings.push(
        `${label} has no transfers recorded, so its yield is unknown and this shipment's share of the ` +
        `ingredient bill can't be computed — no deposit charged for its ${shippedBbl.toFixed(2)} bbl.`,
      );
      continue;
    }

    // Packaged so far. 'brewing' and 'transfer' are tank movements and
    // 'conversion' re-labels beer already counted — only these two are packaging.
    const packagedBbl = round4(
      ledger
        .filter((t) => t.batch_id === batchId && (t.transfer_type === "canning" || t.transfer_type === "kegging"))
        .reduce((sum, t) => sum + Number(t.volume_bbl ?? 0), 0),
    );

    // Still unpackaged — beer that will be packaged, and whose share of the bill
    // therefore still belongs in the denominator. Excludes the packaging
    // stations, cold storage and the export bay: that beer is already counted
    // in packagedBbl.
    const nominalBbl = Number(batch.volume_bbl ?? 0);
    const where = computeLocationBreakdown(batchId, nominalBbl, ledger, tankTypeById, true);
    const inTankBbl = round4(where.backlog + where.brewhouse + where.fermenter + where.brite);

    // That beer has its packaging loss ahead of it, so it joins the denominator
    // at what it is expected to yield, not at what is in the tank today.
    const expectedFromTankBbl = round4(inTankBbl * (packagingYieldPct / 100));

    const projectedYieldBbl = round4(packagedBbl + expectedFromTankBbl);
    if (projectedYieldBbl <= 0) {
      warnings.push(
        `${label} has no packaged volume and nothing left in tank, so there is nothing to divide its ingredient bill by — no deposit charged for its ${shippedBbl.toFixed(2)} bbl.`,
      );
      continue;
    }
    if (shippedBbl > projectedYieldBbl) {
      warnings.push(
        `${label} shipped ${shippedBbl.toFixed(2)} bbl but only yields ${projectedYieldBbl.toFixed(2)} bbl ` +
        `(${packagedBbl.toFixed(2)} packaged, ${inTankBbl.toFixed(2)} in tank at ${packagingYieldPct}% expected yield). The deposit would exceed the ` +
        `whole ingredient bill — reconcile the batch before charging it.`,
      );
      continue;
    }

    const percentage = (shippedBbl / projectedYieldBbl) * 100;
    // Same function the allocation deposit uses — one formula, two entry points.
    const calc = await calculateIngredientDeposit(supabase, batchId, percentage, {
      excludeRecipeIds: excludeIds,
    });
    if (calc.deposit_cents === 0) {
      warnings.push(
        excludeIds.length > 0
          ? `${label} adds nothing priced on top of ${excludeIds.map((id) => recipeNameById.get(id) || id).join(" and ")}, ` +
            `so a conversion-only deposit computes to $0 — set the addition's ingredient costs before charging it.`
          : `${label} has no priced ingredients, so its deposit computes to $0 — set ingredient costs before charging it.`,
      );
      continue;
    }

    // Part of the denominator is an expectation rather than a measurement. Say
    // so, and say which factor produced it — someone reconciling later needs to
    // know the number rests on the house yield rule, not on the ledger.
    const packagingInProgress = inTankBbl > 0.01;
    if (packagingInProgress) {
      warnings.push(
        `${label} still has ${inTankBbl.toFixed(2)} bbl in tank, counted at the house ${packagingYieldPct}% ` +
        `packaging yield as ${expectedFromTankBbl.toFixed(2)} bbl, so its yield is projected at ` +
        `${projectedYieldBbl.toFixed(2)} bbl. The final share moves only if that beer packages out ` +
        `differently than expected.`,
      );
    }

    // Per-ingredient derivation. `quantity_per_bbl` is a rate over the turn's own
    // volume, so multiplying by the batch's nominal volume returns the quantity
    // the bill actually calls for (quantity_per_turn × turns) — the figure a
    // brewer would recognise off the recipe card.
    const shares = allocateShares(calc.deposit_cents, calc.breakdown.map((b) => b.line_total_usd));
    const breakdown: DepositBreakdownLine[] = calc.breakdown.map((b, i) => ({
      ingredientId:   b.ingredient_id,
      name:           b.name,
      unit:           b.unit,
      costPerUnitUsd: b.cost_per_unit_usd,
      batchQuantity:  b.quantity_per_bbl * nominalBbl,
      batchCostUsd:   b.line_total_usd,
      shareCents:     shares[i],
    }));

    lines.push({
      batchId,
      batchNumber: batch.batch_number ?? null,
      beerName,
      shippedBbl,
      packagedBbl,
      inTankBbl,
      packagingYieldPct,
      expectedFromTankBbl,
      projectedYieldBbl,
      percentage,
      depositCents: calc.deposit_cents,
      totalIngredientCostUsd: calc.total_ingredient_cost_usd,
      packagingInProgress,
      excludedRecipes: excludeIds.map(recipeRef),
      breakdown,
    });
  }

  return { lines, warnings, conversionOptions };
}

/**
 * The invoice line's description. Square shows the catalog item's own name and
 * files this as the line's note, so it is where the derivation has to live — a
 * bare "Ingredient Deposit" leaves nobody able to check the number a year later.
 */
export function shippedDepositDescription(line: ShippedDepositLine): string {
  const basis = line.packagingInProgress
    ? `${line.projectedYieldBbl.toFixed(2)} bbl projected yield (in-tank beer at ${line.packagingYieldPct}%)`
    : `${line.projectedYieldBbl.toFixed(2)} bbl packaged`;
  // A conversion-only deposit is a smaller number than the beer's name would
  // lead anyone to expect, so the line has to say which bill it is a share of.
  const scope = line.excludedRecipes.length
    ? `, conversion additions only (excludes ${line.excludedRecipes.map((r) => r.beerName).join(", ")})`
    : "";
  return (
    `Ingredient Deposit — ${line.beerName}: ${line.shippedBbl.toFixed(2)} bbl of the ` +
    `${basis} (${line.percentage.toFixed(2)}%)${scope}`
  );
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
