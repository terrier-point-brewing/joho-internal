import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { maxTurns, monthlyCapacity, TURN_BBL } from "@/lib/partner/capacity";
import { breweryToday, loadCapacityInputs, loadClaimableForPartner, requirePartner } from "@/lib/partner/portal.server";

export const dynamic = "force-dynamic";

// GET /api/partner/overview
// Everything the portal's first paint needs: who they are, the six-month
// capacity strip, the beer they could claim, and their own recipes.
export async function GET(req: NextRequest) {
  let caller;
  try { caller = await requirePartner(req); } catch (res) { return res as Response; }

  const admin = createSupabaseAdminClient();
  const today = await breweryToday();
  const [{ data: partner }, { data: recipes }, capacityInputs, available] = await Promise.all([
    admin.from("contract_brewing_partners").select("company_name").eq("id", caller.partnerId).maybeSingle(),
    admin.from("recipes").select("id, beer_name, style, days_fermenter").eq("partner_id", caller.partnerId).order("beer_name"),
    loadCapacityInputs(admin, today),
    loadClaimableForPartner(admin, caller.partnerId),
  ]);
  if (!partner) return NextResponse.json({ error: "Partner company not found." }, { status: 404 });

  // The strip is drawn before a beer is chosen, so it assumes the longest
  // fermentation this partner brews (or the house's longest) — it may
  // under-promise, never over-promise. The request form recomputes per recipe.
  const own = (recipes ?? []) as Array<{ id: string; beer_name: string; style: string | null; days_fermenter: number | null }>;
  let fermentDays = Math.max(0, ...own.map((r) => Number(r.days_fermenter ?? 0)));
  if (fermentDays <= 0) {
    const { data: all } = await admin.from("recipes").select("days_fermenter");
    fermentDays = Math.max(14, ...((all ?? []) as Array<{ days_fermenter: number | null }>).map((r) => Number(r.days_fermenter ?? 0)));
  }

  return NextResponse.json({
    company_name: partner.company_name,
    preview: caller.preview,
    turn_bbl: TURN_BBL,
    max_turns: maxTurns(capacityInputs.fermenters),
    capacity: monthlyCapacity({ today, ...capacityInputs, fermentDays }),
    available,
    recipes: own.map((r) => ({ id: r.id, beer_name: r.beer_name, style: r.style })),
  });
}
