import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import { planShipment } from "@/lib/production/allocationReserve";
import { loadShipReserveContext, simulateColdStorageDraw } from "@/lib/production/shipReserveContext";

export const dynamic = "force-dynamic";

interface PreviewRequest {
  partner_id: string;
  recipe_id: string;
  variation_id: string;
  quantity: number;
}

// POST /api/production/export-bay/ship/preview
// Returns the advisory warnings a prospective shipment would raise, plus whether
// physical stock is sufficient — WITHOUT writing anything. Backs the Ship modal's
// pre-submit warning display so the user sees coverage/over-booking advisories
// before committing. Shares reserve math with the real ship via loadShipReserveContext.
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body: PreviewRequest = await req.json();
  const { partner_id, recipe_id, variation_id, quantity } = body;

  if (!partner_id || !recipe_id || !variation_id || !quantity || quantity <= 0) {
    return NextResponse.json({ warnings: [], insufficientStock: false, available: 0 });
  }

  const { data: variation, error: varErr } = await supabase
    .from("packaging_variations")
    .select("total_volume_fl_oz")
    .eq("id", variation_id)
    .single();
  if (varErr) return NextResponse.json({ error: varErr.message }, { status: 500 });
  if (!variation) return NextResponse.json({ error: "Variation not found." }, { status: 404 });

  const bblPerUnit = variation.total_volume_fl_oz / BBL_TO_FL_OZ;
  const requestedBbl = quantity * bblPerUnit;

  const { perBatchDrawBbl, availableUnits } = await simulateColdStorageDraw(supabase, {
    recipeId: recipe_id, variationId: variation_id, quantity, bblPerUnit,
  });

  const { candidates, batches } = await loadShipReserveContext(supabase, {
    recipeId: recipe_id,
    partnerId: partner_id,
    drawnBatchIds: perBatchDrawBbl.map((d) => d.batchId),
  });

  const plan = planShipment({ requestedBbl, candidates, perBatchDrawBbl, batches });

  return NextResponse.json({
    warnings: plan.warnings,
    insufficientStock: quantity > availableUnits,
    available: availableUnits,
  });
}
