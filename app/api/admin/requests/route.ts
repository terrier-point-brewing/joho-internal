import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const ADMIN_EMAIL = "will.liao@terrierpoint.com";

async function notifyAdminOfRequest(name: string, email: string, reason: string | null) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return; // silently skip if not configured
  const resend = new Resend(apiKey);
  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: ADMIN_EMAIL,
    subject: `New account request from ${name}`,
    html: `
      <p><strong>${name}</strong> (${email}) has requested access to TPB Square Reports.</p>
      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""}
      <p>Log in to review and approve or deny the request.</p>
    `,
  });
}

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

  // Fire-and-forget — don't block the response on email delivery.
  notifyAdminOfRequest(name, email, reason ?? null).catch((err) =>
    console.error("[Resend] Failed to send account request notification:", err)
  );

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
