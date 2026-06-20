import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", "floorplan_grid")
    .single();

  if (error) return NextResponse.json({ cols: 48, rows: 32 });
  const v = data.value as { cols: number; rows: number };
  return NextResponse.json({ cols: v.cols ?? 48, rows: v.rows ?? 32 });
}

export async function PUT(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const { cols, rows } = await req.json() as { cols: number; rows: number };
  if (!Number.isInteger(cols) || cols < 16 || cols > 80) {
    return NextResponse.json({ error: "cols must be 16–80" }, { status: 400 });
  }
  if (!Number.isInteger(rows) || rows < 8 || rows > 64) {
    return NextResponse.json({ error: "rows must be 8–64" }, { status: 400 });
  }

  // system_settings RLS only allows service_role writes; use admin client after
  // role has been verified above.
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("system_settings")
    .upsert({ key: "floorplan_grid", value: { cols, rows }, updated_at: new Date().toISOString() });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ cols, rows });
}
