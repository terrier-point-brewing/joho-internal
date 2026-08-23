import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateIngredientDeposit } from "@/lib/square/square-invoices";
import { computeLocationBreakdown, type LedgerTransfer } from "@/lib/production/volumeLedger";

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
 *     packaged so far  +  what is still unpackaged in its tanks
 *
 * "Unpackaged" is the backlog / brewhouse / fermenter / brite side of
 * computeLocationBreakdown, NOT the sum of computeTankVolumes: a canning or
 * kegging row credits its packaging-station tank, so summing every tank counts
 * the packaged beer a second time and inflates the denominator to roughly the
 * whole batch twice over.
 *
 * Beer only leaves a fermenter by being packaged or lost, so that sum can only
 * fall as packaging proceeds. The share it produces is therefore never too
 * high — it errs low while beer is still in tank and converges upward to the
 * true figure once the batch is off the line. Under-charging is recoverable;
 * billing a partner for grain that was never theirs is not.
 *
 * The dollar math is deliberately delegated to calculateIngredientDeposit, the
 * same function the allocation deposit uses, so the two can never drift.
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
  /** packagedBbl + inTankBbl — the batch's projected yield, and the denominator. */
  projectedYieldBbl: number;
  /** shippedBbl ÷ projectedYieldBbl, as a percentage. */
  percentage: number;
  depositCents: number;
  totalIngredientCostUsd: number;
  /**
   * Beer is still in tank, so the denominator will shrink (by that beer's
   * packaging loss) and the final share will be a little higher than this one.
   * The deposit is conservative, not wrong.
   */
  packagingInProgress: boolean;
}

export interface ShippedDepositResult {
  lines: ShippedDepositLine[];
  warnings: string[];
}

type DepositTxRow = {
  batch_id: string | null;
  volume_bbl: number | null;
};

export async function calculateShippedIngredientDeposits(
  supabase: SupabaseClient,
  transactionIds: string[],
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

  const lines: ShippedDepositLine[] = [];

  for (const [batchId, shippedBbl] of bblByBatch) {
    const { data: batch, error: batchErr } = await supabase
      .from("brew_batches")
      .select("id, beer_name, batch_number, volume_bbl")
      .eq("id", batchId)
      .single();
    if (batchErr || !batch) {
      warnings.push(`Batch ${batchId} could not be loaded — no deposit charged for its ${shippedBbl.toFixed(2)} bbl.`);
      continue;
    }
    const beerName = String(batch.beer_name ?? "").trim();
    const label = batch.batch_number ? `${beerName} (${batch.batch_number})` : beerName;

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

    const projectedYieldBbl = round4(packagedBbl + inTankBbl);
    if (projectedYieldBbl <= 0) {
      warnings.push(
        `${label} has no packaged volume and nothing left in tank, so there is nothing to divide its ingredient bill by — no deposit charged for its ${shippedBbl.toFixed(2)} bbl.`,
      );
      continue;
    }
    if (shippedBbl > projectedYieldBbl) {
      warnings.push(
        `${label} shipped ${shippedBbl.toFixed(2)} bbl but only yields ${projectedYieldBbl.toFixed(2)} bbl ` +
        `(${packagedBbl.toFixed(2)} packaged, ${inTankBbl.toFixed(2)} in tank). The deposit would exceed the ` +
        `whole ingredient bill — reconcile the batch before charging it.`,
      );
      continue;
    }

    const percentage = (shippedBbl / projectedYieldBbl) * 100;
    // Same function the allocation deposit uses — one formula, two entry points.
    const calc = await calculateIngredientDeposit(supabase, batchId, percentage);
    if (calc.deposit_cents === 0) {
      warnings.push(
        `${label} has no priced ingredients, so its deposit computes to $0 — set ingredient costs before charging it.`,
      );
      continue;
    }

    // Beer still in tank will lose a little to packaging, so the denominator
    // will end up smaller and the true share slightly larger. Say so — the
    // number is deliberately conservative, and someone reconciling later should
    // know which direction it can move.
    const packagingInProgress = inTankBbl > 0.01;
    if (packagingInProgress) {
      warnings.push(
        `${label} still has ${inTankBbl.toFixed(2)} bbl in tank, so its yield is projected at ` +
        `${projectedYieldBbl.toFixed(2)} bbl. This deposit errs low — the final share rises slightly ` +
        `once that beer is packaged and its loss is known.`,
      );
    }

    lines.push({
      batchId,
      batchNumber: batch.batch_number ?? null,
      beerName,
      shippedBbl,
      packagedBbl,
      inTankBbl,
      projectedYieldBbl,
      percentage,
      depositCents: calc.deposit_cents,
      totalIngredientCostUsd: calc.total_ingredient_cost_usd,
      packagingInProgress,
    });
  }

  return { lines, warnings };
}

/**
 * The invoice line's description. Square shows the catalog item's own name and
 * files this as the line's note, so it is where the derivation has to live — a
 * bare "Ingredient Deposit" leaves nobody able to check the number a year later.
 */
export function shippedDepositDescription(line: ShippedDepositLine): string {
  const basis = line.packagingInProgress
    ? `${line.projectedYieldBbl.toFixed(2)} bbl projected yield`
    : `${line.projectedYieldBbl.toFixed(2)} bbl packaged`;
  return (
    `Ingredient Deposit — ${line.beerName}: ${line.shippedBbl.toFixed(2)} bbl of the ` +
    `${basis} (${line.percentage.toFixed(2)}%)`
  );
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
