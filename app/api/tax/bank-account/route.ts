/**
 * Singleton bank account (`tax_bank_account`) — the account filings are paid
 * from/refunded to, distinct from the entity and legal representative (see
 * lib/tax/bankAccount.ts).
 *
 * GET returns the record with `sensitive` schema fields (routing/account
 * number) masked to `"present"`/`"absent"` — the real numbers never leave
 * the server this way. PUT is admin-only and merges submitted values onto
 * the stored record (blank = leave unchanged).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { getBankAccount, putBankAccount, BANK_ACCOUNT_SCHEMA } from "@/lib/tax/bankAccount";
import { maskSensitive } from "@/lib/tax/profiles";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  try {
    const sb = createSupabaseAdminClient();
    const values = await getBankAccount(sb);
    return NextResponse.json(maskSensitive(values, BANK_ACCOUNT_SCHEMA));
  } catch (err) {
    return apiError(err);
  }
}

export async function PUT(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as Record<string, string>;
    const sb = createSupabaseAdminClient();
    await putBankAccount(sb, body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
