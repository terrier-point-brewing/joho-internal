import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET /api/production/export-bay/active-allocation-check?partner_id=&recipe_id=
// Advisory-only existence check used by the Ad-Hoc Export modal to warn
// (non-blocking) when the selected customer already has a real allocation
// for the selected recipe. Mirrors the existence-check shape of the regular
// Ship route's Step 3 query, but skips the production/exported-volume math
// — this only answers "does any allocation exist at all," not "how much
// remains." The ad-hoc endpoint itself never calls or enforces this.
export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const partnerId = req.nextUrl.searchParams.get("partner_id");
  const recipeId = req.nextUrl.searchParams.get("recipe_id");
  if (!partnerId || !recipeId) {
    return NextResponse.json({ error: "partner_id and recipe_id are required" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("batch_allocations")
    .select("id, brew_batches!inner(recipe_id)")
    .eq("partner_id", partnerId)
    .neq("channel", "taproom")
    .eq("brew_batches.recipe_id", recipeId)
    .limit(1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ hasActiveAllocation: (data ?? []).length > 0 });
}
