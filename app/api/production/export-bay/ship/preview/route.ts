import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { simulateShipment, type SimulatedShipment } from "@/lib/production/shipReserveContext";
import { normalizeShipLines, type ShipLinesInput } from "@/lib/production/shipLines";

export const dynamic = "force-dynamic";

interface PreviewRequest extends ShipLinesInput {
  partner_id: string;
  recipe_id: string;
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

  let sim: SimulatedShipment;
  try {
    sim = await simulateShipment(supabase, { recipeId: recipe_id, partnerId: partner_id, lines });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Preview failed" }, { status: 404 });
  }
  const { plan, candidates, lines: lineAvailability } = sim;

  // Contract allocations this shipment would credit on credit (deposit unpaid).
  // The real ship refuses these without an acknowledgement — say so first.
  const unpaid = candidates.filter((c) => c.channel === "contract_brewing" && c.depositSettled === false);
  const { data: unpaidBatchRows } = unpaid.length > 0
    ? await supabase.from("brew_batches").select("id, batch_number").in("id", unpaid.map((c) => c.batchId))
    : { data: [] as Array<{ id: string; batch_number: string | null }> };
  const numberById = new Map(((unpaidBatchRows ?? []) as Array<{ id: string; batch_number: string | null }>).map((b) => [b.id, b.batch_number]));

  return NextResponse.json({
    unpaidDepositBatches: unpaid.map((c) => ({ batchId: c.batchId, batchNumber: numberById.get(c.batchId) ?? null, allocationId: c.allocationId })),
    // Beer beyond the booking must be given a home before it ships.
    noCommitment: sim.noCommitment,
    over: sim.over,
    warnings: plan.warnings,
    insufficientStock: lineAvailability.some((l) => l.insufficient),
    // Single-line callers still read `available` as a bare number.
    available: lineAvailability.length === 1 ? lineAvailability[0].available : 0,
    lines: lineAvailability,
  });
}
