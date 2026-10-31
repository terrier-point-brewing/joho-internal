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
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { defaultYearRange } from "@/lib/finance/dateRange";
import { dayRangeUtc } from "@/lib/utils/datetime";
import { getBreweryTimezone } from "@/lib/settings/breweryTimezone.server";
import { extractVoidedLineItems, type VoidedLineItem } from "@/lib/finance/voidedLineItems";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsRead); } catch (res) { return res as Response; }

  const { searchParams } = req.nextUrl;
  const { from: defYearFrom, to: defYearTo } = defaultYearRange();
  const startDate = searchParams.get("from") ?? defYearFrom;
  const endDate   = searchParams.get("to")   ?? defYearTo;
  const page     = Math.max(1, Number(searchParams.get("page") ?? 1));
  const pageSize = Math.min(200, Math.max(10, Number(searchParams.get("pageSize") ?? 50)));

  const from      = (page - 1) * pageSize;
  const to        = from + pageSize - 1;

  // `transaction_date` is a timestamptz (the order's closed_at). Comparing it to
  // a bare YYYY-MM-DD compares against 00:00 UTC, which is 8pm the previous
  // evening in Raleigh — so a range ending on day D silently dropped every order
  // D closed after midnight UTC, and Friday-night tabs settled after 8pm local
  // vanished from a Friday view. Bound the range by brewery-local day edges.
  const tz = await getBreweryTimezone();
  const { startUtc, endUtc } = dayRangeUtc(startDate, endDate, tz);

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
        gl_manually_set,
        notes,
        chart_of_accounts ( id, account_name, account_number, account_type )
      )
    `, { count: "exact" })
    .is("invoice_id", null)
    .gte("transaction_date", startUtc)
    .lte("transaction_date", endUtc)
    .order("transaction_date", { ascending: false })
    .range(from, to);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // For line items without a manual CoA override, prefill from account mapping
  const variationIds = (data ?? [])
    .flatMap((t) => (t.pos_line_items ?? []).map((li) => li.square_variation_id))
    .filter((v): v is string => !!v && true);

  const uniqueVarIds = [...new Set(variationIds)];
  const mappingLookup: Record<string, { id: string; account_name: string; account_number: string | null; account_type: string }> = {};
  // Variations a person marked "excluded" on Settings > GL Mapping > Revenue.
  // Such a line will never get an account, so the tab must not keep counting
  // it as unmapped — the same "mapped or excluded = resolved" rule the GL
  // Mapping coverage count already applies.
  const excludedVariations = new Set<string>();

  if (uniqueVarIds.length > 0) {
    // The variation row has THREE FKs to chart_of_accounts (default / POS /
    // invoice), so a bare `chart_of_accounts(...)` embed is ambiguous and
    // PostgREST rejects the whole query. That error used to be swallowed, and
    // every line without its own account silently read as unmapped. Resolve
    // the POS account the same way the sync does: the POS-specific column
    // first, then the default.
    const { data: mappings, error: mapErr } = await supabase
      .from("square_catalog_variations")
      .select(`
        square_variation_id, excluded, chart_of_accounts_id, chart_of_accounts_id_pos,
        coa_default:chart_of_accounts!square_catalog_variations_chart_of_accounts_id_fkey ( id, account_name, account_number, account_type ),
        coa_pos:chart_of_accounts!square_catalog_variations_chart_of_accounts_id_pos_fkey ( id, account_name, account_number, account_type )
      `)
      .in("square_variation_id", uniqueVarIds)
      .or("chart_of_accounts_id.not.is.null,chart_of_accounts_id_pos.not.is.null,excluded.eq.true");
    if (mapErr) console.error("[transactions] variation mapping lookup failed:", mapErr.message);

    type CoaRef = { id: string; account_name: string; account_number: string | null; account_type: string };
    const one = (v: unknown): CoaRef | null => (Array.isArray(v) ? (v[0] ?? null) : (v as CoaRef | null));
    for (const m of mappings ?? []) {
      if (!m.square_variation_id) continue;
      if (m.excluded) excludedVariations.add(m.square_variation_id);
      const coa = one(m.coa_pos) ?? one(m.coa_default);
      if (coa) mappingLookup[m.square_variation_id] = coa;
    }
  }

  const enriched = (data ?? []).map((txn) => ({
    ...txn,
    voided_line_items: [] as VoidedLineItem[],
    pos_line_items: (txn.pos_line_items ?? []).map((li) => {
      const prefill = li.square_variation_id ? mappingLookup[li.square_variation_id] : null;
      const effectiveId = li.chart_of_accounts_id ?? prefill?.id ?? null;
      return {
        ...li,
        // effective_coa = the line's own account > account mapping prefill
        effective_chart_of_accounts_id:   effectiveId,
        effective_chart_of_accounts:       li.chart_of_accounts ?? prefill ?? null,
        // "Came from a rule, not a person." The sync writes the catalog mapping
        // into chart_of_accounts_id, so a populated column is NOT evidence of a
        // human choice — gl_manually_set is the only thing that is.
        prefilled_from_mapping:            !li.gl_manually_set && !!effectiveId,
        // Resolved without an account: the variation is excluded from mapping
        // and nobody overrode that on this line.
        mapping_excluded:                  !effectiveId && !!li.square_variation_id && excludedVariations.has(li.square_variation_id),
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
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
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
