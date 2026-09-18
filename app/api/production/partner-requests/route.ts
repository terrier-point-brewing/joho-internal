import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { listInbox } from "@/lib/partner/requests.server";

export const dynamic = "force-dynamic";

// GET /api/production/partner-requests — the inbox of what partners asked for
// through the portal. Admin client: partner_requests has RLS on and no policy.
export async function GET() {
  try { await requirePermission(CAP.partnersRead); } catch (res) { return res as Response; }
  return NextResponse.json(await listInbox(createSupabaseAdminClient()));
}
