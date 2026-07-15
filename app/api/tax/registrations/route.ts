/**
 * Per-authority account/license/registration numbers (`tax_registrations`,
 * see lib/tax/registrations.ts) — a finer grain than `tax_authorities`. GET
 * lists all registrations; PUT (admin-only) fully replaces the set: rows
 * without an id are inserted, rows with an id are updated, and any existing
 * row whose id is absent from the payload is deleted.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  listRegistrations,
  saveRegistrations,
  resolveRequiredRegistrations,
  BASE_REQUIRED_REGISTRATIONS,
  type TaxRegistrationInput,
} from "@/lib/tax/registrations";
import { listActivePartyKeys } from "@/lib/tax/schedules";
import { getParty } from "@/lib/tax/registry";
// Side-effect import: registers every party template before getParty() runs.
import "@/lib/tax/parties";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  try {
    const sb = createSupabaseAdminClient();
    const [registrations, activePartyKeys] = await Promise.all([
      listRegistrations(sb),
      listActivePartyKeys(sb),
    ]);
    const requirements = [
      ...BASE_REQUIRED_REGISTRATIONS,
      ...activePartyKeys.flatMap((key) => getParty(key).requiredRegistrations),
    ];
    const required = resolveRequiredRegistrations(requirements, registrations);
    return NextResponse.json({ registrations, required });
  } catch (err) {
    return apiError(err);
  }
}

export async function PUT(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as TaxRegistrationInput[] | { rows: TaxRegistrationInput[] };
    const rows = Array.isArray(body) ? body : body.rows;
    if (!Array.isArray(rows)) return apiError(new Error("rows is required"), 400);
    for (const row of rows) {
      if (!row || typeof row.authority_key !== "string" || !row.authority_key.trim()) {
        return apiError(new Error("each registration requires an authority_key"), 400);
      }
      if (typeof row.label !== "string" || !row.label.trim()) {
        return apiError(new Error("each registration requires a label"), 400);
      }
    }
    const sb = createSupabaseAdminClient();
    await saveRegistrations(sb, rows);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
