import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { triggerSquarePush } from "@/lib/production/triggerSquarePush";

export const dynamic = "force-dynamic";

interface TransformRequest {
  lot_id: string;
  to_variation_id: string;
  from_units?: number;
  to_units: number;
  note?: string | null;
}

// POST /api/production/cold-storage/transform
//
// Reformat cold-storage stock in place: turn N units of one packaging variation
// into M units of another within the same batch. It runs in both directions —
// 1 x 1/2 Keg -> 3 x 1/6 Keg, or 3 x 1/6 Keg -> 1 x 1/2 Keg — and the payload is
// the same shape either way; from/to say which variation, not which is bigger.
// The build-up matters because a phantom-export reconcile only accepts the exact
// keg size that was booked, so reshaping the stock is the operator's route to it.
//
// Unlike an automatic can break, a keg transform LOSES volume in either
// direction: you rarely get the full three sixtels a half keg's 1984 fl oz would
// allow, and you leave beer behind combining them back up. The difference is
// real beer and gets journalled.
//
// Gated on exportOperate, the same permission as shipping: a transform destroys
// inventory just as irreversibly.
//
// All the integrity rules live in apply_cold_storage_transform, one atomic
// statement: it locks the lot, refuses to spend stock that isn't there, credits
// the children onto the same batch, and journals the loss. The
// never-creates-volume check fires on that journal insert, so a bad count rolls
// the inventory writes back with it. This handler's only jobs are to authorize,
// translate the RPC's errcodes into HTTP, and restate Square.
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  let body: TransformRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { lot_id, to_variation_id, note } = body;
  const fromUnits = Number(body.from_units ?? 1);
  const toUnits = Number(body.to_units);

  if (!lot_id || !to_variation_id) {
    return NextResponse.json({ error: "lot_id and to_variation_id are required" }, { status: 400 });
  }
  if (!Number.isFinite(fromUnits) || fromUnits <= 0) {
    return NextResponse.json({ error: "from_units must be a positive number" }, { status: 400 });
  }
  if (!Number.isFinite(toUnits) || toUnits <= 0) {
    return NextResponse.json({ error: "to_units must be a positive number" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("apply_cold_storage_transform", {
    p_lot_id: lot_id,
    p_to_variation_id: to_variation_id,
    p_from_units: fromUnits,
    p_to_units: toUnits,
    p_note: note ?? null,
    p_source_ref: null,
  });

  if (error) {
    // 23514 is the never-creates-volume constraint. It's the one failure an
    // operator will actually hit by mistake, so say what went wrong in their
    // terms rather than surfacing the raw constraint name. It no longer fires on
    // a one-ounce rounding gap (3 x 1/6 -> 1 x 1/2) — that slack is in the
    // constraint itself, so anything reaching here is a real over-count.
    if (error.code === "23514") {
      return NextResponse.json(
        { error: "That many units would hold more beer than the source did. Check the count — a transform can lose volume, never create it." },
        { status: 400 },
      );
    }
    if (error.code === "P0002") return NextResponse.json({ error: "That cold storage lot no longer exists." }, { status: 404 });
    if (error.code === "22023") return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Restate Square for the affected recipe — same contract as the ship routes.
  // Never throws, and no-ops while the push gate is shut.
  const recipeId = (data as { recipe_id?: string | null } | null)?.recipe_id ?? null;
  await triggerSquarePush(supabase, [recipeId], "cold-storage transform");

  return NextResponse.json(data);
}
