import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { buildDraftPoursByDay, type DraftPourRow } from "@/lib/reports/draftPoursByDay";
import { addDaysStr, todayLocalDate } from "@/lib/utils/datetime";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// Draft sell-through per beer per business day, from draft_pour_consumption —
// the same pour record the tap cards' booking-gap check reads.
export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  try {
    const requested = parseInt(new URL(req.url).searchParams.get("days") ?? "14");
    const days = Math.min(Math.max(Number.isFinite(requested) ? requested : 14, 1), 90);
    const endDate = todayLocalDate();
    const startDate = addDaysStr(endDate, -(days - 1));

    const { data: pours, error } = await supabase
      .from("draft_pour_consumption")
      .select("recipe_id, business_date, fl_oz")
      .gte("business_date", startDate)
      .lte("business_date", endDate);
    if (error) throw new Error(error.message);

    const rows = (pours ?? []) as DraftPourRow[];
    const recipeIds = [...new Set(rows.map((r) => r.recipe_id))];
    const beerNameByRecipe = new Map<string, string>();
    if (recipeIds.length > 0) {
      const { data: recipes, error: recipeErr } = await supabase
        .from("recipes")
        .select("id, beer_name")
        .in("id", recipeIds);
      if (recipeErr) throw new Error(recipeErr.message);
      for (const r of recipes ?? []) {
        beerNameByRecipe.set(r.id as string, (r.beer_name as string | null) ?? "—");
      }
    }

    return NextResponse.json(buildDraftPoursByDay(rows, beerNameByRecipe, endDate, days));
  } catch (err) {
    return apiError(err);
  }
}
