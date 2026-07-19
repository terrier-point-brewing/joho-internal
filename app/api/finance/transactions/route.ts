/**
 * GET /api/finance/transactions?from=YYYY-MM-DD&to=YYYY-MM-DD&page=N&pageSize=N
 *
 * Returns paginated square_orders (POS only) joined with their pos_line_items
 * (including prefilled CoA from account mapping when no manual override exists).
 *
 * PATCH /api/finance/transactions — { id, unmapped_accepted } to mark an
 * order's unmapped line items as reviewed/dismissed without mapping them.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { defaultYearRange } from "@/lib/finance/dateRange";
import { extractVoidedLineItems, type VoidedLineItem } from "@/lib/finance/voidedLineItems";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requireRole(["viewer"]); } catch (res) { return res as Response; }

  const { searchParams } = req.nextUrl;
  const { from: defYearFrom, to: defYearTo } = defaultYearRange();
  const startDate = searchParams.get("from") ?? defYearFrom;
  const endDate   = searchParams.get("to")   ?? defYearTo;
  const page     = Math.max(1, Number(searchParams.get("page") ?? 1));
  const pageSize = Math.min(200, Math.max(10, Number(searchParams.get("pageSize") ?? 50)));

  const from      = (page - 1) * pageSize;
  const to        = from + pageSize - 1;

  const supabase = createSupabaseAdminClient();

  const { data, error, count } = await supabase
    .from("square_orders")
    .select(`
      id,
      square_order_id,
      location_id,
      transaction_date,
      customer_name,
      total_cents,
      tax_cents,
      tip_cents,
      discount_cents,
      status,
      notes,
      unmapped_accepted,
      pos_line_items (
        id,
        square_line_item_uid,
        square_variation_id,
        name,
        variation_name,
        quantity,
        base_price_cents,
        gross_sales_cents,
        discount_cents,
        net_sales_cents,
        tax_cents,
        chart_of_accounts_id,
        notes,
        chart_of_accounts ( id, account_name, account_number, account_type )
      )
    `, { count: "exact" })
    .is("invoice_id", null)
    .gte("transaction_date", startDate)
    .lte("transaction_date", endDate)
    .order("transaction_date", { ascending: false })
    .range(from, to);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // For line items without a manual CoA override, prefill from account mapping
  const variationIds = (data ?? [])
    .flatMap((t) => (t.pos_line_items ?? []).map((li) => li.square_variation_id))
    .filter((v): v is string => !!v && true);

  const uniqueVarIds = [...new Set(variationIds)];
  const mappingLookup: Record<string, { id: string; account_name: string; account_number: string | null; account_type: string }> = {};

  if (uniqueVarIds.length > 0) {
    const { data: mappings } = await supabase
      .from("square_catalog_variations")
      .select("square_variation_id, chart_of_accounts_id, chart_of_accounts ( id, account_name, account_number, account_type )")
      .in("square_variation_id", uniqueVarIds)
      .not("chart_of_accounts_id", "is", null);

    for (const m of mappings ?? []) {
      if (m.square_variation_id && m.chart_of_accounts) {
        const coa = Array.isArray(m.chart_of_accounts) ? m.chart_of_accounts[0] : m.chart_of_accounts;
        if (coa) mappingLookup[m.square_variation_id] = coa as { id: string; account_name: string; account_number: string | null; account_type: string };
      }
    }
  }

  const enriched = (data ?? []).map((txn) => ({
    ...txn,
    voided_line_items: [] as VoidedLineItem[],
    pos_line_items: (txn.pos_line_items ?? []).map((li) => {
      const prefill = li.square_variation_id ? mappingLookup[li.square_variation_id] : null;
      return {
        ...li,
        // effective_coa = manual override > account mapping prefill
        effective_chart_of_accounts_id:   li.chart_of_accounts_id ?? prefill?.id ?? null,
        effective_chart_of_accounts:       li.chart_of_accounts ?? prefill ?? null,
        prefilled_from_mapping:            !li.chart_of_accounts_id && !!prefill,
      };
    }),
  }));

  // Canceled orders are stored without pos_line_items (so they stay out of the
  // P&L / tax base — see lib/finance/voidedLineItems.ts). Reconstruct their voided
  // line items read-only from raw_data purely for the ledger record. Targeted
  // second query so the common (completed-order) path stays lean.
  const canceledEmpty = enriched.filter(
    (t) => t.status === "CANCELED" && t.pos_line_items.length === 0,
  );
  if (canceledEmpty.length > 0) {
    const { data: rawRows } = await supabase
      .from("square_orders")
      .select("id, raw_data")
      .in("id", canceledEmpty.map((t) => t.id));
    const rawById = new Map((rawRows ?? []).map((r) => [r.id, r.raw_data]));
    for (const txn of canceledEmpty) {
      txn.voided_line_items = extractVoidedLineItems(rawById.get(txn.id));
    }
  }

  return NextResponse.json({ transactions: enriched, total: count ?? 0, page, pageSize });
}

export async function PATCH(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }
  const body = await req.json() as { id: string; unmapped_accepted: boolean };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("square_orders")
    .update({ unmapped_accepted: body.unmapped_accepted })
    .eq("id", body.id)
    .select("id, unmapped_accepted")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
