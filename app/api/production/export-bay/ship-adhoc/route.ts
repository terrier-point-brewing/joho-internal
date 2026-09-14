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

  // ── A partner with an allocation for this recipe ships from the allocation ─
  // Ad-hoc rows credit nothing, so shipping a committed partner this way
  // would leave their commitment unfulfilled and the beer unaccounted for.
  // This used to be an advisory confirm; it is a refusal now.
  if (channel !== "taproom" && partner_id) {
    const { data: existing } = await supabase
      .from("batch_allocations")
      .select("id, brew_batches!inner(recipe_id, batch_number)")
      .eq("partner_id", partner_id)
      .neq("channel", "taproom")
      .eq("brew_batches.recipe_id", recipe_id)
      .limit(3);
    if ((existing ?? []).length > 0) {
      const batches = (existing ?? [])
        .map((a) => (a.brew_batches as unknown as { batch_number?: string | null } | null)?.batch_number)
        .filter((n): n is string => !!n)
        .map((n) => `#${n}`);
      return NextResponse.json(
        { error: `This partner has an allocation for this beer${batches.length ? ` (${batches.join(", ")})` : ""}. Ship it from that allocation card so the commitment is credited; ad-hoc is for partners with no commitment.` },
        { status: 409 },
      );
    }
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
      // The whole point of this route: stock going out with nothing booked
      // behind it. Recorded on the row so an invoice does not have to infer it
      // from a null allocation, which four other things also produce.
      adHoc: true,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }

  const created = result.depleted.map((d, i) => ({
    batch_id: d.batchId,
    export_transaction_id: result.exportTransactionIds[i],
  }));

  // Same reasoning as the credited ship route: the push decides for itself
  // whether Square still owes a deduction for this stock, and holds back if so.
  await triggerSquarePush(supabase, [recipe_id], "ad-hoc export ship");

  return NextResponse.json({ created }, { status: 201 });
}
