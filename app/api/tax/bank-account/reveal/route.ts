/**
 * Reveals the REAL value of `tax_bank_account`'s `sensitive` fields
 * (routing/account number) — the escape hatch from the write-only masked
 * GET at `../route.ts`. Admin-only (stricter than the masked GET's
 * `manager` floor): unmasking a stored account number is a more sensitive
 * action than merely knowing one is on file.
 */
import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { getBankAccount, BANK_ACCOUNT_SCHEMA } from "@/lib/tax/bankAccount";
import { pickSensitiveValues } from "@/lib/tax/profiles";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.taxPiiReveal); } catch (res) { return res as Response; }

  try {
    const sb = createSupabaseAdminClient();
    const values = await getBankAccount(sb);
    return NextResponse.json(pickSensitiveValues(values, BANK_ACCOUNT_SCHEMA));
  } catch (err) {
    return apiError(err);
  }
}
