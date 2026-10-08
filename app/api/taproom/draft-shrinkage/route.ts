import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { parseTrendRange, type TrendData } from "@/lib/reports/draftTrend";
import { localDateString, addDaysStr, todayLocalDate } from "@/lib/utils/datetime";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// Draft shrinkage events: one per keg that came off a tap, valued at the fl oz
// that left it with no transaction behind it. `range` is a day count or "all".
//
// Beer-change rows are dropped: that keg came off deliberately part-full, so its
// balance is mostly beer dumped on purpose — a decision, not a loss the taproom
// can tighten up.
export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  try {
    const range = parseTrendRange(new URL(req.url).searchParams.get("range"), 90);
    const end = todayLocalDate();
    const windowStart = range === "all" ? null : addDaysStr(end, -(range - 1));

    const rows = await fetchAllRows<{
      recipe_id: string; occurred_at: string;
      unaccounted_fl_oz: number | string; full_fl_oz: number | string; cause: string | null;
    }>(() => {
      let q = supabase
        .from("draft_swap_shrinkage")
        .select("recipe_id, occurred_at, unaccounted_fl_oz, full_fl_oz, cause");
      // A day early: occurred_at is an instant, the window is brewery-local dates.
      if (windowStart) q = q.gte("occurred_at", `${addDaysStr(windowStart, -1)}T00:00:00Z`);
      return q.order("occurred_at").order("source_ref");
    });

    const events = rows
      .filter((r) => r.cause !== "beer_change")
      .map((r) => {
        const oz = Number(r.unaccounted_fl_oz) || 0;
        const full = Number(r.full_fl_oz) || 0;
        return {
          recipe_id: r.recipe_id,
          date: localDateString(r.occurred_at),
          value: oz,
          ...(full > 0 ? { aux: (oz / full) * 100 } : {}),
        };
      })
      .filter((e) => e.date <= end && (!windowStart || e.date >= windowStart));

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
