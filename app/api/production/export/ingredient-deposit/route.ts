import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  calculateShippedIngredientDeposits,
  shippedDepositDescription,
} from "@/lib/production/exportIngredientDeposit";

export const dynamic = "force-dynamic";

/**
 * Ingredient-deposit lines for a shipment being billed as contract brewing.
 *
 * Deliberately NOT folded into buildInvoicePreview: a shipment that already has
 * a real contract-brewing allocation was deposited up front, and adding a line
 * to every contract-brewing invoice would charge those partners twice. This is
 * the operator saying "this one was converted from distribution and never paid
 * a deposit", so it is a button, not a default.
 */
export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const idsParam = req.nextUrl.searchParams.get("ids");
  const ids = idsParam ? idsParam.split(",").filter(Boolean) : [];

  const supabase = createSupabaseAdminClient();
  try {
    const { lines, warnings } = await calculateShippedIngredientDeposits(supabase, ids);

    // The Square item to bill it against — same mapping the allocation deposit
    // resolves, partner override first, then the default.
    const { data: txs } = await supabase
      .from("export_transactions")
      .select("recipient_id")
      .in("id", ids)
      .limit(1);
    const partnerId = txs?.[0]?.recipient_id ?? null;

    const { data: mappingRows, error: mappingErr } = await supabase
      .from("invoice_item_mappings")
      .select("partner_id, square_catalog_variation_id, display_name")
      .eq("service_type", "ingredient_deposit")
      .or(partnerId ? `partner_id.eq.${partnerId},partner_id.is.null` : "partner_id.is.null");
    if (mappingErr) return NextResponse.json({ error: mappingErr.message }, { status: 500 });

    const mapping =
      (mappingRows ?? []).find((m) => m.partner_id === partnerId)
      ?? (mappingRows ?? []).find((m) => m.partner_id === null);
    if (!mapping?.square_catalog_variation_id) {
      return NextResponse.json(
        { error: "Ingredient Deposit is not configured in Deposit Settings — set the Square item mapping before charging it." },
        { status: 422 },
      );
    }

    return NextResponse.json({
      lineItems: lines.map((line) => ({
        id: crypto.randomUUID(),
        description: shippedDepositDescription(line),
        quantity: 1,
        unitPriceCents: line.depositCents,
        squareCatalogVariationId: mapping.square_catalog_variation_id,
      })),
      derivations: lines,
      warnings,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
