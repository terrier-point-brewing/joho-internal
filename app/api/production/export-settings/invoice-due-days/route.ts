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
    .eq("key", "export_invoice_due_days")
    .single();

  if (error) return NextResponse.json({ days: 30 });
  return NextResponse.json({ days: (data.value as number) ?? 30 });
}

export async function PUT(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const { days } = await req.json() as { days: number };
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return NextResponse.json({ error: "days must be an integer between 1 and 365" }, { status: 400 });
  }

  // system_settings RLS only allows service_role writes; use admin client after
  // role has been verified above.
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("system_settings")
    .upsert({ key: "export_invoice_due_days", value: days, updated_at: new Date().toISOString() });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ days });
}
