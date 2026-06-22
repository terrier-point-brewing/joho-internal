import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }
  const { id } = await params;

  const body = await req.json() as Partial<{
    name: string;
    receiving_party: string | null;
    unit: "bbl" | "gallon";
    rate_usd: number;
    is_active: boolean;
    square_catalog_item_id: string | null;
    square_catalog_variation_id: string | null;
  }>;

  const patch: Record<string, unknown> = {};
  for (const key of ["name", "receiving_party", "unit", "rate_usd", "is_active", "square_catalog_item_id", "square_catalog_variation_id"] as const) {
    if (key in body) patch[key] = body[key];
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }
  patch.updated_at = new Date().toISOString();

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("excise_tax_rates")
    .update(patch)
    .eq("id", id)
    .select("id, name, receiving_party, unit, rate_usd, is_active, square_catalog_item_id, square_catalog_variation_id, created_at, updated_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }
  const { id } = await params;

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("excise_tax_rates").delete().eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
