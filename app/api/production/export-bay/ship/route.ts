import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAvailableColdStorageQuantity } from "@/lib/production/coldStorageDepletion";
import { writeColdStorageShipment } from "@/lib/production/shipmentWriter";
import type { ShipmentWarning } from "@/lib/production/allocationReserve";
import { normalizeShipLines, dedupeWarnings, type ShipLinesInput } from "@/lib/production/shipLines";
import { triggerSquarePush } from "@/lib/production/triggerSquarePush";
import { unpaidDepositBatches, simulateShipment, type SimulatedShipment } from "@/lib/production/shipReserveContext";
import { executeRehome, bookCommitmentForShipment, drawsFromBody } from "@/lib/production/rehome";

export const dynamic = "force-dynamic";

interface ShipRequest extends ShipLinesInput {
  partner_id: string;
  recipe_id: string;
  notes?: string | null;
  /**
   * The operator has seen that a contract allocation this shipment will credit
   * has NOT paid its ingredient deposit, and is shipping on credit anyway (the
   * deposit back-charges on the export invoice). Without it the route refuses
   * with the batches in question, so shipping before the deposit is a stated
   * decision rather than something nobody noticed.
   */
  acknowledge_unpaid_deposit?: boolean;
  /**
   * Where beer beyond the partner's booking takes its share from, decided in
   * the Ship modal from the preview's `over.homes`. Required whenever the
   * plan would over-deliver; the move happens before the shipment is written,
   * so the credit lands inside the commitment instead of as over-delivery.
   */
  /**
   * Where share beyond the booking comes from: a list of draws split across
   * sources as the operator chose (`draws`), or the older single `source`+`bbl`.
   * `refund_cents` on a draw is the refund the operator confirmed when that
   * source's deposit is paid (lib/production/rehome).
   */
  home?: {
    target_allocation_id: string;
    source?: { kind: "unallocated" } | { kind: "allocation"; allocation_id: string };
    bbl?: number;
    refund_cents?: number;
    draws?: Array<{ source: { kind: "unallocated" } | { kind: "allocation"; allocation_id: string }; bbl: number; refund_cents?: number }>;
  };
  /**
   * The partner has no commitment for this beer: book one for exactly this
   * shipment, on the batch it is drawn from, taking the share from `source`
   * (the preview's `book.homes`). Created before the shipment is written and
   * flagged for someone on Intake to confirm price and terms.
   */
  book?: {
    channel: "contract_brewing" | "distribution";
    source?: { kind: "unallocated" } | { kind: "allocation"; allocation_id: string };
    refund_cents?: number;
    draws?: Array<{ source: { kind: "unallocated" } | { kind: "allocation"; allocation_id: string }; bbl: number; refund_cents?: number }>;
  };
}

