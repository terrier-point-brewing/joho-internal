import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { parseTrendRange, type TrendData } from "@/lib/reports/draftTrend";
import { addDaysStr, todayLocalDate } from "@/lib/utils/datetime";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// Draft sell-through events: fl oz poured per beer per business day, from
// draft_pour_consumption — the same pour record the tap cards' booking-gap
// check reads. `range` is a day count or "all"; bucketing happens client-side.
export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  try {
    const range = parseTrendRange(new URL(req.url).searchParams.get("range"), 30);
    const end = todayLocalDate();
    const windowStart = range === "all" ? null : addDaysStr(end, -(range - 1));

    // Paged: all-time is already past PostgREST's 1,000-row page.
    const pours = await fetchAllRows<{ recipe_id: string; business_date: string; fl_oz: number | string }>(() => {
      let q = supabase
        .from("draft_pour_consumption")
        .select("recipe_id, business_date, fl_oz")
        .lte("business_date", end);
      if (windowStart) q = q.gte("business_date", windowStart);
      return q.order("business_date").order("recipe_id");
    });

    const events = pours
      .map((p) => ({ recipe_id: p.recipe_id, date: p.business_date, value: Number(p.fl_oz) || 0 }))
      .filter((e) => e.value !== 0);

    const recipeIds = [...new Set(events.map((e) => e.recipe_id))];
    let recipes: TrendData["recipes"] = [];
    if (recipeIds.length > 0) {
      const { data, error } = await supabase.from("recipes").select("id, beer_name").in("id", recipeIds);
      if (error) throw new Error(error.message);
      recipes = (data ?? []).map((r) => ({
        recipe_id: r.id as string,
        beer_name: (r.beer_name as string | null) ?? "—",
      }));
    }

    const body: TrendData = { start: windowStart ?? events[0]?.date ?? end, end, recipes, events };
    return NextResponse.json(body);
  } catch (err) {
    return apiError(err);
  }
}
