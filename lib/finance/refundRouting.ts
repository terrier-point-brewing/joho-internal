/**
 * Where a refund posts, when the default contra-revenue account is wrong.
 *
 * syncRefunds.ts pins every Square refund to one account — GL 4999 Sales
 * Returns & Refunds. That is correct whenever the sale being reversed was
 * revenue, and wrong whenever it was not. The taproom's Keg Deposit and Pump
 * Deposit items are mapped to GL 2420 Equipment Deposits, so taking a deposit
 * credits a liability; handing it back has to DEBIT that same liability, not
 * net against revenue the deposit never was.
 *
 * The rule is data, not code: `refund_gl_routing` says "a refund of something
 * coded to X posts to Y" and an operator states it in Settings → Finance → GL
 * Mapping → Refunds. See 20261013090001_refund_gl_routing.sql for why this is a
 * table rather than a special case for 2420.
 *
 * ── Routing is all-or-nothing, and that is a schema fact ─────────────────────
 * `square_refunds` carries ONE chart_of_accounts_id. A Square refund, meanwhile,
 * is a bare dollar amount against an order that may span several accounts —
 * Square attributes nothing to a line (see fetchSources.ts's fetchRefunds and
 * the unified-refunds migration). So this module can only ever answer "which
 * single account", and the honest way to answer it is to route only when the
 * whole refund demonstrably belongs to one routed account.
 *
 * The test for that is an EXACT amount match against the order's total for that
 * account, tax included. The real case it has to catch: on 2026-07-10 a $53.63
 * refund came off a $206.41 four-line order, and $53.63 is exactly the Pump
 * Deposit line ($50.00) plus its tax ($3.63) — the other three lines were not
 * refunded. Nothing looser would distinguish that from a partial refund of the
 * beer on the same ticket, and a wrong guess moves money onto a liability
 * account where it will sit unnoticed. Anything that does not match exactly
 * stays on the contra account, which is where it goes today.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";

/** source account id → the account its refunds post to instead of contra-revenue. */
export type RefundRoutingRules = Map<string, string>;

/** One sale line of the order a refund reverses, as the resolver needs it. */
export interface RoutableOrderLine {
  chartOfAccountsId: string | null;
  netSalesCents: number | null;
  taxCents: number | null;
}

/**
 * Active routing rules, keyed by source account.
 *
 * Degrades to an EMPTY MAP on any error — a missing table (this migration
 * unapplied in an environment that has the code) must leave refund coding
 * exactly as it was, never throw. Same contract as accruals.ts's
 * fetchTaxAccountMap, and for the same reason: refund sync runs in a cron and a
 * webhook, and failing the whole sync over an unconfigured rule would lose
 * refunds rather than mis-code one.
 */
export async function fetchRefundRoutingRules(supabase: SupabaseClient): Promise<RefundRoutingRules> {
  try {
    const rows = await fetchAllRows<{ source_chart_of_accounts_id: string; target_chart_of_accounts_id: string }>(() =>
      supabase
        .from("refund_gl_routing")
        .select("source_chart_of_accounts_id, target_chart_of_accounts_id")
        .eq("active", true)
        .order("id", { ascending: true }),
    );
    const map: RefundRoutingRules = new Map();
    for (const r of rows) map.set(r.source_chart_of_accounts_id, r.target_chart_of_accounts_id);
    return map;
  } catch {
    return new Map();
  }
}

/**
 * The account this refund posts to: a routed one when the refund is
 * unambiguously the whole of a routed account's share of the order, otherwise
 * the contra account the caller already resolved.
 *
 * Pure. `contraCoaId` is returned unchanged (including null) whenever nothing
 * matches, so a caller that has no rules configured behaves exactly as it did
 * before this module existed.
 *
 * AMBIGUITY LOSES. If two different routed accounts each total the refund
 * amount, there is no fact here that says which one came back, and picking
 * either would be a coin flip recorded as an accounting entry. Both are
 * declined and the refund stays on contra-revenue, where a human can see it.
 */
export function resolveRefundAccount(
  refundAmountCents: number,
  orderLines: RoutableOrderLine[],
  rules: RefundRoutingRules,
  contraCoaId: string | null,
): string | null {
  if (rules.size === 0 || refundAmountCents <= 0) return contraCoaId;

  // Total per routed source account, tax included — a deposit is refunded with
  // the tax that was charged on it (the $53.63 above is $50.00 + $3.63), so
  // comparing against the net alone would never match.
  const totalBySource = new Map<string, number>();
  for (const line of orderLines) {
    const coaId = line.chartOfAccountsId;
    if (!coaId || !rules.has(coaId)) continue;
    const cents = (line.netSalesCents ?? 0) + (line.taxCents ?? 0);
    totalBySource.set(coaId, (totalBySource.get(coaId) ?? 0) + cents);
  }

  const matches = [...totalBySource.entries()].filter(([, cents]) => cents === refundAmountCents);
  if (matches.length !== 1) return contraCoaId;

  return rules.get(matches[0][0]) ?? contraCoaId;
}

/**
 * The sale lines of every order named, keyed by `square_orders.id`.
 *
 * Reads `pos_line_items` rather than `invoice_line_items`: an invoice refund the
 * app issued already carries true per-line attribution through `refund_lines`
 * (see fetchSources.ts's fetchRefunds), so it needs no rule to be coded
 * correctly. This path exists for the refunds that have no line detail at all —
 * POS refunds and ones raised by hand in the Square dashboard.
 */
export async function fetchOrderLinesByOrder(
  supabase: SupabaseClient,
  orderDbIds: string[],
): Promise<Map<string, RoutableOrderLine[]>> {
  const byOrder = new Map<string, RoutableOrderLine[]>();
  if (orderDbIds.length === 0) return byOrder;

  const unique = [...new Set(orderDbIds)];
  const rows = await fetchAllRows<{
    order_id: string;
    chart_of_accounts_id: string | null;
    net_sales_cents: number | null;
    tax_cents: number | null;
  }>(() =>
    supabase
      .from("pos_line_items")
      .select("order_id, chart_of_accounts_id, net_sales_cents, tax_cents")
      .in("order_id", unique)
      .order("id", { ascending: true }),
  );

  for (const r of rows) {
    const list = byOrder.get(r.order_id);
    const line: RoutableOrderLine = {
      chartOfAccountsId: r.chart_of_accounts_id,
      netSalesCents: r.net_sales_cents,
      taxCents: r.tax_cents,
    };
    if (list) list.push(line);
    else byOrder.set(r.order_id, [line]);
  }
  return byOrder;
}