// POST /api/production/export-bay/ship
// Ships finished goods to a contract/wholesale/distribution partner, CREDITING
// that partner's allocations (contract up to booked, every channel up to its
// share; beyond that the beer must be given a home first). Accepts several packaging variations of the same recipe in one
// shipment — e.g. 2× 1/2 keg and 3× 1/6 keg of the same beer against one
// allocation. Delegates the deplete → credit → write pipeline to the shared
// writeColdStorageShipment; returns the created rows plus reserve advisories.
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body: ShipRequest = await req.json();
  const { partner_id, recipe_id, notes } = body;
  const lines = normalizeShipLines(body);

  if (!partner_id || !recipe_id || lines.length === 0) {
    return NextResponse.json(
      { error: "partner_id, recipe_id, and at least one line with a positive quantity are required" },
      { status: 400 }
    );
  }

  // Physical availability is the only hard block — the writer trusts the caller.
  // Every line is checked BEFORE anything is written, so one bad line can't
  // leave the shipment half-committed.
  for (const line of lines) {
    let available: number;
    try {
      available = await getAvailableColdStorageQuantity(supabase, {
        recipeId: recipe_id, variationId: line.variation_id,
      });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
    }
    if (line.quantity > available) {
      return NextResponse.json(
        { error: `Insufficient cold storage inventory — requested ${line.quantity}, available ${available}` },
        { status: 422 }
      );
    }
  }

  // A partner shipment lives inside a commitment. No allocation for this beer
  // means no home for the credit, the deposit or the ledger row — refuse.
  let sim: SimulatedShipment;
  try {
    sim = await simulateShipment(supabase, { recipeId: recipe_id, partnerId: partner_id, lines });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not plan the shipment" }, { status: 422 });
  }
  // Booked on the spot: the whole shipment (no commitment for this beer) or
  // only the beer beyond the booking (a commitment, but no share of the batch
  // the kegs are drawn from — the extra lives on that batch, never an older one).
  if (sim.book) {
    const book = body.book;
    if (!sim.book.homes) {
      return NextResponse.json({ error: sim.book.refusal ?? "Nothing to ship." }, { status: 409 });
    }
    if (!book || !["contract_brewing", "distribution"].includes(book.channel) || !(book.source?.kind || Array.isArray(book.draws))) {
      const why = sim.book.reason === "off_batch"
        ? `${sim.book.bbl.toFixed(2)} bbl of this shipment is beyond the booking and this partner has no share of the batch it is drawn from.`
        : "This partner has no commitment for this beer.";
      return NextResponse.json(
        { error: `${why} Choose the channel and where its share of the batch comes from, and it is booked as it ships.`, book: sim.book },
        { status: 409 },
      );
    }
    // A new contract allocation has no deposit paid by definition. Ask BEFORE
    // booking, so a refused ship never leaves a commitment behind.
    if (book.channel === "contract_brewing" && body.acknowledge_unpaid_deposit !== true) {
      return NextResponse.json(
        { error: "A new contract commitment has no ingredient deposit paid. Ship anyway and it is back-charged on the export invoice — confirm to continue." },
        { status: 409 },
      );
    }
    try {
      // The draws must add up to the booking: short-changing it would book a
      // deal the batch cannot honour, over-drawing would strand share.
      const draws = drawsFromBody(book, sim.book.bbl);
      const total = draws.reduce((s, d) => s + d.bbl, 0);
      if (Math.abs(total - sim.book.bbl) > 0.01) {
        return NextResponse.json({ error: `The share drawn (${total.toFixed(2)} bbl) must equal the booking (${sim.book.bbl.toFixed(2)} bbl).`, book: sim.book }, { status: 409 });
      }
      await bookCommitmentForShipment(supabase, {
        partnerId: partner_id,
        recipeId: recipe_id,
        batchId: sim.book.homes.batchId,
        channel: book.channel,
        draws,
      });
      sim = await simulateShipment(supabase, { recipeId: recipe_id, partnerId: partner_id, lines });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Could not book the commitment" }, { status: 422 });
    }
  }
  // Beer beyond the booking must be given a home first: take its share from
  // somewhere on the batch and raise the booking, so the credit is inside the
  // commitment and the deposit / ledger / warnings all see it.
  // Our own to give — the deal's unshipped share, the unallocated remainder,
  // the taproom — is taken without asking. Only another partner's share is a
  // decision, and that is the one case the operator still has to make.
  // Ours goes first, as far as it reaches; the operator's draws cover only
  // what is left (sim.over.askBbl), from other partners' shares.
  const askBbl = sim.over?.askBbl ?? 0;
  if (sim.overBbl > 1e-4 && sim.over?.targetAllocationId && askBbl <= 1e-4) {
    try {
      for (const draw of sim.over.auto ?? []) {
        await executeRehome(supabase, { targetAllocationId: sim.over.targetAllocationId, source: draw.source, bbl: draw.bbl, bookBbl: draw.bookBbl, beyondBooking: true });
      }
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Could not re-home the extra beer" }, { status: 422 });
    }
  } else if (sim.overBbl > 1e-4) {
    const home = body.home;
    const shortBbl = sim.over?.askShortBbl ?? 0;
    const refuse = () => NextResponse.json(
      {
        error: `${askBbl.toFixed(2)} bbl of this shipment is beyond the partner's booking and what is ours to give. Choose where that share comes from before shipping.`,
        over: sim.over,
      },
      { status: 409 },
    );
    if (!home || !home.target_allocation_id) return refuse();
    // The older single-source body named the over-bbl alone and the route added
    // the short restoration; a `draws` list names the whole amount, short included.
    let draws;
    try {
      draws = drawsFromBody(home);
      if (!Array.isArray(home.draws)) draws[0] = { ...draws[0], bbl: draws[0].bbl + shortBbl };
    } catch { return refuse(); }
    const total = draws.reduce((s, d) => s + d.bbl, 0);
    if (total < askBbl + shortBbl - 0.01) return refuse();
    // Each draw is held to what the preview listed as free — the deal's own
    // share net of this shipment's credit — since executeRehome re-reads the
    // batch and would see the gross figure.
    for (const d of draws) {
      const src = sim.over?.homes.sources.find((s) => d.source.kind === "unallocated" ? s.kind === "unallocated" : s.allocationId === d.source.allocationId);
      if (!src) return refuse();
      if (d.bbl > src.freeBbl + 0.01) {
        return NextResponse.json({ error: `${src.kind === "self" ? "This deal's own unshipped share" : src.partnerName ?? "That source"} has only ${src.freeBbl.toFixed(2)} bbl free after this shipment's own credit, not ${d.bbl.toFixed(2)}.`, over: sim.over }, { status: 409 });
      }
    }
    try {
      for (const draw of sim.over?.auto ?? []) {
        await executeRehome(supabase, { targetAllocationId: home.target_allocation_id, source: draw.source, bbl: draw.bbl, bookBbl: draw.bookBbl, beyondBooking: true });
      }
      // Restore lost share first, booking only what is beyond it (as splitAutoHome does).
      let shortLeft = shortBbl;
      for (const d of draws) {
        await executeRehome(supabase, {
          targetAllocationId: home.target_allocation_id,
          source: d.source,
          bbl: d.bbl,
          bookBbl: Math.round(Math.max(0, d.bbl - shortLeft) * 10000) / 10000,
          beyondBooking: true,
          refund: d.refund ?? null,
        });
        shortLeft = Math.max(0, shortLeft - d.bbl);
      }
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Could not re-home the extra beer" }, { status: 422 });
    }
  }

  // Deposit gate: contract allocations that will be credited but have not paid.
  // Physical stock stays the only HARD block — the partner may well be good for
  // it — but leaving on credit is acknowledged, not silent.
  const unpaid = await unpaidDepositBatches(supabase, { recipeId: recipe_id, partnerId: partner_id });
  if (unpaid.length > 0 && body.acknowledge_unpaid_deposit !== true) {
    return NextResponse.json(
      {
        error: `The ingredient deposit for ${unpaid.map((u) => `#${u.batchNumber ?? u.batchId.slice(0, 8)}`).join(", ")} has not been paid. Ship anyway and the deposit is back-charged on the export invoice — confirm to continue.`,
        unpaid_deposit_batches: unpaid,
      },
      { status: 409 },
    );
  }

  // One shipment id across every line, so the whole drop reads as a single
  // shipment downstream. Lines run in sequence rather than in parallel: each one
  // credits the partner's allocations, and the next must see what the previous
  // consumed or two lines would both claim the same booked deposit.
  const shipmentId = crypto.randomUUID();
  const created: { batch_id: string; export_transaction_id: string }[] = [];
  const warnings: ShipmentWarning[] = [];

  for (const line of lines) {
    try {
      const result = await writeColdStorageShipment(supabase, {
        shipmentId,
        channel: "distribution", // over-delivery fallback only; credited rows use each allocation's channel
        recipeId: recipe_id,
        variationId: line.variation_id,
        quantity: line.quantity,
        recipientId: partner_id,
        notes: notes ?? null,
        credit: { partnerId: partner_id },
      });
      created.push(...result.created);
      warnings.push(...result.warnings);
    } catch (e) {
      // Earlier lines are already committed and are reported back, so the user
      // can see how far the shipment got rather than re-shipping blind.
      return NextResponse.json(
        {
          error: e instanceof Error ? e.message : "Unknown error",
          shipment_id: shipmentId,
          created,
          lines_committed: lines.indexOf(line),
        },
        { status: 500 }
      );
    }
  }

  // Beer physically left the building. Whether Square needs telling now is
  // decided inside the push (lib/production/pendingSquareDeduction): a
  // contract-style shipment is pushed immediately — its fee invoice will never
  // deduct, so this is the only signal Square gets — while a distribution/
  // wholesale-style shipment is held back, because its invoice will deduct the
  // same units itself and pushing first would take them off twice. That window
  // of drift is deliberate and labelled on the taproom drift view.
  //
  // No-ops while the push gate is shut; never throws.
  await triggerSquarePush(supabase, [recipe_id], `export ship ${shipmentId}`);

  return NextResponse.json(
    { shipment_id: shipmentId, created, warnings: dedupeWarnings(warnings) },
    { status: 201 }
  );
}
