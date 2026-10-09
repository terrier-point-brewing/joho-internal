import type { SupabaseClient } from "@supabase/supabase-js";
import { recheckCommitmentFulfillment } from "./commitmentFulfillment";
import { loadBatchYields, shareBasisBbl } from "./batchYieldProjection.server";

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
 *   Δpct     = bbl ÷ basis × 100      basis = what the batch makes: packaged
 *                                     once complete, projected while in tank
 *                                     (lib/production/batchYieldProjection.server),
 *                                     planned before anything is measured
 *   source   −Δpct   (unless the source is the unallocated remainder)
 *   target   +Δpct
 *   booking  +bbl    (the commitment's volume_bbl, so owed's cap rises with it;
 *                     from the target's own share it only catches up to
 *                     credited + bbl, so it never invents volume)
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
  /**
   * The yield every share here is a percentage of: produced once the batch is
   * complete, else produced plus the in-tank volume at the expected packaging
   * yield. Shares are of what the batch WILL make — we package for one
   * partner at a time, so "packaged so far" says nothing about whose it is.
   */
  yieldBbl: number;
  plannedBbl: number;
  /** 100 − Σ allocation percentages, as bbl of the basis. */
  unallocatedBbl: number;
  /**
   * bbl the target has already been credited beyond its share. A batch that
   * finishes below its estimate shrinks every share after the beer has left
   * (B-056 lost 3.0 bbl at its last kegging: Argus held 22.82 bbl of share
   * against 24.39 shipped). The next shipment has to make this good as well,
   * or that much of it lands outside the deal.
   */
  targetShortBbl: number;
  sources: HomeSource[];
}

/**
 * bbl of a batch reserved for conversions that have not happened yet. An
 * executed conversion has already left the tank, so it is in no yield and
 * takes no share; counting it hid 4.2 bbl of B-056's free share.
 */
