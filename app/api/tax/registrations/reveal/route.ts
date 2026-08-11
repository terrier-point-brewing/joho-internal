/**
 * Reveals the REAL number of every `sensitive` registration kind (Wake
 * County's gross receipts PIN today) — the escape hatch from the masked GET at
 * `../route.ts`. Admin-only (stricter than the masked GET's manager floor),
 * matching the profile/bank-account/representative reveal routes: knowing a
 * credential is on file is a lesser act than reading it.
 *
 * Keys are `"authorityKey:registrationKey"` (`registrationKindKey`), so the
 * caller looks up exactly the row it rendered rather than guessing.
 */
import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  listRegistrations,
  registrationKindKey,
  sensitiveRegistrationKinds,
  BASE_REQUIRED_REGISTRATIONS,
  type RequiredRegistration,
} from "@/lib/tax/registrations";
import { listParties } from "@/lib/tax/registry";
// Side-effect import: registers every party template before listParties() runs.
import "@/lib/tax/parties";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.taxPiiReveal); } catch (res) { return res as Response; }

  try {
    const requirements: RequiredRegistration[] = [
      ...BASE_REQUIRED_REGISTRATIONS,
      ...listParties().flatMap((p) => p.requiredRegistrations),
    ];
    const sensitiveKinds = sensitiveRegistrationKinds(requirements);

    const sb = createSupabaseAdminClient();
    const revealed: Record<string, string> = {};
    for (const row of await listRegistrations(sb)) {
      if (!row.registration_kind || !row.number) continue;
      const key = registrationKindKey(row.authority_key, row.registration_kind);
      if (sensitiveKinds.has(key)) revealed[key] = row.number;
    }
    return NextResponse.json(revealed);
  } catch (err) {
    return apiError(err);
  }
}
