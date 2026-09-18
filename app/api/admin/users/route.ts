import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP, type UserRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const PARTNER_ROLE: UserRole = "partner";

/** Null when the role / company pairing is valid, else the reason it is not. */
function partnerPairingError(role: unknown, partnerId: unknown): string | null {
  if (role === PARTNER_ROLE && !partnerId) return "A partner login must be linked to a partner company.";
  if (role !== PARTNER_ROLE && partnerId) return "Only a partner login can be linked to a partner company.";
  return null;
}

export async function GET() {
  try {
    await requirePermission(CAP.usersManage);
  } catch (res) {
    return res as Response;
  }

  const admin = createSupabaseAdminClient();
  const [profilesRes, authRes] = await Promise.all([
    admin.from("profiles").select("id, email, role, partner_id, created_at").order("created_at", { ascending: true }),
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
    await requirePermission(CAP.usersManage);
  } catch (res) {
    return res as Response;
  }

  const { email, password, role, partner_id } = await req.json();
  if (!email || !password || !role) {
    return NextResponse.json({ error: "email, password, and role are required" }, { status: 400 });
  }
  // An external partner login belongs to exactly one company; a staff login to
  // none. The DB enforces the same pairing (profiles_partner_role_pairing) —
  // checked here first so the refusal reads like a sentence.
  const pairing = partnerPairingError(role, partner_id);
  if (pairing) return NextResponse.json({ error: pairing }, { status: 400 });

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
    .update({ role, partner_id: role === PARTNER_ROLE ? partner_id : null })
    .eq("id", authData.user.id);

  if (profileError) {
    // A login with no role row would default to viewer — an EXTERNAL person
    // inside the taproom numbers. Remove it rather than leave it half-made.
    await admin.auth.admin.deleteUser(authData.user.id);
    return NextResponse.json({ error: profileError.message }, { status: 500 });
  }

  return NextResponse.json({ id: authData.user.id, email, role }, { status: 201 });
}
