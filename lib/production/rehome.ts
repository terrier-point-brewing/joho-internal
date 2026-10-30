import type { SupabaseClient } from "@supabase/supabase-js";
import { recheckCommitmentFulfillment } from "./commitmentFulfillment";
import { loadBatchYields, shareBasisBbl } from "./batchYieldProjection.server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { issueDepositReduction, RefundError } from "@/lib/finance/issueRefund";
import { bblToPct, depositRefundCents } from "./rehomeMath";

export { bblToPct, depositRefundCents, refundCentsForDraw } from "./rehomeMath";

/**
 * Giving beer a home.
 *
 * Every partner shipment must sit inside a commitment: that is what the
 * deposit, the crediting, the ledger and the warnings all hang off. Beer
 * that leaves beyond the partner's booking therefore has to TAKE its share
 * of the batch from somewhere before it ships — the batch's unallocated
 * remainder, the taproom or safety-stock plan, or another partner's
 * allocation whose deposit has not locked it. A paid allocation gives up
 * share only against a refund of the matching slice of its deposit: the
 * caller must acknowledge that exact amount (`refund.acknowledgedCents`),
 * the refund is issued first, and only then does the share move. Without the
 * acknowledgement the source is listed but refused.
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
  /**
   * For a paid source: what was paid, and whether the app can refund it
   * itself (a Square payment id is on file). Paid before refund tracking
   * shipped means the refund happens in the Square Dashboard, then Batch Log.
   */
  deposit?: { paidCents: number; refundable: boolean } | null;
}


