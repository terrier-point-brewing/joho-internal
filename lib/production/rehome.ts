import type { SupabaseClient } from "@supabase/supabase-js";
import { recheckCommitmentFulfillment } from "./commitmentFulfillment";

/**
 * Giving beer a home.
 *
 * Every partner shipment must sit inside a commitment: that is what the
 * deposit, the crediting, the ledger and the warnings all hang off. Beer
 * that leaves beyond the partner's booking therefore has to TAKE its share
 * of the batch from somewhere before it ships — the batch's unallocated
 * remainder, the taproom or safety-stock plan, or another partner's
 * allocation whose deposit has not locked it. A paid allocation can only
 * give up share through the refund flow, so it is listed but refused here.
 *
 * Moving `bbl` from a source to the target means:
 *   Δpct     = bbl ÷ basis × 100      basis = produced (once packaged) else planned
 *   source   −Δpct   (unless the source is the unallocated remainder)
 *   target   +Δpct
 *   booking  +bbl    (the commitment's volume_bbl, so owed's cap rises with it)
 * and, when re-homing rows that already shipped, those rows are credited to
 * the target instead of standing as over-delivery.
 */

const EPS = 1e-4;
const round2 = (n: number) => Math.round(n * 100) / 100;

export type HomeRequires = "none" | "refund" | "regenerate_deposit";

export interface HomeSource {
  /** `self`: the target's own share already covers it — only the booking rises. */
  kind: "unallocated" | "allocation" | "self";
  allocationId: string | null;
  channel: string | null;
  partnerName: string | null;
  percentage: number;
  /** bbl this source can give up without shorting what it has already shipped. */
  freeBbl: number;
  /** What it takes to draw on this source. */
  requires: HomeRequires;
}

export interface HomesForBatch {
  batchId: string;
  batchNumber: string | null;
  producedBbl: number;
  plannedBbl: number;
  /** 100 − Σ allocation percentages, as bbl of the basis. */
  unallocatedBbl: number;
  sources: HomeSource[];
}

/** bbl ⇄ percentage of a batch. Exported for tests. */
export function bblToPct(bbl: number, basisBbl: number): number {
  if (basisBbl <= EPS) return 0;
  return Math.round((bbl / basisBbl) * 100 * 100) / 100;
}

export interface RehomePlan {
  deltaPct: number;
  basisBbl: number;
  sourceNewPct: number | null;
  targetNewPct: number;
}

/** Pure: validate and size the move. Throws with the reason a human can act on. */
export function planRehome(input: {
  bbl: number;
  producedBbl: number;
  plannedBbl: number;
  targetPct: number;
  source: HomeSource;
}): RehomePlan {
  const bbl = Number(input.bbl);
  if (!(bbl > EPS)) throw new Error("Nothing to move.");
  const basisBbl = input.producedBbl > EPS ? input.producedBbl : input.plannedBbl;
  if (basisBbl <= EPS) throw new Error("This batch has no volume to share out yet.");
  if (input.source.requires === "refund") {
    throw new Error(`${input.source.partnerName ?? "That partner"}'s deposit is paid, so their share is locked — refund part of it from Batch Log first, then re-home.`);
  }
  if (input.source.freeBbl + EPS < bbl) {
    throw new Error(`${sourceLabel(input.source)} can only give up ${round2(input.source.freeBbl)} bbl, not ${round2(bbl)}.`);
  }
  if (input.source.kind === "self") {
    return { deltaPct: 0, basisBbl, sourceNewPct: null, targetNewPct: input.targetPct };
  }
  const deltaPct = bblToPct(bbl, basisBbl);
  if (deltaPct <= 0) throw new Error("The move rounds to zero percent of the batch.");
  const targetNewPct = Math.round((input.targetPct + deltaPct) * 100) / 100;
  if (targetNewPct > 100 + EPS) throw new Error("That would put the allocation above 100% of the batch.");
  const sourceNewPct = input.source.kind === "allocation"
    ? Math.round((input.source.percentage - deltaPct) * 100) / 100
    : null;
  if (sourceNewPct != null && sourceNewPct < -EPS) throw new Error(`${sourceLabel(input.source)} does not hold ${deltaPct}% of the batch.`);
  return { deltaPct, basisBbl, sourceNewPct, targetNewPct };
}

