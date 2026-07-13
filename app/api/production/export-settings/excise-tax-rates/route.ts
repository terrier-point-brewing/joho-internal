import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requireRole(["viewer", "brewer", "manager"]); } catch (res) { return res as Response; }

  const party = req.nextUrl.searchParams.get("party");
  const supabase = createSupabaseAdminClient();
  let query = supabase
    .from("excise_tax_rates")
    .select("id, name, receiving_party, unit, rate_usd, is_active, square_catalog_item_id, square_catalog_variation_id, party_key, created_at, updated_at");
  if (party) query = query.eq("party_key", party);
  const { data, error } = await query.order("name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const body = await req.json() as {
    name: string;
    receiving_party?: string | null;
    unit: "bbl" | "gallon";
    rate_usd: number;
    square_catalog_item_id?: string | null;
    square_catalog_variation_id?: string | null;
    party_key?: string | null;
  };

  if (!body.name || !body.unit || body.rate_usd == null) {
    return NextResponse.json({ error: "name, unit, and rate_usd are required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("excise_tax_rates")
    .insert({
      name: body.name,
      receiving_party: body.receiving_party ?? null,
      unit: body.unit,
      rate_usd: body.rate_usd,
      square_catalog_item_id: body.square_catalog_item_id ?? null,
      square_catalog_variation_id: body.square_catalog_variation_id ?? null,
      party_key: body.party_key ?? null,
    })
    .select("id, name, receiving_party, unit, rate_usd, is_active, square_catalog_item_id, square_catalog_variation_id, party_key, created_at, updated_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