export interface HomesForBatch {
  batchId: string;
  batchNumber: string | null;
  beerName: string | null;
  turns: number | null;
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

export interface RehomePlan {
  deltaPct: number;
  basisBbl: number;
  sourceNewPct: number | null;
  targetNewPct: number;
  /** Cents refunded to the source partner for this draw; 0 unless the source's deposit is paid. */
  refundCents: number;
}

/** Pure: validate and size the move. Throws with the reason a human can act on. */
export function planRehome(input: {
  bbl: number;
  /** What the batch makes (HomesForBatch.yieldBbl); 0 before anything is measured. */
  yieldBbl: number;
  plannedBbl: number;
  targetPct: number;
  source: HomeSource;
  /** The cents the operator agreed to refund the source partner; required to draw on a paid share. */
  refund?: { acknowledgedCents: number } | null;
}): RehomePlan {
  const bbl = Number(input.bbl);
  if (!(bbl > EPS)) throw new Error("Nothing to move.");
  const basisBbl = input.yieldBbl > EPS ? input.yieldBbl : input.plannedBbl;
  if (basisBbl <= EPS) throw new Error("This batch has no volume to share out yet.");
  const who = input.source.partnerName ?? "That partner";
  if (input.source.requires === "refund") {
    if (!input.source.deposit?.refundable) {
      throw new Error(`${who}'s deposit was paid before refund tracking — refund it in the Square Dashboard, then reduce their share in Batch Log.`);
    }
    if (!input.refund) {
      throw new Error(`${who}'s deposit is paid, so their share is locked — confirm the refund of that slice of it to draw on it.`);
    }
  }
  if (input.source.freeBbl + EPS < bbl) {
    throw new Error(`${sourceLabel(input.source)} can only give up ${round2(input.source.freeBbl)} bbl, not ${round2(bbl)}.`);
  }
  if (input.source.kind === "self") {
    return { deltaPct: 0, basisBbl, sourceNewPct: null, targetNewPct: input.targetPct, refundCents: 0 };
  }
  const deltaPct = bblToPct(bbl, basisBbl);
  if (deltaPct <= 0) throw new Error("The move rounds to zero percent of the batch.");
  const targetNewPct = Math.round((input.targetPct + deltaPct) * 100) / 100;
  if (targetNewPct > 100 + EPS) throw new Error("That would put the allocation above 100% of the batch.");
  const sourceNewPct = input.source.kind === "allocation"
    ? Math.round((input.source.percentage - deltaPct) * 100) / 100
    : null;
  if (sourceNewPct != null && sourceNewPct < -EPS) throw new Error(`${sourceLabel(input.source)} does not hold ${deltaPct}% of the batch.`);
  // A paid partner's share is never emptied: that would strand their deal.
  if (input.source.requires === "refund" && (sourceNewPct ?? 0) <= EPS) {
    throw new Error(`That would take all of ${who}'s share. Pick another source, or change their commitment on Intake first.`);
  }
  const refundCents = input.source.requires === "refund" ? depositRefundCents(input.source, deltaPct) : 0;
  // The money is real: what the operator saw and agreed to must be what moves.
  if (refundCents > 0 && input.refund && input.refund.acknowledgedCents !== refundCents) {
    throw new Error(`The refund to ${who} is now $${(refundCents / 100).toFixed(2)}, not $${(input.refund.acknowledgedCents / 100).toFixed(2)} — the batch changed under you. Re-open the shipment and confirm again.`);
  }
  return { deltaPct, basisBbl, sourceNewPct, targetNewPct, refundCents };
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

/**
 * The deal's own share as it stands AFTER this shipment credits `creditedBbl`
 * to it: that much of its free share is spoken for, so neither the picker nor
 * the ship route may let the extra beer take it a second time.
 */
export function netOfCredited(sources: HomeSource[], creditedBbl: number): HomeSource[] {
  if (creditedBbl <= EPS) return sources;
  return sources.flatMap((s) => {
    if (s.kind !== "self") return [s];
    const freeBbl = round2(Math.max(0, s.freeBbl - creditedBbl));
    return freeBbl > EPS ? [{ ...s, freeBbl }] : [];
  });
}

/** What a paid deposit still holds: paid less every slice already refunded (`refund_amount_cents` is cumulative). */
export function depositRemainingCents(a: { deposit_amount_paid_cents: number | string | null; refund_amount_cents: number | string | null }): number {
  return Math.max(0, Number(a.deposit_amount_paid_cents ?? 0) - Number(a.refund_amount_cents ?? 0));
}

export interface AutoHomeSplit {
  /** Taken without asking: the partner's own unshipped share on the batch. */
  auto: AutoHomeDraw[];
  /** What that could not cover; a person picks it from `askSources`. 0 when nothing is left to ask. */
  askBbl: number;
  /** The sources open to the operator: unallocated, taproom, other partners. */
  askSources: HomeSource[];
  /** Short share still to restore after the auto draws; the operator's draws restore it before booking. */
  shortLeft: number;
}

/**
 * The partner's own unshipped share on the batch is taken as far as it goes
 * (nothing moves; the booking catches up with beer that is already theirs).
 * Everything else — the unallocated remainder, the taproom, another partner —
 * is a choice the operator makes, so only the remainder is asked about and
 * the picker lists every other source.
 */
export function splitAutoHome(sources: HomeSource[], bbl: number, shortBbl = 0): AutoHomeSplit {
  const isOurs = (s: HomeSource) => s.kind === "self";
  const ours = sources.filter(isOurs);
  const auto: AutoHomeDraw[] = [];
  let left = bbl + shortBbl;
  let shortLeft = shortBbl;
  for (const s of ours) {
    if (left <= EPS) break;
    const take = Math.min(left, s.freeBbl);
    if (take <= EPS) continue;
    auto.push({
      source: s.kind === "unallocated" || !s.allocationId ? { kind: "unallocated" } : { kind: "allocation", allocationId: s.allocationId },
      label: s.kind === "self" ? "their own unshipped share" : s.kind === "unallocated" ? "the unallocated share" : "the taproom",
      bbl: Math.round(take * 10000) / 10000,
      bookBbl: Math.round(Math.max(0, take - shortLeft) * 10000) / 10000,
    });
    shortLeft = Math.max(0, shortLeft - take);
    left -= take;
  }
  // freeBbl is rounded to the cent; a hair short is not a reason to ask.
  if (left > EPS && left <= 0.01 && auto.length > 0) {
    const last = auto[auto.length - 1];
    last.bbl = Math.round((last.bbl + left) * 10000) / 10000;
    last.bookBbl = Math.round((last.bookBbl + left) * 10000) / 10000;
    left = 0;
  }
  // askBbl is the beer beyond the booking still unhomed; the short left to restore rides separately.
  return { auto, askBbl: Math.round(Math.max(0, left - shortLeft) * 100) / 100, askSources: sources.filter((s) => !isOurs(s)), shortLeft: Math.round(shortLeft * 10000) / 10000 };
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
  square_payment_id: string | null;
  deposit_amount_paid_cents: number | string | null;
  refund_amount_cents: number | string | null;
  contract_brewing_partners: { company_name: string } | { company_name: string }[] | null;
}

/** Everything on one batch that could give up share to `targetAllocationId`. */
export async function listHomes(
  supabase: SupabaseClient,
  { batchId, targetAllocationId }: { batchId: string; targetAllocationId: string | null },
): Promise<HomesForBatch> {
  const [{ data: batch }, { data: allocs }, yields, { data: exports_ }, { data: conversions }] = await Promise.all([
    supabase.from("brew_batches").select("id, batch_number, beer_name, turns, volume_bbl").eq("id", batchId).maybeSingle(),
    supabase.from("batch_allocations")
      .select("id, batch_id, channel, partner_id, contract_request_id, percentage, invoice_paid_at, invoice_generated_at, invoice_sent_at, written_off_at, square_payment_id, deposit_amount_paid_cents, refund_amount_cents, contract_brewing_partners(company_name)")
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
      // What the deposit still holds: paid less what earlier reductions already
      // refunded. A second slice priced off the gross would over-refund, and
      // Square refuses a refund beyond what is left on the payment.
      deposit: requires === "refund"
        ? { paidCents: depositRemainingCents(a), refundable: !!a.square_payment_id && a.deposit_amount_paid_cents != null }
        : null,
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
    beerName: (batch as { beer_name?: string | null } | null)?.beer_name ?? null,
    turns: (batch as { turns?: number | null } | null)?.turns ?? null,
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
  /** Required to draw on a paid partner's share: the refund the operator confirmed, to the cent. */
  refund?: { acknowledgedCents: number } | null;
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
/**
 * Takes the plan's share off an allocation source. A paid source is refunded
 * FIRST — the slice of its deposit that leaves with the share — and the
 * reduction is written through the admin client the moment the money has
 * moved, exactly as Batch Log's "Refund part of deposit…" does; a failure
 * after that point leaves the (now honest) reduced share standing and says
 * so. Only an internal plan (taproom, safety stock) may be emptied.
 */
async function reduceSource(
  supabase: SupabaseClient,
  homes: HomesForBatch,
  source: HomeSource,
  plan: RehomePlan,
): Promise<{ emptied: boolean }> {
  if (source.kind !== "allocation" || !source.allocationId) return { emptied: false };
  const emptied = (plan.sourceNewPct ?? 0) <= EPS;
  if (emptied && source.channel !== "taproom" && source.channel !== "safety_stock") {
    throw new Error(`That would take all of ${sourceLabel(source)}'s share. Pick another source, or change their commitment on Intake first.`);
  }
  if (emptied) {
    const { error } = await supabase.from("batch_allocations").delete().eq("id", source.allocationId);
    if (error) throw new Error(error.message);
    return { emptied: true };
  }
  const patch: Record<string, unknown> = { percentage: plan.sourceNewPct };
  // A drafted (unpaid) deposit on the source is now for the wrong share.
  if (source.requires === "regenerate_deposit") { patch.invoice_generated_at = null; patch.invoice_sent_at = null; }
  if (source.requires === "refund" && plan.refundCents > 0) {
    const { data: a, error: aErr } = await supabase
      .from("batch_allocations")
      .select("square_payment_id, square_deposit_order_id, deposit_amount_paid_cents, refund_amount_cents, percentage")
      .eq("id", source.allocationId)
      .maybeSingle();
    if (aErr || !a?.square_payment_id || a.deposit_amount_paid_cents == null) {
      throw new Error(`${sourceLabel(source)} has no Square payment on file to refund against — refund it in the Square Dashboard, then reduce their share in Batch Log.`);
    }
    // `square_refunds` and the post-refund write go through the admin client: the
    // operator entitled to ship must not be able to move the money and then be
    // refused the row that records it (see the allocation adjust route).
    const admin = createSupabaseAdminClient();
    let refund;
    try {
      refund = await issueDepositReduction(admin, {
        allocationId: source.allocationId,
        currentPercentage: Number(a.percentage),
        newPercentage: plan.sourceNewPct ?? 0,
        paidCents: depositRemainingCents(a),
        squarePaymentId: a.square_payment_id,
        squareOrderId: a.square_deposit_order_id ?? null,
        batch: {
          batchNumber: homes.batchNumber ?? homes.batchId,
          turns: Number(homes.turns ?? 1),
          beerName: homes.beerName ?? "",
          projectedYieldBbl: homes.yieldBbl,
        },
      });
    } catch (e) {
      if (e instanceof RefundError) throw new Error(e.message);
      throw new Error(`Square refund to ${sourceLabel(source)} failed: ${e instanceof Error ? e.message : "unknown error"}. Nothing shipped.`);
    }
    const { error } = await admin.from("batch_allocations").update({
      ...patch,
      square_refund_id: refund.squareRefundId,
      // Cumulative: every slice refunded off this deposit so far.
      refund_amount_cents: Number(a.refund_amount_cents ?? 0) + refund.refundAmountCents,
      refunded_at: new Date().toISOString(),
    }).eq("id", source.allocationId);
    if (error) {
      throw new Error(`Refund of $${(refund.refundAmountCents / 100).toFixed(2)} to ${sourceLabel(source)} succeeded (id: ${refund.squareRefundId}) but saving their new ${plan.sourceNewPct}% failed: ${error.message}. Do NOT retry — set it by hand in Batch Log.`);
    }
    return { emptied: false };
  }
  const { error } = await supabase.from("batch_allocations").update(patch).eq("id", source.allocationId);
  if (error) throw new Error(error.message);
  return { emptied: false };
}

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
    targetPct: Number(target.percentage), source, refund: args.refund ?? null,
  });

  // A source given up entirely leaves the batch: the CHECK forbids a 0% row.
  const { emptied } = await reduceSource(supabase, homes, source, plan);
  if (emptied) source.allocationId = null;
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

export interface SourceDraw {
  source: { kind: "unallocated" } | { kind: "allocation"; allocationId: string };
  bbl: number;
  /** Required to draw on a paid partner's share: the refund the operator confirmed, to the cent. */
  refund?: { acknowledgedCents: number } | null;
}

export interface BookForShipmentArgs {
  partnerId: string;
  recipeId: string;
  batchId: string;
  /** The commitment's channel — contract (deposit-backed) or distribution. */
  channel: "contract_brewing" | "distribution";
  /** Where the share comes from, split across sources as the operator chose; sums to the booking. */
  draws: SourceDraw[];
  notes?: string | null;
}

/** Normalise a request body's `source`+`bbl`(+`refund_cents`) or `draws` list into SourceDraws. Throws on a malformed body. */
export function drawsFromBody(body: {
  source?: { kind?: string; allocation_id?: string } | null;
  bbl?: unknown;
  refund_cents?: unknown;
  draws?: unknown;
}, fallbackBbl?: number): SourceDraw[] {
  const one = (d: { source?: { kind?: string; allocation_id?: string } | null; bbl?: unknown; refund_cents?: unknown }, bbl: number): SourceDraw => {
    if (!d.source?.kind) throw new Error("Each draw needs a source.");
    if (d.source.kind !== "unallocated" && !d.source.allocation_id) throw new Error("source.allocation_id is required for an allocation source");
    if (!(bbl > 0)) throw new Error("Each draw needs a positive bbl.");
    const cents = Number(d.refund_cents);
    return {
      source: d.source.kind === "unallocated" ? { kind: "unallocated" } : { kind: "allocation", allocationId: d.source.allocation_id as string },
      bbl,
      refund: Number.isFinite(cents) && cents > 0 ? { acknowledgedCents: Math.round(cents) } : null,
    };
  };
  if (Array.isArray(body.draws)) {
    const draws = (body.draws as Array<{ source?: { kind?: string; allocation_id?: string } | null; bbl?: unknown; refund_cents?: unknown }>)
      .map((d) => one(d, Number(d.bbl)));
    const keys = draws.map((d) => (d.source.kind === "unallocated" ? "unallocated" : d.source.allocationId));
    if (new Set(keys).size !== keys.length) throw new Error("The same source is listed twice.");
    if (draws.length === 0) throw new Error("Choose where the share comes from.");
    return draws;
  }
  return [one(body, Number(body.bbl ?? fallbackBbl))];
}

const drawTotal = (draws: SourceDraw[]) => round2(draws.reduce((s, d) => s + Number(d.bbl), 0));

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
  const bbl = drawTotal(args.draws);
  const homes = await listHomes(supabase, { batchId: args.batchId, targetAllocationId: null });
  // Every draw is planned before anything is written: the new allocation's
  // percentage accumulates across them, and one bad draw refuses the lot.
  const steps: Array<{ source: HomeSource; plan: RehomePlan; empties: boolean }> = [];
  let targetPct = 0;
  for (const d of args.draws) {
    const wantedId = d.source.kind === "allocation" ? d.source.allocationId : null;
    const source = wantedId == null
      ? homes.sources.find((s) => s.kind === "unallocated")
      : homes.sources.find((s) => s.allocationId === wantedId);
    if (!source) throw new Error(d.source.kind === "unallocated" ? "This batch has no unallocated share." : "That source allocation is not on this batch.");
    const plan = planRehome({ bbl: d.bbl, yieldBbl: homes.yieldBbl, plannedBbl: homes.plannedBbl, targetPct, source, refund: d.refund ?? null });
    // Emptying an internal plan (taproom, safety stock) removes it; emptying a
    // partner's allocation would strand their commitment, so that is refused.
    const empties = source.kind === "allocation" && (plan.sourceNewPct ?? 0) <= EPS;
    if (empties && source.channel !== "taproom" && source.channel !== "safety_stock") {
      throw new Error(`That would take all of ${sourceLabel(source)}'s share. Pick another source, or change their commitment on Intake first.`);
    }
    steps.push({ source, plan, empties });
    targetPct = plan.targetNewPct;
  }
  // A paid source is refunded and reduced BEFORE the deal is booked: once the
  // money has moved the reduction must stand whatever happens next, and a
  // refused booking then leaves the freed share honestly unallocated.
  for (const st of steps) if (st.source.requires === "refund") await reduceSource(supabase, homes, st.source, st.plan);

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
      percentage: targetPct,
      partner_id: args.partnerId,
      contract_request_id: commitment.id,
    })
    .select("id")
    .single();
  if (aErr || !alloc) { await undo(); throw new Error(aErr?.message ?? "Could not allocate the batch."); }

  for (const { source, plan, empties } of steps) {
    if (source.kind !== "allocation" || !source.allocationId) continue;
    if (source.requires !== "refund") {
      try {
        await reduceSource(supabase, homes, source, plan);
      } catch (e) {
        await supabase.from("batch_allocations").delete().eq("id", alloc.id);
        await undo();
        throw e;
      }
    }
    if (!empties) await recheckCommitmentFulfillment(supabase, source.allocationId);
  }

  return { commitmentId: commitment.id, allocationId: alloc.id, deltaPct: targetPct };
}