export function pendingConversionBbl(conversions: Array<{ volume_bbl: number | string | null; converted_at: string | null }>): number {
  return conversions.filter((c) => !c.converted_at).reduce((s, c) => s + Number(c.volume_bbl ?? 0), 0);
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
  /** What the batch makes (HomesForBatch.yieldBbl); 0 before anything is measured. */
  yieldBbl: number;
  plannedBbl: number;
  targetPct: number;
  source: HomeSource;
}): RehomePlan {
  const bbl = Number(input.bbl);
  if (!(bbl > EPS)) throw new Error("Nothing to move.");
  const basisBbl = input.yieldBbl > EPS ? input.yieldBbl : input.plannedBbl;
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

export interface AutoHomeDraw {
  source: { kind: "unallocated" } | { kind: "allocation"; allocationId: string };
  /** What the brewer is told the share came from. */
  label: string;
  bbl: number;
  /** The part of `bbl` that raises the booking; the rest only restores share already shipped against. */
  bookBbl: number;
}

/**
 * Where beer beyond a booking takes its share from when nobody has to be
 * asked: the commitment's own unshipped share first (nothing moves, the
 * booking catches up), then the batch's unallocated remainder, then the
 * taproom. Those are ours to give. Null when they cannot cover it between
 * them — what is left is another partner's share, and that is a decision
 * (and possibly a refund) a person makes.
 */
export function planAutoHome(
  sources: HomeSource[],
  bbl: number,
  /** What this same shipment already credits to the target: that much of its free share is spoken for. */
  creditedToTargetBbl = 0,
  /** Share the target is already short of (HomesForBatch.targetShortBbl): drawn first, never booked. */
  shortBbl = 0,
): AutoHomeDraw[] | null {
  const ours = [
    ...sources.filter((s) => s.kind === "self"),
    ...sources.filter((s) => s.kind === "unallocated"),
    ...sources.filter((s) => s.kind === "allocation" && s.channel === "taproom"),
  ];
  const draws: AutoHomeDraw[] = [];
  let left = bbl + shortBbl;
  let shortLeft = shortBbl;
  for (const s of ours) {
    if (left <= EPS) break;
    const take = Math.min(left, s.kind === "self" ? s.freeBbl - creditedToTargetBbl : s.freeBbl);
    if (take <= EPS) continue;
    draws.push({
      source: s.kind === "unallocated" || !s.allocationId ? { kind: "unallocated" } : { kind: "allocation", allocationId: s.allocationId },
      label: s.kind === "self" ? "their own unshipped share" : s.kind === "unallocated" ? "the unallocated share" : "the taproom",
      bbl: Math.round(take * 10000) / 10000,
      bookBbl: Math.round(Math.max(0, take - shortLeft) * 10000) / 10000,
    });
    shortLeft = Math.max(0, shortLeft - take);
    left -= take;
  }
  // freeBbl is rounded to the cent; a hair short is not a reason to ask.
  if (left > 0.01) return null;
  if (left > EPS && draws.length > 0) {
    const last = draws[draws.length - 1];
    last.bbl = Math.round((last.bbl + left) * 10000) / 10000;
    last.bookBbl = Math.round((last.bookBbl + left) * 10000) / 10000;
  }
  return draws.length > 0 ? draws : null;
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
  const [{ data: batch }, { data: allocs }, yields, { data: exports_ }, { data: conversions }] = await Promise.all([
    supabase.from("brew_batches").select("id, batch_number, volume_bbl").eq("id", batchId).maybeSingle(),
    supabase.from("batch_allocations")
      .select("id, batch_id, channel, partner_id, contract_request_id, percentage, invoice_paid_at, invoice_generated_at, invoice_sent_at, written_off_at, contract_brewing_partners(company_name)")
      .eq("batch_id", batchId),
    loadBatchYields(supabase, [batchId]),
    supabase.from("export_transactions").select("allocation_id, volume_bbl").eq("batch_id", batchId).not("allocation_id", "is", null),
    supabase.from("batch_conversions").select("volume_bbl, converted_at").eq("source_batch_id", batchId),
  ]);
  const producedBbl = yields.get(batchId)?.producedBbl ?? 0;
  const yieldBbl = shareBasisBbl(yields, batchId);
  const plannedBbl = Number((batch as { volume_bbl?: number | null } | null)?.volume_bbl ?? 0);
  const basisBbl = yieldBbl > EPS ? yieldBbl : plannedBbl;
  const exportedByAlloc = new Map<string, number>();
  for (const e of exports_ ?? []) {
    const id = e.allocation_id as string;
    exportedByAlloc.set(id, (exportedByAlloc.get(id) ?? 0) + Number(e.volume_bbl ?? 0));
  }
  // A written-off allocation still holds its share of the batch (its beer
  // shipped or was forgiven); it just cannot give any up. Count it in the
  // total, never list it as a source.
  const allRows = (allocs ?? []) as unknown as AllocRow[];
  const rows = allRows.filter((a) => !a.written_off_at);
  // Liquid planned for conversion into another beer is spoken for (that batch
  // has its own allocations); it is never free share here.
  const convertedPct = basisBbl > EPS
    ? pendingConversionBbl((conversions ?? []) as Array<{ volume_bbl: number | null; converted_at: string | null }>) / basisBbl * 100
    : 0;
  const totalPct = allRows.reduce((s, a) => s + Number(a.percentage), 0) + convertedPct;
  const unallocatedBbl = round2(Math.max(0, (100 - totalPct) / 100) * basisBbl);

  let targetShortBbl = 0;
  const sources: HomeSource[] = [];
  if (unallocatedBbl > EPS) {
    sources.push({ kind: "unallocated", allocationId: null, channel: null, partnerName: null, percentage: round2(100 - totalPct), freeBbl: unallocatedBbl, requires: "none" });
  }
  for (const a of rows) {
    const partner = Array.isArray(a.contract_brewing_partners) ? a.contract_brewing_partners[0] : a.contract_brewing_partners;
    const share = (Number(a.percentage) / 100) * basisBbl;
    const freeBbl = round2(Math.max(0, share - (exportedByAlloc.get(a.id) ?? 0)));
    if (a.id === targetAllocationId) {
      targetShortBbl = Math.round(Math.max(0, (exportedByAlloc.get(a.id) ?? 0) - share) * 10000) / 10000;
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
    yieldBbl: round2(yieldBbl),
    plannedBbl: round2(plannedBbl),
    unallocatedBbl,
    targetShortBbl,
    sources,
  };
}

export interface RehomeArgs {
  targetAllocationId: string;
  source: { kind: "unallocated" } | { kind: "allocation"; allocationId: string };
  bbl: number;
  /** Already-shipped rows to credit to the target (over-delivery / ad-hoc). */
  transactionIds?: string[];
  /**
   * The bbl is about to ship over and above the booking, so the booking rises
   * by it even when the share is the target's own. Without this a "self" move
   * only catches the booking up to what is already credited — right for rows
   * that have shipped, short for beer that has not left yet.
   */
  beyondBooking?: boolean;
  /**
   * How much of `bbl` raises the booking, when not all of it. The rest only
   * restores share the target has already shipped against (targetShortBbl).
   */
  bookBbl?: number;
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
    bbl: args.bbl, yieldBbl: homes.yieldBbl, plannedBbl: homes.plannedBbl,
    targetPct: Number(target.percentage), source,
  });

  if (source.kind === "allocation" && source.allocationId) {
    const patch: Record<string, unknown> = { percentage: plan.sourceNewPct };
    // A drafted (unpaid) deposit on the source is now for the wrong share.
    if (source.requires === "regenerate_deposit") { patch.invoice_generated_at = null; patch.invoice_sent_at = null; }
    // A source given up entirely leaves the batch: the CHECK forbids a 0% row.
    // Only an internal plan may be emptied; a partner's would strand their deal.
    const emptied = (plan.sourceNewPct ?? 0) <= EPS;
    if (emptied && source.channel !== "taproom" && source.channel !== "safety_stock") {
      throw new Error(`That would take all of ${sourceLabel(source)}'s share. Pick another source, or change their commitment on Intake first.`);
    }
    const { error } = emptied
      ? await supabase.from("batch_allocations").delete().eq("id", source.allocationId)
      : await supabase.from("batch_allocations").update(patch).eq("id", source.allocationId);
    if (error) throw new Error(error.message);
    if (emptied) source.allocationId = null;
  }
  if (plan.deltaPct > 0) {
    const { error: tErr } = await supabase.from("batch_allocations").update({ percentage: plan.targetNewPct }).eq("id", target.id);
    if (tErr) throw new Error(tErr.message);
  }

  // Taking share from somewhere raises the booking by the bbl. From the
  // target's own share ("self") the booking only CATCHES UP: it becomes
  // max(current, already credited + bbl). Adding bbl blindly invented volume
  // (B-063 read 5.67 after a 0.50 self re-home of a row its 5.17 already
  // covered, #585); never raising it left a contract over-ship on an
  // over-yielding batch still over after the "home" was chosen, so the ship
  // route wrote an over-delivery row anyway.
  let bookedBbl: number | null = null;
  if (target.contract_request_id) {
    const current = Number((target.commitments as unknown as { volume_bbl?: number | null } | null)?.volume_bbl ?? 0);
    let next = round2(current + Number(args.bookBbl ?? args.bbl));
    if (source.kind === "self" && !args.beyondBooking) {
      const { data: credited } = await supabase
        .from("export_transactions").select("volume_bbl").eq("allocation_id", target.id);
      const creditedBbl = (credited ?? []).reduce((s, r) => s + Number(r.volume_bbl ?? 0), 0);
      next = round2(Math.max(current, creditedBbl + Number(args.bbl)));
    }
    if (Math.abs(next - current) > EPS) {
      const { error } = await supabase.from("commitments").update({ volume_bbl: next }).eq("id", target.contract_request_id);
      if (error) throw new Error(error.message);
      bookedBbl = next;
    }
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

export interface BookForShipmentArgs {
  partnerId: string;
  recipeId: string;
  batchId: string;
  /** The commitment's channel — contract (deposit-backed) or distribution. */
  channel: "contract_brewing" | "distribution";
  source: { kind: "unallocated" } | { kind: "allocation"; allocationId: string };
  bbl: number;
  notes?: string | null;
}

/**
 * A partner shipment with no commitment behind it books one on the spot: a
 * commitment for exactly what is leaving, and an allocation on the batch the
 * beer is drawn from whose share is taken from `source` — the same move a
 * re-home makes, from a target that holds nothing yet. Marked for review so
 * someone with Intake access confirms the price and terms afterwards.
 *
 * Validated before anything is written; a failure after the commitment insert
 * removes what this call created, so a refused shipment leaves no half-booked deal.
 */
export async function bookCommitmentForShipment(
  supabase: SupabaseClient,
  args: BookForShipmentArgs,
): Promise<{ commitmentId: string; allocationId: string; deltaPct: number }> {
  const bbl = round2(Number(args.bbl));
  const homes = await listHomes(supabase, { batchId: args.batchId, targetAllocationId: null });
  const wantedId = args.source.kind === "allocation" ? args.source.allocationId : null;
  const source = wantedId == null
    ? homes.sources.find((s) => s.kind === "unallocated")
    : homes.sources.find((s) => s.allocationId === wantedId);
  if (!source) throw new Error(args.source.kind === "unallocated" ? "This batch has no unallocated share." : "That source allocation is not on this batch.");
  const plan = planRehome({ bbl: args.bbl, yieldBbl: homes.yieldBbl, plannedBbl: homes.plannedBbl, targetPct: 0, source });
  // Emptying an internal plan (taproom, safety stock) removes it; emptying a
  // partner's allocation would strand their commitment, so that is refused.
  const emptiesSource = source.kind === "allocation" && (plan.sourceNewPct ?? 0) <= EPS;
  if (emptiesSource && source.channel !== "taproom" && source.channel !== "safety_stock") {
    throw new Error(`That would take all of ${sourceLabel(source)}'s share. Pick another source, or change their commitment on Intake first.`);
  }

  const { data: commitment, error: cErr } = await supabase
    .from("commitments")
    .insert({
      recipe_id: args.recipeId,
      partner_id: args.partnerId,
      volume_bbl: bbl,
      channel: args.channel,
      status: "open",
      notes: args.notes?.trim() || `Booked at the Export Bay when #${homes.batchNumber ?? "?"} shipped.`,
      review_needed_at: new Date().toISOString(),
      last_edited_on: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (cErr || !commitment) throw new Error(cErr?.message ?? "Could not create the commitment.");

  const undo = async () => { await supabase.from("commitments").delete().eq("id", commitment.id); };

  const { data: alloc, error: aErr } = await supabase
    .from("batch_allocations")
    .insert({
      batch_id: args.batchId,
      channel: args.channel,
      percentage: plan.targetNewPct,
      partner_id: args.partnerId,
      contract_request_id: commitment.id,
    })
    .select("id")
    .single();
  if (aErr || !alloc) { await undo(); throw new Error(aErr?.message ?? "Could not allocate the batch."); }

  if (source.kind === "allocation" && source.allocationId) {
    const patch: Record<string, unknown> = { percentage: plan.sourceNewPct };
    if (source.requires === "regenerate_deposit") { patch.invoice_generated_at = null; patch.invoice_sent_at = null; }
    // A source given up entirely leaves the batch: the CHECK forbids a 0% row.
    const { error } = emptiesSource
      ? await supabase.from("batch_allocations").delete().eq("id", source.allocationId)
      : await supabase.from("batch_allocations").update(patch).eq("id", source.allocationId);
    if (error) {
      await supabase.from("batch_allocations").delete().eq("id", alloc.id);
      await undo();
      throw new Error(error.message);
    }
    if (!emptiesSource) await recheckCommitmentFulfillment(supabase, source.allocationId);
  }

  return { commitmentId: commitment.id, allocationId: alloc.id, deltaPct: plan.deltaPct };
}
