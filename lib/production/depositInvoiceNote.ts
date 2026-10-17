/**
 * The customer-facing note on a standalone ingredient deposit invoice: how the
 * figure was arrived at, in the terms the partner asked for the beer in.
 *
 * The deposit itself is `percentage × the batch's full ingredient bill`, and a
 * bare "Ingredient deposit for your Hazy IPA batch" left the partner unable to
 * check it. The note says where the percentage came from — a claim through the
 * portal, a batch request through the portal, or a commitment staff booked —
 * what that is in barrels of the batch, and what their share is currently
 * expected to yield once packaged (in-tank beer counted at the house packaging
 * yield, the same projection the shipped deposit divides by).
 *
 * A back-charged deposit on an export invoice has its own wording —
 * shippedDepositDescription — because that one is priced per bbl shipped.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LedgerTransfer } from "@/lib/production/volumeLedger";
import { loadPackagingYieldPct, projectBatchYield } from "@/lib/production/exportIngredientDeposit";

export type DepositRequestOrigin =
  /** Partner claimed beer off an open batch in the portal; `requestedBbl` is what they claimed. */
  | { kind: "portal_claim"; requestedBbl: number }
  /** Partner requested a brew in the portal; `sharePct` of its `brewBbl`, `requestedBbl` wanted. */
  | { kind: "portal_batch"; requestedBbl: number; sharePct: number; brewBbl: number }
  /** Staff booked the commitment; `requestedBbl` is its volume. */
  | { kind: "commitment"; requestedBbl: number }
  /** An allocation with no commitment behind it. */
  | { kind: "none" };

export interface DepositBasis {
  beerName: string;
  batchNumber: string | null;
  /** Allocation percentage of the batch. */
  percentage: number;
  /** The batch's nominal (brewhouse fill) volume. */
  batchBbl: number;
  origin: DepositRequestOrigin;
  /** Packaged so far plus in-tank beer at the house yield; null when no transfers exist yet. */
  projectedYieldBbl: number | null;
  packagingYieldPct: number;
  /** Converted-from recipes whose ingredients were netted out of this bill. */
  excludedBeerNames: string[];
}

const bbl = (n: number) => `${n.toFixed(2)} bbl`;
const pct = (n: number) => `${n.toFixed(1)}%`;

export function depositInvoiceDescription(b: DepositBasis): string {
  const beer = b.beerName.trim();
  const batchRef = b.batchNumber ? `${beer} batch ${b.batchNumber}` : `${beer} batch`;
  const share = `${pct(b.percentage)} of the ${bbl(b.batchBbl)} batch`;

  let how: string;
  switch (b.origin.kind) {
    case "portal_claim":
      how = `You claimed ${bbl(b.origin.requestedBbl)} of this beer through the partner portal, which is ${share}.`;
      break;
    case "portal_batch":
      how = b.origin.sharePct < 100
        ? `You requested ${pct(b.origin.sharePct)} of a ${bbl(b.origin.brewBbl)} brew through the partner portal (${bbl(b.origin.requestedBbl)}), which is ${share}.`
        : `You requested this brew through the partner portal (${bbl(b.origin.requestedBbl)}), which is ${share}.`;
      break;
    case "commitment":
      how = `Your commitment is for ${bbl(b.origin.requestedBbl)}, which is ${share}.`;
      break;
    default:
      how = `Your allocation is ${share}.`;
  }

  const sentences = [`Ingredient deposit for your ${batchRef}.`, how];

  if (b.projectedYieldBbl != null && b.projectedYieldBbl > 0) {
    const yours = (b.percentage / 100) * b.projectedYieldBbl;
    sentences.push(
      `The batch is currently estimated to yield ${bbl(b.projectedYieldBbl)} after packaging ` +
      `(beer still in tank counted at ${b.packagingYieldPct}%), so your share is about ${bbl(yours)}.`,
    );
  } else {
    sentences.push(`Nothing has been transferred yet, so the batch's estimated yield is not known.`);
  }

  const exclusions = b.excludedBeerNames.length > 0
    ? `, net of the ${b.excludedBeerNames.join(" and ")} ingredients already billed`
    : "";
  sentences.push(`The deposit is ${pct(b.percentage)} of the batch's ingredient cost${exclusions}.`);

  return sentences.join(" ");
}