export function sourceLabel(s: HomeSource): string {
  if (s.kind === "unallocated") return "The unallocated share";
  if (s.kind === "self") return "This commitment's own share";
  const who = s.partnerName ?? (s.channel === "taproom" ? "Taproom" : s.channel === "safety_stock" ? "Safety stock" : s.channel ?? "That allocation");
  return who;
}

interface AllocRow {
  id: string;
  batch_id: string;
  channel: string;
  partner_id: string | null;
  contract_request_id: string | null;
  percentage: number | string;
  invoice_paid_at: string | null;
  invoice_generated_at: string | null;
  invoice_sent_at: string | null;
  written_off_at: string | null;
  contract_brewing_partners: { company_name: string } | { company_name: string }[] | null;
}

/** Everything on one batch that could give up share to `targetAllocationId`. */
export async function listHomes(
  supabase: SupabaseClient,
  { batchId, targetAllocationId }: { batchId: string; targetAllocationId: string | null },
): Promise<HomesForBatch> {
  const [{ data: batch }, { data: allocs }, { data: transfers }, { data: exports_ }] = await Promise.all([
    supabase.from("brew_batches").select("id, batch_number, volume_bbl").eq("id", batchId).maybeSingle(),
    supabase.from("batch_allocations")
      .select("id, batch_id, channel, partner_id, contract_request_id, percentage, invoice_paid_at, invoice_generated_at, invoice_sent_at, written_off_at, contract_brewing_partners(company_name)")
      .eq("batch_id", batchId),
    supabase.from("batch_transfers").select("volume_bbl").eq("batch_id", batchId).in("transfer_type", ["kegging", "canning"]),
    supabase.from("export_transactions").select("allocation_id, volume_bbl").eq("batch_id", batchId).not("allocation_id", "is", null),
  ]);
  const producedBbl = (transfers ?? []).reduce((s, t) => s + Number(t.volume_bbl ?? 0), 0);
  const plannedBbl = Number((batch as { volume_bbl?: number | null } | null)?.volume_bbl ?? 0);
  const basisBbl = producedBbl > EPS ? producedBbl : plannedBbl;
  const exportedByAlloc = new Map<string, number>();
  for (const e of exports_ ?? []) {
    const id = e.allocation_id as string;
    exportedByAlloc.set(id, (exportedByAlloc.get(id) ?? 0) + Number(e.volume_bbl ?? 0));
  }
  const rows = ((allocs ?? []) as unknown as AllocRow[]).filter((a) => !a.written_off_at);
  const totalPct = rows.reduce((s, a) => s + Number(a.percentage), 0);
  const unallocatedBbl = round2(Math.max(0, (100 - totalPct) / 100) * basisBbl);

  const sources: HomeSource[] = [];
  if (unallocatedBbl > EPS) {
    sources.push({ kind: "unallocated", allocationId: null, channel: null, partnerName: null, percentage: round2(100 - totalPct), freeBbl: unallocatedBbl, requires: "none" });
  }
  for (const a of rows) {
    const partner = Array.isArray(a.contract_brewing_partners) ? a.contract_brewing_partners[0] : a.contract_brewing_partners;
    const share = (Number(a.percentage) / 100) * basisBbl;
    const freeBbl = round2(Math.max(0, share - (exportedByAlloc.get(a.id) ?? 0)));
    if (a.id === targetAllocationId) {
      // The target already holds unshipped share: nothing moves, the booking
      // just catches up with what it can deliver.
      if (freeBbl > EPS) {
        sources.unshift({ kind: "self", allocationId: a.id, channel: a.channel, partnerName: partner?.company_name ?? null, percentage: Number(a.percentage), freeBbl, requires: "none" });
      }
      continue;
    }
    const requires: HomeRequires = a.channel !== "contract_brewing" ? "none"
      : a.invoice_paid_at ? "refund"
      : (a.invoice_generated_at || a.invoice_sent_at) ? "regenerate_deposit"
      : "none";
    sources.push({
      kind: "allocation",
      allocationId: a.id,
      channel: a.channel,
      partnerName: partner?.company_name ?? null,
      percentage: Number(a.percentage),
      freeBbl,
      requires,
    });
  }
  // Free-est first; locked ones last.
  sources.sort((x, y) =>
    (x.kind === "self" ? -1 : 0) - (y.kind === "self" ? -1 : 0)
    || (x.requires === "refund" ? 1 : 0) - (y.requires === "refund" ? 1 : 0)
    || y.freeBbl - x.freeBbl);

  return {
    batchId,
    batchNumber: (batch as { batch_number?: string | null } | null)?.batch_number ?? null,
    producedBbl: round2(producedBbl),
    plannedBbl: round2(plannedBbl),
    unallocatedBbl,
    sources,
  };
}

