/**
 * Shared Square tax-line base fetcher — one Square catalog tax's taxable base
 * and collected amount for a period, from synced POS data.
 *
 * Extracted from lib/tax/parties/ncDorSalesUse/calc.ts so more than one party
 * (NC DOR Sales & Use, Wake County Prepared Food & Beverage) shares the
 * identical join without importing across a sibling party's internals.
 *
 * Joins pos_line_item_taxes (filtered to one square_tax_id) -> pos_line_items
 * -> square_orders, ranged over transaction_date. Filtering to one tax id
 * yields exactly one tax row per qualifying line, so a single pass gives per
 * line: base = net_sales_cents - tax_cents (post-discount, pre-tax receipts),
 * collected = amount_cents. Dedupes by line_item_id. Paged via fetchAllRows to
 * dodge PostgREST's 1000-row cap. pageSize is injectable for tests only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysStr } from "@/lib/utils/datetime";
import { fetchAllRows } from "@/lib/supabase/paginate";
import type { TaxPeriod } from "@/lib/tax/types";

const num = (v: number | string | null | undefined) => Number(v ?? 0);

interface TaxJoinRow {
  line_item_id: string;
  amount_cents: number | null;
  pos_line_items:
    | { net_sales_cents: number | null; tax_cents: number | null }
    | { net_sales_cents: number | null; tax_cents: number | null }[]
    | null;
}

export async function fetchTaxableBase(
  sb: SupabaseClient,
  squareTaxId: string,
  period: TaxPeriod,
  pageSize?: number,
): Promise<{ baseCents: number; collectedCents: number }> {
  const startTs = `${period.start}T00:00:00Z`;
  const endExclusiveTs = `${addDaysStr(period.end, 1)}T00:00:00Z`;

  const data = await fetchAllRows<TaxJoinRow>(
    () =>
      sb
        .from("pos_line_item_taxes")
        .select(
          "line_item_id, amount_cents, pos_line_items!inner ( net_sales_cents, tax_cents, square_orders!inner ( transaction_date ) )",
        )
        .eq("square_tax_id", squareTaxId)
        .gte("pos_line_items.square_orders.transaction_date", startTs)
        .lt("pos_line_items.square_orders.transaction_date", endExclusiveTs)
        .order("line_item_id", { ascending: true }),
    pageSize,
  );

  const seen = new Set<string>();
  let baseCents = 0;
  let collectedCents = 0;
  for (const row of data) {
    if (seen.has(row.line_item_id)) continue;
    seen.add(row.line_item_id);
    const pliRaw = row.pos_line_items;
    const pli = Array.isArray(pliRaw) ? pliRaw[0] : pliRaw;
    if (!pli) continue;
    baseCents += num(pli.net_sales_cents) - num(pli.tax_cents);
    collectedCents += num(row.amount_cents);
  }
  return { baseCents, collectedCents };
}
