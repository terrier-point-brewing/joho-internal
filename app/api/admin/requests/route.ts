import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const ADMIN_EMAIL = "will.liao@terrierpoint.com";

async function sendEmail(to: string, subject: string, html: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  const resend = new Resend(apiKey);
  await resend.emails.send({ from: "noreply@terrierpoint.com", to, subject, html });
}

async function notifyAdminOfRequest(name: string, email: string, reason: string | null) {
  await sendEmail(
    ADMIN_EMAIL,
    `New account request from ${name}`,
    `
      <p><strong>${name}</strong> (${email}) has requested access to TPB Square Reports.</p>
      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""}
      <p>Log in to review and approve or deny the request.</p>
    `,
  );
}

// Anyone (unauthenticated) can POST a request; only admins can GET/PATCH.
export async function POST(req: NextRequest) {
  const { name, email, reason } = await req.json();
  if (!name || !email) {
    return NextResponse.json({ error: "name and email are required" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("account_requests").insert({ name, email, reason });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

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

  if (status === "approved") {
    const { data: request, error: fetchError } = await admin
      .from("account_requests")
      .select("email, name")
      .eq("id", id)
      .single();

    if (fetchError || !request) {
      return NextResponse.json({ error: "Request not found" }, { status: 404 });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

    // If a stale auth user exists for this email, delete them first so we can
    // issue a clean invite. listUsers() with a per-page filter avoids scanning
    // all users on large tenants.
    const { data: { users } } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const existing = users.find((u) => u.email === request.email);
    if (existing) {
      await admin.auth.admin.deleteUser(existing.id);
    }

    // generateLink creates the auth user and returns the invite URL without
    // sending any email — keeping us off Supabase's rate-limited SMTP entirely.
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "invite",
      email: request.email,
      options: { redirectTo: `${appUrl}/auth/set-password` },
    });

    if (linkError) {
      return NextResponse.json({ error: linkError.message }, { status: 400 });
    }


    // Send the invite email ourselves via Resend.
    const inviteUrl = linkData.properties.action_link;
    await sendEmail(
      request.email,
      "You've been invited to TPB Square Reports",
      `
        <p>Hi ${request.name},</p>
        <p>Your access request has been approved. Click the link below to set your password and sign in:</p>
        <p><a href="${inviteUrl}">Set your password</a></p>
        <p>This link expires in 24 hours. If you need a new one, contact your admin.</p>
      `,
    ).catch((err) => console.error("[Resend] Failed to send invite email:", err));
  }

  const { error } = await admin
    .from("account_requests")
    .update({ status })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
