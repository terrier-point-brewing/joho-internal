/**
 * GET /api/home/alerts — the Home alert center's one read.
 *
 * Session-gated only, and deliberately so: the page exists for every staff
 * login. What it CONTAINS is gated per group, by the same capability each
 * group's own screen enforces, so the list a person sees is the list they can
 * act on and nothing more. A viewer with no production, finance or org grants
 * gets an empty list and no queries are run on their behalf.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { collectAlerts, countItems } from "@/lib/alerts/collect";
import { getBreweryTimezone } from "@/lib/settings/breweryTimezone.server";
import { todayLocalDate } from "@/lib/utils/datetime";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // The portal is a partner's whole world; proxy.ts already turns them away
  // from this path, and this is the inner wall.
  if (session.partnerId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = createSupabaseAdminClient();
  const today = todayLocalDate(await getBreweryTimezone());
  const [groups, { data: profile }] = await Promise.all([
    collectAlerts(admin, { grants: session.grants, today }),
    admin.from("profiles").select("alert_emails_enabled").eq("id", session.user.id).maybeSingle(),
  ]);

  return NextResponse.json({
    today,
    generated_at: new Date().toISOString(),
    groups,
    counts: countItems(groups),
    // So the page can say whether this person also gets the morning email.
    email_enabled: (profile as { alert_emails_enabled?: boolean } | null)?.alert_emails_enabled === true,
  });
}
