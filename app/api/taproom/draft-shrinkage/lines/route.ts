import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { addDaysStr, localDateString } from "@/lib/utils/datetime";
import type { TrendLine } from "@/lib/reports/trendLines";
import { requireDateRange, apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// The kegs behind one beer's draft loss: `?start&end&recipe=<id>`. One line
// per keg that came off a tap, from draft_swap_shrinkage — the same rows the
// trend averages, with beer-change swaps dropped for the same reason.
export async function GET(req: NextRequest) {
  const range = requireDateRange(req);
  if (range instanceof NextResponse) return range;
  const recipe = new URL(req.url).searchParams.get("recipe");
  if (!recipe) return NextResponse.json({ error: "recipe required" }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  try {
    const rows = await fetchAllRows<{
      occurred_at: string; unaccounted_fl_oz: number | string; full_fl_oz: number | string;
      cause: string | null; source_ref: string | null;
    }>(() =>
      supabase
        .from("draft_swap_shrinkage")
        .select("occurred_at, unaccounted_fl_oz, full_fl_oz, cause, source_ref")
        .eq("recipe_id", recipe)
        .gte("occurred_at", `${addDaysStr(range.start, -1)}T00:00:00Z`)
        .lte("occurred_at", `${addDaysStr(range.end, 1)}T23:59:59Z`)
        .order("occurred_at", { ascending: false }),
    );

    const lines: TrendLine[] = rows
      .filter((r) => r.cause !== "beer_change")
      .filter((r) => { const d = localDateString(r.occurred_at); return d >= range.start && d <= range.end; })
      .map((r) => {
        const oz = Number(r.unaccounted_fl_oz) || 0;
        const full = Number(r.full_fl_oz) || 0;
        return {
          occurredAt: r.occurred_at,
          label: full > 0 ? `${Math.round(full)} oz keg` : "keg",
          quantity: null,
          value: oz,
          ref: r.source_ref ?? "",
          note: full > 0 ? `${((oz / full) * 100).toFixed(1)}% of keg${r.cause ? ` · ${r.cause}` : ""}` : r.cause ?? undefined,
        };
      });
    return NextResponse.json({ lines });
  } catch (err) {
    return apiError(err);
  }
}
