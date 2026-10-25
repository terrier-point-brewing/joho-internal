import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Per-partner charge switches that live in Export Settings rather than on the
 * partner record — today only whether a partner is billed for keg cleaning.
 */
export async function PUT(req: NextRequest) {
  try { await requirePermission(CAP.productionSettingsManage); } catch (res) { return res as Response; }

  const body = await req.json() as { partner_id?: string; charges_keg_cleaning?: boolean };
  if (!body.partner_id) return NextResponse.json({ error: "partner_id is required" }, { status: 400 });
  if (typeof body.charges_keg_cleaning !== "boolean") {
    return NextResponse.json({ error: "charges_keg_cleaning must be a boolean" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("contract_brewing_partners")
    .update({ charges_keg_cleaning: body.charges_keg_cleaning })
    .eq("id", body.partner_id)
    .select("id, company_name, charges_keg_cleaning")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
