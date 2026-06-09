import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireRole("admin");
  } catch (res) {
    return res as Response;
  }

  const { id } = await params;
  const body = await req.json();
  const admin = createSupabaseAdminClient();

  if (body.password) {
    const { error } = await admin.auth.admin.updateUserById(id, { password: body.password });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  const { role } = body;
  if (!role) return NextResponse.json({ error: "role or password is required" }, { status: 400 });

  const { error } = await admin.from("profiles").update({ role }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id, role });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireRole("admin");
  } catch (res) {
    return res as Response;
  }

  const { id } = await params;
  const admin = createSupabaseAdminClient();
  const { error } = await admin.auth.admin.deleteUser(id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
