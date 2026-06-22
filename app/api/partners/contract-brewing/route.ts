import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("contract_brewing_partners")
    .select("*")
    .order("company_name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const { company_name, first_name, last_name, phone, address, email, notes } = body;
  if (!company_name) return NextResponse.json({ error: "company_name is required" }, { status: 400 });

  const { data, error } = await supabase
    .from("contract_brewing_partners")
    .insert({ company_name, first_name: first_name || null, last_name: last_name || null, phone: phone || null, address: address || null, email: email || null, notes: notes || null })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
