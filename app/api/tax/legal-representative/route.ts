/**
 * Singleton legal representative (`tax_legal_representative`) — the
 * individual who signs/certifies filings on behalf of the business, distinct
 * from the entity itself (see lib/tax/legalRepresentative.ts).
 *
 * GET returns the record with `sensitive` schema fields masked to
 * `"present"`/`"absent"` — the SSN never leaves the server. PUT is
 * admin-only and merges submitted values onto the stored record (blank =
 * leave unchanged).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  getLegalRepresentative,
  putLegalRepresentative,
  LEGAL_REPRESENTATIVE_SCHEMA,
} from "@/lib/tax/legalRepresentative";
import { maskSensitive } from "@/lib/tax/profiles";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  try {
    const sb = createSupabaseAdminClient();
    const values = await getLegalRepresentative(sb);
    return NextResponse.json(maskSensitive(values, LEGAL_REPRESENTATIVE_SCHEMA));
  } catch (err) {
    return apiError(err);
  }
}

export async function PUT(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as Record<string, string>;
    const sb = createSupabaseAdminClient();
    await putLegalRepresentative(sb, body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
