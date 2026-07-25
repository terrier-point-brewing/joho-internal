import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAvailableColdStorageQuantity } from "@/lib/production/coldStorageDepletion";
import { writeColdStorageShipment } from "@/lib/production/shipmentWriter";

export const dynamic = "force-dynamic";

interface ShipRequest {
  partner_id: string;
  recipe_id: string;
  variation_id: string;
  quantity: number;
  notes?: string | null;
}

// POST /api/production/export-bay/ship
// Ships finished goods to a contract/wholesale/distribution partner, CREDITING
// that partner's allocations (contract up to booked, soft absorbs, over-delivery
// flagged). Delegates the deplete → credit → write pipeline to the shared
// writeColdStorageShipment; returns the created rows plus reserve advisories.
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body: ShipRequest = await req.json();
  const { partner_id, recipe_id, variation_id, quantity, notes } = body;

  if (!partner_id || !recipe_id || !variation_id || !quantity || quantity <= 0) {
    return NextResponse.json({ error: "partner_id, recipe_id, variation_id, and a positive quantity are required" }, { status: 400 });
  }

  // Physical availability is the only hard block — the writer trusts the caller here.
  let available: number;
  try {
    available = await getAvailableColdStorageQuantity(supabase, { recipeId: recipe_id, variationId: variation_id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
  if (quantity > available) {
    return NextResponse.json(
      { error: `Insufficient cold storage inventory — requested ${quantity}, available ${available}` },
      { status: 422 }
    );
  }

  try {
    const result = await writeColdStorageShipment(supabase, {
      channel: "distribution", // over-delivery fallback only; credited rows use each allocation's channel
      recipeId: recipe_id,
      variationId: variation_id,
      quantity,
      recipientId: partner_id,
      notes: notes ?? null,
      credit: { partnerId: partner_id },
    });
    return NextResponse.json({ created: result.created, warnings: result.warnings }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