interface BasisLookup {
  allocationId: string;
  batchId: string;
  contractRequestId: string | null;
  percentage: number;
  beerName: string;
  batchNumber: string | null;
  batchBbl: number;
  excludedBeerNames: string[];
}

/** Gather the basis from the request, commitment and transfer ledger behind an allocation. */
export async function loadDepositBasis(supabase: SupabaseClient, p: BasisLookup): Promise<DepositBasis> {
  const [origin, projection] = await Promise.all([
    loadOrigin(supabase, p),
    loadProjection(supabase, p.batchId, p.batchBbl),
  ]);
  return {
    beerName: p.beerName,
    batchNumber: p.batchNumber,
    percentage: p.percentage,
    batchBbl: p.batchBbl,
    origin,
    projectedYieldBbl: projection.projectedYieldBbl,
    packagingYieldPct: projection.packagingYieldPct,
    excludedBeerNames: p.excludedBeerNames,
  };
}

async function loadOrigin(supabase: SupabaseClient, p: BasisLookup): Promise<DepositRequestOrigin> {
  // A portal request links itself to the allocation (claim) or the commitment
  // (batch request) when it is approved.
  const filters = [`allocation_id.eq.${p.allocationId}`];
  if (p.contractRequestId) filters.push(`commitment_id.eq.${p.contractRequestId}`);
  const { data: reqs } = await supabase
    .from("partner_requests")
    .select("kind, volume_bbl, wanted_bbl, share_pct, status")
    .or(filters.join(","))
    .eq("status", "approved")
    .limit(1);
  const req = reqs?.[0] as { kind: "claim" | "batch"; volume_bbl: number | string; wanted_bbl: number | string | null; share_pct: number | string | null } | undefined;
  if (req?.kind === "claim") return { kind: "portal_claim", requestedBbl: Number(req.volume_bbl) };
  if (req?.kind === "batch") {
    const brewBbl = Number(req.volume_bbl);
    return {
      kind: "portal_batch",
      brewBbl,
      requestedBbl: req.wanted_bbl == null ? brewBbl : Number(req.wanted_bbl),
      sharePct: req.share_pct == null ? 100 : Number(req.share_pct),
    };
  }

  if (p.contractRequestId) {
    const { data: c } = await supabase.from("commitments").select("volume_bbl").eq("id", p.contractRequestId).maybeSingle();
    if (c) return { kind: "commitment", requestedBbl: Number(c.volume_bbl) };
  }
  return { kind: "none" };
}

async function loadProjection(supabase: SupabaseClient, batchId: string, nominalBbl: number) {
  const [packagingYieldPct, { data: transfers }, { data: equipment }] = await Promise.all([
    loadPackagingYieldPct(supabase),
    supabase
      .from("batch_transfers")
      .select("batch_id, from_tank_id, to_tank_id, to_batch_id, volume_bbl, shrinkage_bbl, transferred_at, transfer_type")
      .or(`batch_id.eq.${batchId},to_batch_id.eq.${batchId}`),
    supabase.from("equipment").select("id, type"),
  ]);
  const ledger = (transfers ?? []) as Array<LedgerTransfer & { transfer_type: string }>;
  if (ledger.length === 0) return { packagingYieldPct, projectedYieldBbl: null };
  const tankTypeById: Record<string, string> = {};
  for (const e of equipment ?? []) tankTypeById[e.id as string] = e.type as string;
  const { projectedYieldBbl } = projectBatchYield(batchId, nominalBbl, ledger, tankTypeById, packagingYieldPct);
  return { packagingYieldPct, projectedYieldBbl };
}
