import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import { planShipment } from "@/lib/production/allocationReserve";
import { loadShipReserveContext, simulateColdStorageDraw } from "@/lib/production/shipReserveContext";
import { normalizeShipLines, type ShipLinesInput } from "@/lib/production/shipLines";

export const dynamic = "force-dynamic";

interface PreviewRequest extends ShipLinesInput {
  partner_id: string;
  recipe_id: string;
}

/** Per-line availability, so the modal can point at the offending row. */
interface LineAvailability {
  variation_id: string;
  requested: number;
  available: number;
  insufficient: boolean;
}

// POST /api/production/export-bay/ship/preview
// Returns the advisory warnings a prospective shipment would raise, plus whether
// physical stock is sufficient — WITHOUT writing anything. Backs the Ship modal's
// pre-submit warning display so the user sees coverage/over-booking advisories
// before committing. Shares reserve math with the real ship via loadShipReserveContext.
//
// Multi-line requests are planned as ONE shipment rather than N independent ones:
// the per-batch draws are merged and a single planShipment runs over the total.
// Planning each line alone would let two lines each look like they fit inside the
// same booked deposit, hiding an over-booking the real ship would then flag.
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body: PreviewRequest = await req.json();
  const { partner_id, recipe_id } = body;

  // Same collapse-by-variation rule the ship route uses, so the preview's
  // availability check matches the one that will actually gate the submit.
  const lines = normalizeShipLines(body);

  if (!partner_id || !recipe_id || lines.length === 0) {
    return NextResponse.json({ warnings: [], insufficientStock: false, available: 0, lines: [] });
  }

  const { data: variations, error: varErr } = await supabase
    .from("packaging_variations")
    .select("id, total_volume_fl_oz")
    .in("id", lines.map((l) => l.variation_id));
  if (varErr) return NextResponse.json({ error: varErr.message }, { status: 500 });
  const volumeById = new Map((variations ?? []).map((v) => [v.id, Number(v.total_volume_fl_oz)]));

  let requestedBbl = 0;
  const mergedDraw = new Map<string, number>();
  const lineAvailability: LineAvailability[] = [];

  for (const line of lines) {
    const totalFlOz = volumeById.get(line.variation_id);
    if (totalFlOz == null) {
      return NextResponse.json({ error: "Variation not found." }, { status: 404 });
    }
    const bblPerUnit = totalFlOz / BBL_TO_FL_OZ;
    requestedBbl += line.quantity * bblPerUnit;

    const { perBatchDrawBbl, availableUnits } = await simulateColdStorageDraw(supabase, {
      recipeId: recipe_id, variationId: line.variation_id, quantity: line.quantity, bblPerUnit,
    });
    for (const d of perBatchDrawBbl) {
      mergedDraw.set(d.batchId, (mergedDraw.get(d.batchId) ?? 0) + d.drawBbl);
    }
    lineAvailability.push({
      variation_id: line.variation_id,
      requested: line.quantity,
      available: availableUnits,
      insufficient: line.quantity > availableUnits,
    });
  }

  const perBatchDrawBbl = [...mergedDraw].map(([batchId, drawBbl]) => ({ batchId, drawBbl }));

  const { candidates, batches } = await loadShipReserveContext(supabase, {
    recipeId: recipe_id,
    partnerId: partner_id,
    drawnBatchIds: perBatchDrawBbl.map((d) => d.batchId),
  });

  const plan = planShipment({ requestedBbl, candidates, perBatchDrawBbl, batches });

  return NextResponse.json({
    warnings: plan.warnings,
    insufficientStock: lineAvailability.some((l) => l.insufficient),
    // Single-line callers still read `available` as a bare number.
    available: lineAvailability.length === 1 ? lineAvailability[0].available : 0,
    lines: lineAvailability,
  });
}
