import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Read-only view of the canonical `tax_rates` table, scoped to excise rows.
 * Rates are fixed reference data — there is no create/update/delete here.
 */
export async function GET(req: NextRequest) {
  try { await requireRole(["viewer", "brewer", "manager"]); } catch (res) { return res as Response; }

  const party = req.nextUrl.searchParams.get("party");
  const supabase = createSupabaseAdminClient();
  let query = supabase
    .from("tax_rates")
    .select("id, key, name, category, party_key, basis, rate, is_active, square_catalog_item_id, square_catalog_variation_id, receiving_party")
    .eq("category", "excise");
  if (party) query = query.eq("party_key", party);
  const { data, error } = await query.order("name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}
