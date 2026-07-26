import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { allocateFreightByWeight } from "@/lib/production/freightAllocation";
import { computeReceivedAdjustment } from "@/lib/production/receivedAdjustment";

export const dynamic = "force-dynamic";

interface BulkLine {
  ingredient_id: string;
  quantity: number;
  purchase_cost: number;
}

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.inventoryOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body = await req.json();
  const lines: BulkLine[] = Array.isArray(body.lines) ? body.lines : [];
  const freightTotal = Number(body.freight_total ?? 0);

  if (lines.length === 0)
    return NextResponse.json({ error: "At least one line is required" }, { status: 400 });
  if (!(freightTotal >= 0))
    return NextResponse.json({ error: "freight_total must be >= 0" }, { status: 400 });

  const ids = lines.map((l) => l.ingredient_id);
  if (new Set(ids).size !== ids.length)
    return NextResponse.json({ error: "Duplicate ingredient_id in lines" }, { status: 400 });

  for (const l of lines) {
    if (!(Number(l.quantity) > 0))
      return NextResponse.json({ error: `quantity must be > 0 for ingredient ${l.ingredient_id}` }, { status: 400 });
    if (!(Number(l.purchase_cost) > 0))
      return NextResponse.json({ error: `purchase_cost must be > 0 for ingredient ${l.ingredient_id}` }, { status: 400 });
  }

  const { data: ingredientsData, error: fetchErr } = await supabase
    .from("ingredients")
    .select("id, stock_quantity, cost_per_unit, unit")
    .in("id", ids);
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });

  const byId = new Map((ingredientsData ?? []).map((i) => [i.id, i]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0)
    return NextResponse.json({ error: `Ingredient(s) not found: ${missing.join(", ")}` }, { status: 404 });

  const shippingByLine = allocateFreightByWeight(
    lines.map((l) => ({ unit: byId.get(l.ingredient_id)!.unit as string, quantity: Number(l.quantity) })),
    freightTotal
  );

  const results: { ingredient_id: string; new_stock: number; new_cost_per_unit: number; shipping_cost: number }[] = [];
  const errors: { ingredient_id: string; error: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const current = byId.get(line.ingredient_id)!;
    const quantity = Number(line.quantity);
    const purchaseCost = Number(line.purchase_cost);
    const shippingCost = shippingByLine[i];

    const { landedCostPerUnit, newStock, newCostPerUnit } = computeReceivedAdjustment({
      currentStock: current.stock_quantity ?? 0,
      currentCostPerUnit: current.cost_per_unit ?? null,
      quantity,
      purchaseCost,
      shippingCost,
    });

    const { error: adjErr } = await supabase.from("stock_adjustments").insert({
      ingredient_id: line.ingredient_id,
      type: "received",
      quantity,
      note: null,
      cost_per_unit: purchaseCost,
      total_value_change: quantity * landedCostPerUnit,
      shipping_cost: shippingCost > 0 ? shippingCost : null,
      unit: current.unit,
    });
    if (adjErr) { errors.push({ ingredient_id: line.ingredient_id, error: adjErr.message }); continue; }

    const { error: rpcErr } = await supabase.rpc("adjust_ingredient_stock", {
      p_id: line.ingredient_id,
      p_delta: quantity,
    });
    if (rpcErr) { errors.push({ ingredient_id: line.ingredient_id, error: rpcErr.message }); continue; }

    const { error: costErr } = await supabase
      .from("ingredients")
      .update({ cost_per_unit: newCostPerUnit })
      .eq("id", line.ingredient_id);
    if (costErr) { errors.push({ ingredient_id: line.ingredient_id, error: costErr.message }); continue; }

    results.push({
      ingredient_id: line.ingredient_id,
      new_stock: newStock,
      new_cost_per_unit: newCostPerUnit,
      shipping_cost: shippingCost,
    });
  }

  return NextResponse.json({ results, errors }, { status: errors.length === 0 ? 201 : 207 });
}
