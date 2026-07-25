/**
 * Canonical tax-rates registry (`tax_rates`, see lib/tax/rates.ts) — the
 * single source of excise/sales/local/transit rate values consumed by
 * production excise, the beer-excise party module, and the NC DOR Sales &
 * Use engine. Read-only; rate values are seeded/updated via migration.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { listTaxRates, type TaxRate } from "@/lib/tax/rates";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.taxRead); } catch (res) { return res as Response; }

  try {
    const { searchParams } = new URL(req.url);
    const sb = createSupabaseAdminClient();
    const category = (searchParams.get("category") ?? undefined) as TaxRate["category"] | undefined;
    return NextResponse.json(await listTaxRates(sb, { category }));
  } catch (err) {
    return apiError(err);
  }
}
