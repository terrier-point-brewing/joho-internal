import type { SupabaseClient } from "@supabase/supabase-js";
import { owedOfShare, type AllocationChannel } from "./allocationReserve";

/**
 * The allocation is the unit of record for "how much has this partner been
 * shipped". The shipment writer credits an `allocation_id` on every export row
 * it can attribute; anything it cannot (over-delivery, ad-hoc) carries null.
 *
 * Every reader used to throw that away and re-sum by batch + channel +
 * recipient, which folded over-delivery rows into whichever allocation shared
 * the key and could not tell a split commitment's two allocations apart —
 * B-027's distribution allocation "shipped" 14.34 bbl against 4.54 owed while
 * its contract allocation was written off 13 bbl. These helpers are the one
 * arithmetic every reader now shares.
 */

/** Exports are met within this many bbl (float dust between the two sums). */
export const DELIVERY_TOLERANCE_BBL = 0.01;

export interface ExportVolumeRow {
  allocation_id: string | null;
  volume_bbl: number | string | null;
}

/** Sum export volume per allocation. Rows with no allocation are ignored. */
export function sumExportedByAllocation(rows: ExportVolumeRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.allocation_id) continue;
    out.set(r.allocation_id, (out.get(r.allocation_id) ?? 0) + Number(r.volume_bbl ?? 0));
  }
  return out;
}

/**
 * What an allocation is owed out of what its batch has produced so far:
 * contract allocations cap at the booked volume (the partner bought N bbl, not
 * a share of the upside), soft channels are their produced share.
 */
export function owedBbl(input: {
  channel: string;
  percentage: number;
  producedBbl: number;
  bookedBbl: number | null;
}): number {
  const share = (Number(input.percentage) / 100) * input.producedBbl;
  return input.channel === "contract_brewing" ? owedOfShare(share, input.bookedBbl) : share;
}

export function isFullyDelivered(exportedBbl: number, owed: number): boolean {
  return owed > 0 && exportedBbl >= owed - DELIVERY_TOLERANCE_BBL;
}

export interface AllocationDelivery {
  allocationId: string;
  batchId: string;
  batchStatus: string;
  channel: AllocationChannel | string;
  percentage: number;
  contractRequestId: string | null;
  bookedBbl: number | null;
  producedBbl: number;
  exportedBbl: number;
  owedBbl: number;
  writtenOff: boolean;
}

/**
 * Load one allocation's delivery picture. Returns null when the allocation
 * does not exist. Produced = kegging + canning net fill (never minus shrinkage
 * — volume_bbl on those rows is already what went into containers).
 */
export async function loadAllocationDelivery(
  supabase: SupabaseClient,
  allocationId: string,
): Promise<AllocationDelivery | null> {
  const { data: allocation } = await supabase
    .from("batch_allocations")
    .select("id, batch_id, channel, percentage, contract_request_id, written_off_at, brew_batches(status), commitments(volume_bbl)")
    .eq("id", allocationId)
    .maybeSingle();
  if (!allocation) return null;

  const [{ data: transfers }, { data: exports_ }] = await Promise.all([
    supabase
      .from("batch_transfers")
      .select("volume_bbl")
      .eq("batch_id", allocation.batch_id)
      .in("transfer_type", ["kegging", "canning"]),
    supabase
      .from("export_transactions")
      .select("allocation_id, volume_bbl")
      .eq("allocation_id", allocationId),
  ]);

  const producedBbl = (transfers ?? []).reduce((s, t) => s + Number(t.volume_bbl ?? 0), 0);
  const exportedBbl = sumExportedByAllocation((exports_ ?? []) as ExportVolumeRow[]).get(allocationId) ?? 0;
  const booked = (allocation.commitments as unknown as { volume_bbl: number | null } | null)?.volume_bbl;
  const bookedBbl = allocation.channel === "contract_brewing" && booked != null ? Number(booked) : null;
  const batchStatus = (allocation.brew_batches as unknown as { status?: string } | null)?.status ?? "";

  return {
    allocationId: allocation.id,
    batchId: allocation.batch_id,
    batchStatus,
    channel: allocation.channel,
    percentage: Number(allocation.percentage),
    contractRequestId: allocation.contract_request_id ?? null,
    bookedBbl,
    producedBbl,
    exportedBbl,
    owedBbl: owedBbl({ channel: allocation.channel, percentage: Number(allocation.percentage), producedBbl, bookedBbl }),
    writtenOff: !!allocation.written_off_at,
  };
}
