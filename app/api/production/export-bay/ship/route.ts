import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAvailableColdStorageQuantity } from "@/lib/production/coldStorageDepletion";
import { writeColdStorageShipment } from "@/lib/production/shipmentWriter";
import type { ShipmentWarning } from "@/lib/production/allocationReserve";
import { normalizeShipLines, dedupeWarnings, type ShipLinesInput } from "@/lib/production/shipLines";
import { triggerSquarePush } from "@/lib/production/triggerSquarePush";
import { unpaidDepositBatches, simulateShipment, type SimulatedShipment } from "@/lib/production/shipReserveContext";
import { executeRehome } from "@/lib/production/rehome";

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
  home?: { target_allocation_id: string; source: { kind: "unallocated" } | { kind: "allocation"; allocation_id: string }; bbl: number };
}

// POST /api/production/export-bay/ship
// Ships finished goods to a contract/wholesale/distribution partner, CREDITING
// that partner's allocations (contract up to booked, soft absorbs, over-delivery
// flagged). Accepts several packaging variations of the same recipe in one
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
  if (sim.noCommitment) {
    return NextResponse.json(
      { error: "This partner has no commitment for this beer. Create one on Intake → Commitments and allocate it to the batch, then ship from that card." },
      { status: 409 },
    );
  }
  // Beer beyond the booking must be given a home first: take its share from
  // somewhere on the batch and raise the booking, so the credit is inside the
  // commitment and the deposit / ledger / warnings all see it.
  if (sim.overBbl > 1e-4) {
    const home = body.home;
    if (!home || !home.target_allocation_id || !home.source || !(Number(home.bbl) >= sim.overBbl - 0.01)) {
      return NextResponse.json(
        {
          error: `${sim.overBbl.toFixed(2)} bbl of this shipment is beyond the partner's booking. Choose where that share comes from before shipping.`,
          over: sim.over,
        },
        { status: 409 },
      );
    }
    try {
      await executeRehome(supabase, {
        targetAllocationId: home.target_allocation_id,
        source: home.source.kind === "unallocated" ? { kind: "unallocated" } : { kind: "allocation", allocationId: home.source.allocation_id },
        bbl: Number(home.bbl),
      });
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
