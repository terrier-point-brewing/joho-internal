import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { receivePurchasedBeer } from "@/lib/production/receivePurchasedBeer";
import { triggerSquarePush } from "@/lib/production/triggerSquarePush";

export const dynamic = "force-dynamic";

interface ReceiveRequest {
  recipe_id: string;
  variation_id: string;
  quantity: number;
  supplier?: string | null;
  /** Dollars, as typed. Converted to whole cents here. */
  cost_usd?: number | string | null;
  received_on?: string | null;
  note?: string | null;
}

// POST /api/production/cold-storage/receive
//
// Record beer bought from another brewery (guest beer) as on hand in cold
// storage. The units land on the recipe's purchased placeholder batch
// (brew_batches.source = 'purchased', volume 0) and a beer_receipts row keeps
// the supplier, cost and date. Nothing here touches produced volume, yields or
// the excise record — see lib/production/receivePurchasedBeer.ts.
//
// Gated on brewingOperate: it is the same act as a packaging transfer landing
// finished goods in the cold room.
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.brewingOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  let body: ReceiveRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { recipe_id, variation_id, supplier, received_on, note } = body;
  const quantity = Number(body.quantity);
  if (!recipe_id || !variation_id) {
    return NextResponse.json({ error: "recipe_id and variation_id are required" }, { status: 400 });
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return NextResponse.json({ error: "quantity must be a positive number" }, { status: 400 });
  }
  if (received_on != null && received_on !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(received_on)) {
    return NextResponse.json({ error: "received_on must be YYYY-MM-DD" }, { status: 400 });
  }

  let costCents: number | null = null;
  if (body.cost_usd != null && body.cost_usd !== "") {
    const usd = Number(body.cost_usd);
    if (!Number.isFinite(usd) || usd < 0) {
      return NextResponse.json({ error: "cost_usd must be a non-negative number" }, { status: 400 });
    }
    costCents = Math.round(usd * 100);
  }

  const { data: { user } } = await supabase.auth.getUser();

  let result;
  try {
    result = await receivePurchasedBeer(supabase, {
      recipeId: recipe_id,
      variationId: variation_id,
      quantity,
      supplier: supplier ?? null,
      costCents,
      receivedOn: received_on || null,
      note: note ?? null,
      userId: user?.id ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not receive that beer.";
    console.error("[cold-storage/receive]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Restate Square for the recipe — same contract as the ship and transform
  // routes. Never throws, and no-ops while the push gate is shut.
  await triggerSquarePush(supabase, [recipe_id], "purchased beer received");

  return NextResponse.json(
    { batch_id: result.batchId, batch_created: result.batchCreated, receipt_id: result.receiptId },
    { status: 201 },
  );
}
