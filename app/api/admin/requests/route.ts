import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Anyone (unauthenticated) can POST a request; only admins can GET/PATCH.
export async function POST(req: NextRequest) {
  const { name, email, reason } = await req.json();
  if (!name || !email) {
    return NextResponse.json({ error: "name and email are required" }, { status: 400 });
  }

  // Use anon client — the RLS policy allows public insert.
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("account_requests").insert({ name, email, reason });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true }, { status: 201 });
}

export async function GET() {
  try {
    await requireRole("admin");
  } catch (res) {
    return res as Response;
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("account_requests")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  try {
    await requireRole("admin");
  } catch (res) {
    return res as Response;
  }

  const { id, status } = await req.json();
  if (!id || !status) {
    return NextResponse.json({ error: "id and status are required" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const { error } = await admin
    .from("account_requests")
    .update({ status })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
