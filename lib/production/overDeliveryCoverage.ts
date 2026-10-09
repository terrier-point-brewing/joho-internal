import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { DELIVERY_TOLERANCE_BBL } from "./allocationDelivery";
import { loadBatchYields, shareBasisBbl } from "./batchYieldProjection.server";
import { loadDepositCharges } from "./depositCharges";

/**
 * How much of an over-delivery the partner's ingredient deposit already paid
 * for — the one rule behind "does this shipment owe an ingredient share?".
 *
 * A shipment is charged a share only for beer BEYOND what the deposit bought,
 * and what it bought depends on how it was collected:
 *
 *  - Paid up front: the partner paid their percentage of the batch's whole
 *    ingredient bill, so they are covered up to that percentage of what the
 *    batch actually yields. Shipment crediting stops at the BOOKED bbl
 *    (planShipment), which on a batch that out-yields its booking is short of
 *    the share — the rows past it are flagged over-delivery although their
 *    grain is already paid for. That gap is the cover computed here. Because
 *    the ceiling is a share of the real yield, shrinkage can never trigger a
 *    charge and no separate allowance is needed.
 *
 *  - Collected shipment by shipment (back-charged): the deposit paid for the
 *    barrels it was charged on and nothing more, so it lends no cover at all.
 *    Neither does a written-off or refunded deposit.
 *
 * Only over-delivery rows are ever reduced. A shipment credited to an unpaid
 * allocation owes its share in full, and an ad-hoc one is the operator's call.
 */
export interface OverDeliveryCoverage {
  /** Selected over-delivery bbl drawn from this batch. */
  overBbl: number;
  /** The part of it inside the share an up-front deposit paid for. */
  coveredBbl: number;
}

export interface OverDeliveryTxRow {
  id: string;
  batch_id: string | null;
  recipient_id: string | null;
  volume_bbl: number | string | null;
  allocation_id: string | null;
  over_allocation?: boolean | null;
}

/**
 * Pure. `paidShareBbl` is Σ percentage × yield across the partner's up-front
 * paid allocations on the batch; `creditedBbl` what has shipped against them;
 * `earlierOverBbl` over-delivery off the same batch outside this selection,
 * which used the headroom first. Exported for unit testing.
 */
export function coveredOverDeliveryBbl(input: {
  selectedOverBbl: number;
  paidShareBbl: number;
  creditedBbl: number;
  earlierOverBbl: number;
}): number {
  const headroom = Math.max(0, input.paidShareBbl - input.creditedBbl - input.earlierOverBbl);
  const covered = Math.min(input.selectedOverBbl, headroom);
  // Float dust between the two sums is not chargeable beer.
  return input.selectedOverBbl - covered <= DELIVERY_TOLERANCE_BBL ? input.selectedOverBbl : round4(covered);
}

const isOver = (r: OverDeliveryTxRow) => !r.allocation_id && r.over_allocation === true;

/** Per batch id; empty when the selection carries no over-delivery. */
export async function loadOverDeliveryCoverage(
  supabase: SupabaseClient,
  selected: OverDeliveryTxRow[],
): Promise<Map<string, OverDeliveryCoverage>> {
  const out = new Map<string, OverDeliveryCoverage>();
  const over = selected.filter((r) => isOver(r) && r.batch_id && r.recipient_id);
  if (over.length === 0) return out;

  const batchIds = [...new Set(over.map((r) => r.batch_id as string))];
  const partnerIds = [...new Set(over.map((r) => r.recipient_id as string))];
  const selectedIds = new Set(selected.map((r) => r.id));

  const [{ data: allocRows }, { data: exportRows }, yields] = await Promise.all([
    supabase
      .from("batch_allocations")
      .select("id, batch_id, partner_id, percentage, invoice_paid_at, written_off_at, deposit_backcharged_invoice_id, refund_amount_cents")
      .eq("channel", "contract_brewing")
      .in("batch_id", batchIds)
      .in("partner_id", partnerIds),
    supabase
      .from("export_transactions")
      .select("id, batch_id, recipient_id, volume_bbl, allocation_id, over_allocation")
      .in("batch_id", batchIds)
      .in("recipient_id", partnerIds),
    loadBatchYields(supabase, batchIds),
  ]);

  type AllocRow = {
    id: string; batch_id: string; partner_id: string | null; percentage: number | string;
    invoice_paid_at: string | null; written_off_at: string | null;
    deposit_backcharged_invoice_id: string | null; refund_amount_cents: number | null;
  };
  const settled = ((allocRows ?? []) as AllocRow[]).filter((a) =>
    a.invoice_paid_at && !a.written_off_at && !a.deposit_backcharged_invoice_id && !(Number(a.refund_amount_cents ?? 0) > 0));
  // The charges table is the other mark of a back-charge; it sits behind the
  // invoices RLS cluster, hence the admin client.
  const charges = await loadDepositCharges(createSupabaseAdminClient(), settled.map((a) => a.id));
  const upFront = settled.filter((a) => !((charges.get(a.id)?.chargedBbl ?? 0) > 0));

  const key = (batchId: string, partnerId: string) => `${batchId}|${partnerId}`;
  const paidShare = new Map<string, number>();
  const groupOfAllocation = new Map<string, string>();
  for (const a of upFront) {
    if (!a.partner_id) continue;
    const k = key(a.batch_id, a.partner_id);
    paidShare.set(k, (paidShare.get(k) ?? 0) + (Number(a.percentage) / 100) * shareBasisBbl(yields, a.batch_id));
    groupOfAllocation.set(a.id, k);
  }

  const credited = new Map<string, number>();
  const earlierOver = new Map<string, number>();
  for (const r of (exportRows ?? []) as OverDeliveryTxRow[]) {
    const bbl = Number(r.volume_bbl ?? 0);
    const creditedTo = r.allocation_id ? groupOfAllocation.get(r.allocation_id) : undefined;
    if (creditedTo) credited.set(creditedTo, (credited.get(creditedTo) ?? 0) + bbl);
    else if (isOver(r) && !selectedIds.has(r.id) && r.batch_id && r.recipient_id) {
      const k = key(r.batch_id, r.recipient_id);
      earlierOver.set(k, (earlierOver.get(k) ?? 0) + bbl);
    }
  }

  const selectedOver = new Map<string, number>();
  for (const r of over) {
    const k = key(r.batch_id as string, r.recipient_id as string);
    selectedOver.set(k, (selectedOver.get(k) ?? 0) + Number(r.volume_bbl ?? 0));
  }
  for (const [k, overBbl] of selectedOver) {
    const batchId = k.split("|")[0];
    const coveredBbl = coveredOverDeliveryBbl({
      selectedOverBbl: overBbl,
      paidShareBbl: paidShare.get(k) ?? 0,
      creditedBbl: credited.get(k) ?? 0,
      earlierOverBbl: earlierOver.get(k) ?? 0,
    });
    const prior = out.get(batchId) ?? { overBbl: 0, coveredBbl: 0 };
    out.set(batchId, { overBbl: round4(prior.overBbl + overBbl), coveredBbl: round4(prior.coveredBbl + coveredBbl) });
  }
  return out;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
