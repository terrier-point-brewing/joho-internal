import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  try {
    await requireRole("admin");
  } catch (res) {
    return res as Response;
  }

  const admin = createSupabaseAdminClient();
  const [profilesRes, authRes] = await Promise.all([
    admin.from("profiles").select("id, email, role, created_at").order("created_at", { ascending: true }),
    admin.auth.admin.listUsers({ perPage: 1000 }),
  ]);

  if (profilesRes.error) return NextResponse.json({ error: profilesRes.error.message }, { status: 500 });

  const authById = Object.fromEntries(
    (authRes.data?.users ?? []).map((u) => [u.id, u])
  );

  const data = profilesRes.data.map((p) => ({
    ...p,
    email_confirmed: !!authById[p.id]?.email_confirmed_at,
  }));

  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try {
    await requireRole("admin");
  } catch (res) {
    return res as Response;
  }

  const { email, password, role } = await req.json();
  if (!email || !password || !role) {
    return NextResponse.json({ error: "email, password, and role are required" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();

  // Create the auth user
  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (authError) return NextResponse.json({ error: authError.message }, { status: 400 });

  // Set role (trigger created the profile row; now update the role)
  const { error: profileError } = await admin
    .from("profiles")
    .update({ role })
    .eq("id", authData.user.id);

  if (profileError) return NextResponse.json({ error: profileError.message }, { status: 500 });

  return NextResponse.json({ id: authData.user.id, email, role }, { status: 201 });
}
