import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { leadTimeDays } from "@/app/production/types";
import { brewWindows } from "@/lib/partner/capacity";
import { breweryToday, loadCapacityInputs, requirePartner } from "@/lib/partner/portal.server";

export const dynamic = "force-dynamic";

// GET /api/partner/windows?turns=2[&recipe_id=…]
// The weeks a brew of this size could start. With a recipe it uses that beer's
// own fermentation; for a new beer there is no recipe yet, so it assumes a
// standard two weeks and the brewer confirms on approval.
export async function GET(req: NextRequest) {
  let caller;
  try { caller = await requirePartner(req); } catch (res) { return res as Response; }

  const params = req.nextUrl.searchParams;
  const turns = Math.max(1, Math.round(Number(params.get("turns")) || 1));
  const recipeId = params.get("recipe_id");
  const admin = createSupabaseAdminClient();

  let fermentDays = 14, lead = 21;
  if (recipeId) {
    const { data: recipe } = await admin.from("recipes")
      .select("days_brewhouse, days_fermenter, days_brite").eq("id", recipeId).eq("partner_id", caller.partnerId).maybeSingle();
    if (!recipe) return NextResponse.json({ error: "That beer is not one of yours." }, { status: 404 });
    fermentDays = Number(recipe.days_fermenter ?? 0) || 14;
    lead = leadTimeDays(recipe) || fermentDays;
  }

  const today = await breweryToday();
  const inputs = await loadCapacityInputs(admin, today);
  return NextResponse.json({ windows: brewWindows({ today, ...inputs, fermentDays, leadTimeDays: lead, turns }) });
}
