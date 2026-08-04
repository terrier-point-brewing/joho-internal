import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAvailableColdStorageQuantity } from "@/lib/production/coldStorageDepletion";
import { writeColdStorageShipment } from "@/lib/production/shipmentWriter";
import type { ShipmentWarning } from "@/lib/production/allocationReserve";
import { normalizeShipLines, dedupeWarnings, type ShipLinesInput } from "@/lib/production/shipLines";
import { triggerSquarePush } from "@/lib/production/triggerSquarePush";

export const dynamic = "force-dynamic";

interface ShipRequest extends ShipLinesInput {
  partner_id: string;
  recipe_id: string;
  notes?: string | null;
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

  // Beer physically left the building. Whether Square needs telling depends on
  // whether Square is going to work it out for itself, which is decided inside
  // the push (lib/production/pendingSquareDeduction) off the shipped SKU's own
  // inventory tracking and its invoice's line items — not off the channel.
  //
  // A shipment whose invoice will decrement Square is held back until it does,
  // or the same units come off twice. A shipment whose invoice bills only fees
  // is pushed, because this is the only signal Square will ever get.
  //
  // No-ops while the push gate is shut; never throws.
  await triggerSquarePush(supabase, [recipe_id], `export ship ${shipmentId}`);

  return NextResponse.json(
    { shipment_id: shipmentId, created, warnings: dedupeWarnings(warnings) },
    { status: 201 }
  );
}
