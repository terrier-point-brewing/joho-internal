import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  try {
    const { data, error } = await supabase
      .from("quarterly_targets")
      .select("id, year, quarter, tier, target_cents")
      .order("year", { ascending: false })
      .order("quarter", { ascending: false })
      .order("tier", { ascending: true });
    if (error) throw error;
    return NextResponse.json(data);
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }
  const supabase = await createSupabaseServerClient();

  try {
    const { year, quarter, tier, target_cents } = await req.json();
    if (!year || !quarter || !tier || target_cents == null) {
      return NextResponse.json(
        { error: "year, quarter, tier, target_cents required" },
        { status: 400 }
      );
    }
    const { data, error } = await supabase
      .from("quarterly_targets")
      .upsert({ year, quarter, tier, target_cents }, { onConflict: "year,quarter,tier" })
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json(data);
  } catch (err) {
    return apiError(err);
  }
}
