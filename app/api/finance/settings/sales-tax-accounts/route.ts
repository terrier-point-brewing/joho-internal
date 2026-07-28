/**
 * Square tax -> liability account mapping. Thin wrapper over
 * lib/finance/salesTaxAccounts.ts; GET seeds any newly observed tax as a
 * side effect, matching the counterparty-rules pattern.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { listSalesTaxAccounts, setSalesTaxAccount } from "@/lib/finance/salesTaxAccounts";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.financeTransactionsRead); } catch (res) { return res as Response; }
  try {
    return NextResponse.json(await listSalesTaxAccounts(createSupabaseAdminClient()));
  } catch (err) {
    return apiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
  try {
    const body = await req.json() as { square_tax_id?: string; chart_of_accounts_id?: string | null };
    if (!body.square_tax_id) {
      return NextResponse.json({ error: "square_tax_id required" }, { status: 400 });
    }
    await setSalesTaxAccount(createSupabaseAdminClient(), body.square_tax_id, body.chart_of_accounts_id ?? null);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
