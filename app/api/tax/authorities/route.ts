/**
 * Receiving-party tax authorities registry (`tax_authorities`, see
 * lib/tax/authorities.ts) — the agencies TPB files/pays excise to (NC DOR,
 * TTB, ...). Read-only reference data; per-authority registration/license
 * numbers live at a finer grain in `tax_registrations` (see
 * app/api/tax/registrations/route.ts).
 */
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { listAuthorities } from "@/lib/tax/authorities";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  try {
    const sb = createSupabaseAdminClient();
    return NextResponse.json(await listAuthorities(sb));
  } catch (err) {
    return apiError(err);
  }
}
