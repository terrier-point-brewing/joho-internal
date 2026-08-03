// app/api/production/export-bay/ship-adhoc/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAvailableColdStorageQuantity } from "@/lib/production/coldStorageDepletion";
import { writeColdStorageShipment } from "@/lib/production/shipmentWriter";
import { triggerSquarePush } from "@/lib/production/triggerSquarePush";

export const dynamic = "force-dynamic";

interface AdHocShipRequest {
  channel: "taproom" | "distribution" | "contract_brewing" | "wholesale";
  partner_id?: string | null;
  recipient_name?: string | null;
  recipe_id: string;
  variation_id: string;
  quantity: number;
  notes?: string | null;
}

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body: AdHocShipRequest = await req.json();
  const { channel, partner_id, recipient_name, recipe_id, variation_id, quantity, notes } = body;

  if (!channel || !recipe_id || !variation_id || !quantity || quantity <= 0) {
    return NextResponse.json(
      { error: "channel, recipe_id, variation_id, and a positive quantity are required" },
      { status: 400 }
    );
  }
  if (channel !== "taproom" && !partner_id) {
    return NextResponse.json({ error: "partner_id is required unless channel is taproom" }, { status: 400 });
  }

  // ── Validate availability ─────────────────────────────────────────────────
  let totalAvailable: number;
  try {
    totalAvailable = await getAvailableColdStorageQuantity(supabase, {
      recipeId: recipe_id,
      variationId: variation_id,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
  if (quantity > totalAvailable) {
    return NextResponse.json(
      { error: `Insufficient cold storage inventory — requested ${quantity}, available ${totalAvailable}` },
      { status: 422 }
    );
  }

  // ── Deplete + write export transactions via the shared shipment writer ─────
  let result: Awaited<ReturnType<typeof writeColdStorageShipment>>;
  try {
    result = await writeColdStorageShipment(supabase, {
      channel,
      recipeId: recipe_id,
      variationId: variation_id,
      quantity,
      recipientId: partner_id ?? null,
      recipientName: recipient_name ?? null,
      allocationId: null,
      notes,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }

  const created = result.depleted.map((d, i) => ({
    batch_id: d.batchId,
    export_transaction_id: result.exportTransactionIds[i],
  }));

  // Same reasoning as the credited ship route: stock left, and only an absolute
  // push tells Square about the channels that never decrement themselves.
  await triggerSquarePush(supabase, [recipe_id], "ad-hoc export ship");

  return NextResponse.json({ created }, { status: 201 });
}
