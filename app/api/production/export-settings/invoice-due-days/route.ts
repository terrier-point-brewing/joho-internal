import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getNetTermsDays, isValidNetTermsDays, MAX_NET_TERMS_DAYS, MIN_NET_TERMS_DAYS } from "@/lib/production/invoiceTerms";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  return NextResponse.json({ days: await getNetTermsDays(supabase, "export") });
}

export async function PUT(req: NextRequest) {
  try { await requirePermission(CAP.productionSettingsManage); } catch (res) { return res as Response; }

  const { days } = await req.json() as { days: number };
  if (!isValidNetTermsDays(days)) {
    return NextResponse.json({ error: `days must be an integer between ${MIN_NET_TERMS_DAYS} (due on receipt) and ${MAX_NET_TERMS_DAYS}` }, { status: 400 });
  }

  // system_settings RLS only allows service_role writes; use admin client after
  // role has been verified above.
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("system_settings")
    .upsert({ key: "export_invoice_due_days", value: days });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ days });
}