export interface RehomeArgs {
  targetAllocationId: string;
  source: { kind: "unallocated" } | { kind: "allocation"; allocationId: string };
  bbl: number;
  /** Already-shipped rows to credit to the target (over-delivery / ad-hoc). */
  transactionIds?: string[];
}

export interface RehomeResult {
  deltaPct: number;
  targetNewPct: number;
  sourceNewPct: number | null;
  bookedBbl: number | null;
  rehomedRows: number;
}

/** Execute a move. Throws with a human-readable reason on any refusal. */
export async function executeRehome(supabase: SupabaseClient, args: RehomeArgs): Promise<RehomeResult> {
  const { data: target } = await supabase
    .from("batch_allocations")
    .select("id, batch_id, channel, partner_id, contract_request_id, percentage, written_off_at, commitments(volume_bbl)")
    .eq("id", args.targetAllocationId)
    .maybeSingle();
  if (!target) throw new Error("Target allocation not found.");
  if (target.written_off_at) throw new Error("That allocation was written off — reverse the write-off before giving it more beer.");

  const homes = await listHomes(supabase, { batchId: target.batch_id, targetAllocationId: target.id });
  const wantedId = args.source.kind === "allocation" ? args.source.allocationId : null;
  const source = wantedId == null
    ? homes.sources.find((s) => s.kind === "unallocated")
    : homes.sources.find((s) => s.allocationId === wantedId);
  if (!source) throw new Error(args.source.kind === "unallocated" ? "This batch has no unallocated share." : "That source allocation is not on this batch.");

  const plan = planRehome({
    bbl: args.bbl, producedBbl: homes.producedBbl, plannedBbl: homes.plannedBbl,
    targetPct: Number(target.percentage), source,
  });

  if (source.kind === "allocation" && source.allocationId) {
    const patch: Record<string, unknown> = { percentage: plan.sourceNewPct };
    // A drafted (unpaid) deposit on the source is now for the wrong share.
    if (source.requires === "regenerate_deposit") { patch.invoice_generated_at = null; patch.invoice_sent_at = null; }
    const { error } = await supabase.from("batch_allocations").update(patch).eq("id", source.allocationId);
    if (error) throw new Error(error.message);
  }
  if (plan.deltaPct > 0) {
    const { error: tErr } = await supabase.from("batch_allocations").update({ percentage: plan.targetNewPct }).eq("id", target.id);
    if (tErr) throw new Error(tErr.message);
  }

  let bookedBbl: number | null = null;
  if (target.contract_request_id) {
    const current = Number((target.commitments as unknown as { volume_bbl?: number | null } | null)?.volume_bbl ?? 0);
    bookedBbl = round2(current + Number(args.bbl));
    const { error } = await supabase.from("commitments").update({ volume_bbl: bookedBbl }).eq("id", target.contract_request_id);
    if (error) throw new Error(error.message);
  }

  let rehomedRows = 0;
  if (args.transactionIds && args.transactionIds.length > 0) {
    const { data, error } = await supabase
      .from("export_transactions")
      .update({ allocation_id: target.id, over_allocation: false, is_ad_hoc: false, channel: target.channel })
      .in("id", args.transactionIds)
      .eq("batch_id", target.batch_id)
      .is("allocation_id", null)
      .select("id");
    if (error) throw new Error(error.message);
    rehomedRows = data?.length ?? 0;
  }

  await recheckCommitmentFulfillment(supabase, target.id);
  if (source.kind === "allocation" && source.allocationId) await recheckCommitmentFulfillment(supabase, source.allocationId);

  return { deltaPct: plan.deltaPct, targetNewPct: plan.targetNewPct, sourceNewPct: plan.sourceNewPct, bookedBbl, rehomedRows };
}
