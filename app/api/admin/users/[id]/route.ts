import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requirePermission(CAP.usersManage);
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

  if (body.email_confirm) {
    const { error } = await admin.auth.admin.updateUserById(id, { email_confirm: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  // The morning alert digest switch. Its own branch, and its own write: it must
  // never ride along with a role change, and a partner login has no digest to
  // switch on — the job excludes the role and the screen offers no control.
  if (typeof body.alert_emails_enabled === "boolean") {
    const { data: profile } = await admin.from("profiles").select("role").eq("id", id).maybeSingle();
    if ((profile as { role?: string } | null)?.role === "partner") {
      return NextResponse.json({ error: "A partner login cannot receive alert emails." }, { status: 400 });
    }
    const { error } = await admin.from("profiles").update({ alert_emails_enabled: body.alert_emails_enabled }).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ id, alert_emails_enabled: body.alert_emails_enabled });
  }

  const { role } = body;
  if (!role) return NextResponse.json({ error: "role, password, email_confirm or alert_emails_enabled is required" }, { status: 400 });

  // Role and company move together, in one write: the DB refuses a partner
  // with no company and a staff login with one.
  const partner_id = role === "partner" ? (body.partner_id ?? null) : null;
  if (role === "partner" && !partner_id) {
    return NextResponse.json({ error: "A partner login must be linked to a partner company." }, { status: 400 });
  }

  const { error } = await admin.from("profiles").update({ role, partner_id }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id, role, partner_id });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requirePermission(CAP.usersManage);
  } catch (res) {
    return res as Response;
  }

  const { id } = await params;
  const admin = createSupabaseAdminClient();
  const { error } = await admin.auth.admin.deleteUser(id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
