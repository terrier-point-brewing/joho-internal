/**
 * Thin passthrough of Square's catalog taxes, trimmed to the shape the Tax
 * Filing settings identity form needs to populate a `general_sales_tax_id`
 * select (lib/tax/parties/ncDorSalesUse's settingsSchema declares that field
 * as type "select" with no static `options` — its options are these live
 * Square catalog taxes, not part of the party template).
 */
import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { apiError } from "@/lib/utils/api";
import { fetchCatalogTaxes } from "@/lib/square/catalog";

export const dynamic = "force-dynamic";

export interface SquareTaxOption {
  id: string;
  name: string;
  percentage: string | null;
}

export async function GET() {
  try { await requirePermission(CAP.taxRead); } catch (res) { return res as Response; }

  try {
    const taxes = await fetchCatalogTaxes();
    const options: SquareTaxOption[] = taxes.map((tax) => ({
      id: tax.id,
      name: tax.tax_data.name,
      percentage: tax.tax_data.percentage ?? null,
    }));
    return NextResponse.json(options);
  } catch (err) {
    return apiError(err);
  }
}
