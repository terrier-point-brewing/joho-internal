import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const { company_name, first_name, last_name, phone, address, email, notes, square_customer_id } = await req.json();

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
    })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const { error } = await supabase.from("contract_brewing_partners").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
