/**
 * Square tax -> liability account mapping. Thin wrapper over
 * lib/finance/salesTaxAccounts.ts; GET seeds any newly observed tax as a
 * side effect, matching the counterparty-rules pattern.
 *
 * GET also joins each tax to the ACTIVE tax filings that depend on it
 * (lib/tax/squareTaxUsage.ts) so the settings table can warn before a tax a
 * live return computes from is excluded or left unmapped. The join is composed
 * here rather than inside lib/finance/salesTaxAccounts.ts to keep the finance
 * lib free of a dependency on the tax party registry.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { listSalesTaxAccounts, setSalesTaxAccount } from "@/lib/finance/salesTaxAccounts";
import { listSquareTaxUsage, type SquareTaxReference } from "@/lib/tax/squareTaxUsage";

export const dynamic = "force-dynamic";

export interface SalesTaxAccountWithUsage {
  square_tax_id: string;
  tax_name: string | null;
  tax_pct: number | null;
  chart_of_accounts_id: string | null;
  excluded: boolean;
  chart_of_accounts: { account_name: string; account_number: string | null } | null;
  filing_refs: SquareTaxReference[];
}

export async function GET() {
  try { await requirePermission(CAP.financeTransactionsRead); } catch (res) { return res as Response; }
  try {
    const sb = createSupabaseAdminClient();
    // Sequential, not Promise.all: listSalesTaxAccounts seeds newly observed
    // taxes as a side effect, and the usage join should see that same row set.
    const rows = await listSalesTaxAccounts(sb);
    const usage = await listSquareTaxUsage(sb);
    const withUsage: SalesTaxAccountWithUsage[] = rows.map((row) => ({
      ...row,
      filing_refs: usage.get(row.square_tax_id) ?? [],
    }));
    return NextResponse.json(withUsage);
  } catch (err) {
    return apiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
  try {
    const body = await req.json() as { square_tax_id?: string; chart_of_accounts_id?: string | null; excluded?: boolean };
    if (!body.square_tax_id) {
      return NextResponse.json({ error: "square_tax_id required" }, { status: 400 });
    }
    const patch: { chartOfAccountsId?: string | null; excluded?: boolean } = {};
    if ("chart_of_accounts_id" in body) patch.chartOfAccountsId = body.chart_of_accounts_id ?? null;
    if ("excluded" in body) patch.excluded = body.excluded;
    await setSalesTaxAccount(createSupabaseAdminClient(), body.square_tax_id, patch);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
