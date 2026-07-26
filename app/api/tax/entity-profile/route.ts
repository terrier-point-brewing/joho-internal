/**
 * Singleton tax entity profile (`tax_entity_profile`) — the brewery's own
 * legal/contact identity used to prefill filings across every receiving
 * party (see lib/tax/entity.ts).
 *
 * GET returns the profile with `sensitive` schema fields masked to
 * `"present"`/`"absent"` — the SSN never leaves the server. FEIN is
 * intentionally NOT marked sensitive in ENTITY_PROFILE_SCHEMA, so it
 * round-trips as a normal field. PUT is admin-only and merges submitted
 * values onto the stored profile (blank = leave unchanged).
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { getEntityProfile, putEntityProfile, ENTITY_PROFILE_SCHEMA } from "@/lib/tax/entity";
import { maskSensitive } from "@/lib/tax/profiles";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.taxRead); } catch (res) { return res as Response; }

  try {
    const sb = createSupabaseAdminClient();
    const values = await getEntityProfile(sb);
    return NextResponse.json(maskSensitive(values, ENTITY_PROFILE_SCHEMA));
  } catch (err) {
    return apiError(err);
  }
}

export async function PUT(req: NextRequest) {
  try { await requirePermission(CAP.taxManage); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as Record<string, string>;
    const sb = createSupabaseAdminClient();
    await putEntityProfile(sb, body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
