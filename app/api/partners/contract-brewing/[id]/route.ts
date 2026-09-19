import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.partnersManage); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const body = await req.json();
  const { company_name, first_name, last_name, phone, address, email, notes, square_customer_id, recipes_exclusive } = body;

  // The portal-exclusivity switch on its own. A Square-linked partner's contact
  // fields are read-only here (Square owns them), but this flag is ours — and
  // sending it through the full update below would null every contact field
  // the caller did not repeat.
  if (typeof recipes_exclusive === "boolean" && Object.keys(body).length === 1) {
    const { data, error } = await supabase.from("contract_brewing_partners")
      .update({ recipes_exclusive }).eq("id", id).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  const { data, error } = await supabase
    .from("contract_brewing_partners")
    .update({
      company_name,
      first_name: first_name || null,
      last_name: last_name || null,
      phone: phone || null,
      address: address || null,
      email: email || null,
      notes: notes || null,
      // Allow explicitly clearing the square link by passing null
      ...(square_customer_id !== undefined ? { square_customer_id: square_customer_id || null } : {}),
      ...(typeof recipes_exclusive === "boolean" ? { recipes_exclusive } : {}),
    })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.partnersManage); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const { error } = await supabase.from("contract_brewing_partners").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
