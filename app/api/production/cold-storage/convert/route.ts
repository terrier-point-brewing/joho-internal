import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { convertColdStorageLot, ConversionError } from "@/lib/production/coldStorageRecipeConversion";

export const dynamic = "force-dynamic";

interface ConvertRequest {
  lot_id: string;
  target_recipe_id: string;
  units: number;
  note?: string | null;
}

// POST /api/production/cold-storage/convert
//
// Convert kegs or cans already in cold storage into a different recipe — the
// late-dose counterpart of an in-keg conversion. The stock stays in the cold
// room; what changes is which beer (and which batch) it is. Everything the
// books need — the conversion child, the ledger rows, the ingredient
// additions, the lot move, Square — happens in convertColdStorageLot.
//
// Gated on exportOperate like a transform: it re-homes finished goods just as
// irreversibly.
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  let body: ConvertRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { lot_id, target_recipe_id, note } = body;
  const units = Number(body.units);
  if (!lot_id || !target_recipe_id) {
    return NextResponse.json({ error: "lot_id and target_recipe_id are required" }, { status: 400 });
  }
  if (!Number.isFinite(units)) {
    return NextResponse.json({ error: "units must be a number" }, { status: 400 });
  }

  try {
    const result = await convertColdStorageLot(supabase, {
      lotId: lot_id,
      targetRecipeId: target_recipe_id,
      units,
      note: note ?? null,
      createdBy: user?.id ?? null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof ConversionError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[cold-storage convert] failed:", e);
    return NextResponse.json({ error: (e as Error).message ?? "Conversion failed" }, { status: 500 });
  }
}
