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
 * line: base = gross_sales_cents - discount_cents
 * (post-discount, pre-tax receipts), collected = amount_cents. Dedupes by
 * line_item_id, namespaced per source since the two tables' ids are unrelated.
 * Paged via fetchAllRows to dodge PostgREST's 1000-row cap. pageSize is
 * injectable for tests only.
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
    | { gross_sales_cents: number | null; discount_cents: number | null }
    | { gross_sales_cents: number | null; discount_cents: number | null }[]
    | null;
}

interface InvoiceTaxJoinRow {
  line_item_id: string;
  amount_cents: number | null;
  invoice_line_items:
    | { gross_sales_cents: number | null; discount_cents: number | null }
    | { gross_sales_cents: number | null; discount_cents: number | null }[]
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

  const posRows = await fetchAllRows<TaxJoinRow>(
    () =>
      sb
        .from("pos_line_item_taxes")
        .select(
          "line_item_id, amount_cents, pos_line_items!inner ( gross_sales_cents, discount_cents, square_orders!inner ( transaction_date ) )",
        )
        .eq("square_tax_id", squareTaxId)
        .gte("pos_line_items.square_orders.transaction_date", startTs)
        .lt("pos_line_items.square_orders.transaction_date", endExclusiveTs)
        .order("line_item_id", { ascending: true }),
    pageSize,
  );

  // Invoice-collected tax lives in a mirror table (migration 20260826). It is
  // wrapped because an unapplied migration must degrade to "no invoice tax"
  // rather than failing a filing worksheet outright. The POS source above is
  // deliberately NOT wrapped: that table exists, and a silent zero there would
  // corrupt the return.
  let invoiceRows: InvoiceTaxJoinRow[] = [];
  try {
    invoiceRows = await fetchAllRows<InvoiceTaxJoinRow>(
      () =>
        sb
          .from("invoice_line_item_taxes")
          .select(
            "line_item_id, amount_cents, invoice_line_items!inner ( gross_sales_cents, discount_cents, invoices!invoice_line_items_invoice_id_fkey!inner ( invoice_date, status ) )",
          )
          .eq("square_tax_id", squareTaxId)
          .neq("invoice_line_items.invoices.status", "voided")
          .gte("invoice_line_items.invoices.invoice_date", period.start)
          .lte("invoice_line_items.invoices.invoice_date", period.end)
          .order("line_item_id", { ascending: true }),
      pageSize,
    );
  } catch {
    invoiceRows = [];
  }

  const seen = new Set<string>();
  let baseCents = 0;
  let collectedCents = 0;

  // base = gross_sales_cents - discount_cents (post-discount, pre-tax
  // receipts). Deliberately NOT net_sales_cents - tax_cents: net_sales_cents
  // changes meaning when the sales-tax backfill runs, whereas gross/discount
  // do not, so this form is correct both before and after it.
  const add = (
    key: string,
    amount: number | null,
    parentRaw:
      | { gross_sales_cents: number | null; discount_cents: number | null }
      | { gross_sales_cents: number | null; discount_cents: number | null }[]
      | null,
  ) => {
    if (seen.has(key)) return;
    seen.add(key);
    const parent = Array.isArray(parentRaw) ? parentRaw[0] : parentRaw;
    if (!parent) return;
    baseCents += num(parent.gross_sales_cents) - num(parent.discount_cents);
    collectedCents += num(amount);
  };

  for (const row of posRows) add(`p:${row.line_item_id}`, row.amount_cents, row.pos_line_items);
  for (const row of invoiceRows) add(`i:${row.line_item_id}`, row.amount_cents, row.invoice_line_items);

  return { baseCents, collectedCents };
}
