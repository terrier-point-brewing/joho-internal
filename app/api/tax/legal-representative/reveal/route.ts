/**
 * Reveals the REAL value of `tax_legal_representative`'s `sensitive` fields
 * (SSN) — the escape hatch from the write-only masked GET at
 * `../route.ts`. Admin-only (stricter than the masked GET's `manager`
 * floor): unmasking a stored SSN is a more sensitive action than merely
 * knowing one is on file.
 */
import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { getLegalRepresentative, LEGAL_REPRESENTATIVE_SCHEMA } from "@/lib/tax/legalRepresentative";
import { pickSensitiveValues } from "@/lib/tax/profiles";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.taxPiiReveal); } catch (res) { return res as Response; }

  try {
    const sb = createSupabaseAdminClient();
    const values = await getLegalRepresentative(sb);
    return NextResponse.json(pickSensitiveValues(values, LEGAL_REPRESENTATIVE_SCHEMA));
  } catch (err) {
    return apiError(err);
  }
}
