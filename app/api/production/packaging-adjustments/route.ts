import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { computeReceivedAdjustment } from "@/lib/production/receivedAdjustment";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const item_id = req.nextUrl.searchParams.get("packaging_item_id");
  let query = supabase
    .from("packaging_stock_adjustments")
    .select("*, packaging_items(name, type)")
    .order("created_at", { ascending: false });
  if (item_id) query = query.eq("packaging_item_id", item_id);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.inventoryOperate); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const { packaging_item_id, type, quantity: rawQty, note, purchase_cost, shipping_cost, new_total } = body;
  if (!packaging_item_id || !type) return NextResponse.json({ error: "packaging_item_id and type required" }, { status: 400 });

  // Fetch current state
  const { data: item } = await supabase
    .from("packaging_items")
    .select("stock_quantity, unit_cost_usd")
    .eq("id", packaging_item_id)
    .single();
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });

  const currentStock = Number(item.stock_quantity ?? 0);
  const currentCost  = item.unit_cost_usd != null ? Number(item.unit_cost_usd) : null;

  let delta: number;
  if (type === "inventory_count") {
    delta = Number(new_total) - currentStock;
  } else if (type === "received") {
    delta = +Math.abs(Number(rawQty));
  } else {
    delta = -Math.abs(Number(rawQty));
  }

  // Weighted-average cost update for "received"
  let newCostPerUnit = currentCost;
  let totalValueChange = null;
  if (type === "received" && purchase_cost != null && purchase_cost !== "") {
    const pc = Number(purchase_cost);
    // Landed cost per unit: bake shipping into WAC so deposit calculations see full cost.
    const shippingAmt = shipping_cost != null ? Number(shipping_cost) : 0;
    const { landedCostPerUnit, newCostPerUnit: computedCost } = computeReceivedAdjustment({
      currentStock,
      currentCostPerUnit: currentCost,
      quantity: delta,
      purchaseCost: pc,
      shippingCost: shippingAmt,
    });
    newCostPerUnit = computedCost;
    totalValueChange = delta * landedCostPerUnit;
  }

  const { data: adj, error: adjErr } = await supabase
    .from("packaging_stock_adjustments")
    .insert({
      packaging_item_id,
      quantity: delta,
      type,
      note: note || null,
      cost_per_unit_usd: type === "received" && purchase_cost ? Number(purchase_cost) : null,
      shipping_cost_usd: type === "received" && shipping_cost != null ? Number(shipping_cost) : null,
      total_value_change_usd: totalValueChange,
    })
    .select()
    .single();
  if (adjErr) return NextResponse.json({ error: adjErr.message }, { status: 500 });

  // Update stock_quantity (and optionally unit_cost_usd)
  const updatePayload: Record<string, number | null> = { stock_quantity: currentStock + delta };
  if (type === "received" && newCostPerUnit != null) updatePayload.unit_cost_usd = newCostPerUnit;

  await supabase.from("packaging_items").update(updatePayload).eq("id", packaging_item_id);

  return NextResponse.json(adj, { status: 201 });
}
