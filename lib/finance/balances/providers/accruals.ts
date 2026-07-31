// Three balance providers MOVED from lib/finance/financials/{fetchSources,
// buildFinancials}.ts -- reparameterized to compute a single account's
// balance as of an arbitrary periodEnd instead of collapsing the whole
// cumulative-from-inception range onto one canonical-month record. Kept
// together because they were siblings in fetchSources.ts and share its fetch
// idioms (fetchAllRows pagination, degrade-on-missing-table guards).
//
// The originals (fetchTipAccruals/fetchTaxAccruals in fetchSources.ts,
// injectOpenInvoiceAr in buildFinancials.ts) are NOT deleted by this task --
// a later task retires them once the snapshot read path replaces the
// consolidated-financials balance-sheet mode.
//
// Sign: openInvoiceAr feeds an asset (1100) -- POSITIVE_SECTIONS, no flip.
// tipAccrual (2310) and taxAccrual (2220/2250) feed liabilities --
// NEGATIVE_SECTIONS in the internal convention (normalizeSign.ts), so both
// negate their (always-positive) collected-amount sum before returning.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { registerProvider } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";

/** Exclusive upper bound: the first instant after periodEnd's calendar day, UTC. Mirrors fetchSources.ts's own range.end construction. */
function exclusiveEnd(periodEnd: string): string {
  const d = new Date(`${periodEnd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

// ── openInvoiceAr ────────────────────────────────────────────────────────
// Moved from buildFinancials.ts's injectOpenInvoiceAr / fetchSources.ts's
// fetchOpenInvoiceAr: sum of invoices.total_cents where status = 'open' and
// invoice_date <= periodEnd. Point-in-time open-balance snapshot, not a
// period movement -- deliberately unbounded below.

async function fetchOpenInvoiceArCents(supabase: SupabaseClient, periodEnd: string): Promise<number> {
  const rows = await fetchAllRows<{ total_cents: number | null }>(() =>
    supabase
      .from("invoices")
      .select("total_cents")
      .eq("status", "open")
      .lte("invoice_date", periodEnd)
      .order("id", { ascending: true }),
  );
  return rows.reduce((s, inv) => s + (inv.total_cents ?? 0), 0);
}

export const openInvoiceAr: BalanceProvider = {
  key: "openInvoiceAr",
  label: "Open invoice A/R",
  kind: "derived",
  appliesTo: (coa) => coa.accountNumber === "1100",
  async compute(ctx: BalanceContext): Promise<number | null> {
    const cents = await fetchOpenInvoiceArCents(ctx.supabase, ctx.periodEnd);
    // Guarded on > 0 like the original injectOpenInvoiceAr -- a zero/negative
    // sum is indistinguishable from "no open invoices" and shouldn't
    // synthesize a balance row.
    if (cents <= 0) return null;
    // Asset account: POSITIVE_SECTIONS, no sign flip needed.
    return cents;
  },
};

// ── tipAccrual ───────────────────────────────────────────────────────────
// Moved from fetchSources.ts's fetchTipsAccountId / fetchTipAccruals.

/**
 * payroll_gl_settings.tips_chart_of_accounts_id (migration 20260823, may be
 * unapplied in prod). Degrades to null on ANY error -- missing column,
 * missing row, or any other Supabase error -- so an unapplied migration
 * never throws; it just leaves tip accruals off until the setting exists.
 */
async function fetchTipsAccountId(supabase: SupabaseClient): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("payroll_gl_settings")
      .select("tips_chart_of_accounts_id")
      .maybeSingle();
    if (error) return null;
    return (data as { tips_chart_of_accounts_id: string | null } | null)?.tips_chart_of_accounts_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Sum of square_orders.tip_cents where status = 'COMPLETED' and invoice_id is
 * null (the taproom basis), through periodEnd. The status filter is
 * load-bearing, not defensive: syncPosTransactions.ts keeps a CANCELED
 * order's header tip_cents intact and only withdraws its line items, so this
 * is the one financials source that isn't immune to canceled orders without
 * it -- every other source is immune already.
 */
async function fetchTipAccrualCents(supabase: SupabaseClient, periodEnd: string): Promise<number> {
  const rows = await fetchAllRows<{ tip_cents: number | null }>(() =>
    supabase
      .from("square_orders")
      .select("tip_cents")
      .eq("status", "COMPLETED")
      .is("invoice_id", null)
      .lt("transaction_date", exclusiveEnd(periodEnd))
      .order("id", { ascending: true }),
  );
  return rows.reduce((s, r) => s + (r.tip_cents ?? 0), 0);
}

export const tipAccrual: BalanceProvider = {
  key: "tipAccrual",
  label: "Collected card tips",
  kind: "derived",
  appliesTo: (coa) => coa.accountNumber === "2310",
  async compute(ctx: BalanceContext): Promise<number | null> {
    const tipsAccountId = await fetchTipsAccountId(ctx.supabase);
    // Never fail the balance sheet over an unconfigured/not-yet-migrated setting.
    if (!tipsAccountId) return null;

    const amountCents = await fetchTipAccrualCents(ctx.supabase, ctx.periodEnd);
    // Degenerate guard, ported verbatim: a would-be $0 (or negative, which
    // shouldn't happen but isn't trusted) balance is pointless, and negating
    // a negative sum here would read as MORE liability instead of none.
    if (amountCents <= 0) return null;
    // Liability account: internal convention is negative.
    return -amountCents;
  },
};

// ── taxAccrual ───────────────────────────────────────────────────────────
// Moved from fetchSources.ts's fetchTaxAccountMap / fetchTaxAccruals.

/**
 * square_tax_id -> chart_of_accounts_id, for taxes that have been mapped.
 * Degrades to an EMPTY MAP on any error -- a missing table (migration
 * 20260827 unapplied) must leave the balance sheet rendering exactly as it
 * did before, never throw. Same contract as fetchTipsAccountId's null.
 */
async function fetchTaxAccountMap(supabase: SupabaseClient): Promise<Map<string, string>> {
  try {
    const rows = await fetchAllRows<{ square_tax_id: string; chart_of_accounts_id: string | null }>(() =>
      supabase
        .from("square_tax_accounts")
        .select("square_tax_id, chart_of_accounts_id")
        .order("square_tax_id", { ascending: true }),
    );
    const map = new Map<string, string>();
    for (const r of rows) {
      if (r.chart_of_accounts_id) map.set(r.square_tax_id, r.chart_of_accounts_id);
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Collected sales tax through periodEnd, grouped per liability account.
 * Unions pos_line_item_taxes and invoice_line_item_taxes. The
 * pos_line_item_taxes COMPLETED filter is defensive rather than
 * load-bearing: those rows cascade from pos_line_items, whose rows are
 * deleted for canceled orders (syncPosTransactions.ts), so canceled tax
 * cannot survive -- unlike square_orders.tip_cents above.
 */
async function fetchTaxAccrualCentsByAccount(
  supabase: SupabaseClient,
  periodEnd: string,
  accountByTaxId: Map<string, string>,
): Promise<Map<string, number>> {
  const end = exclusiveEnd(periodEnd);

  const posRows = await fetchAllRows<{ square_tax_id: string; amount_cents: number | null }>(() =>
    supabase
      .from("pos_line_item_taxes")
      .select("square_tax_id, amount_cents, pos_line_items!inner ( square_orders!inner ( transaction_date, status ) )")
      .eq("pos_line_items.square_orders.status", "COMPLETED")
      .lt("pos_line_items.square_orders.transaction_date", end)
      .order("id", { ascending: true }),
  );

  // Wrapped: migration 20260826 may be unapplied. Degrade to POS-only -- but
  // only for that specific cause. Any other failure (a transient PostgREST
  // 5xx, a timeout) must propagate: silently returning zero invoice-collected
  // tax here would understate the balance-sheet liability with no signal to
  // the operator (mirrors fetchSources.ts's fetchTaxAccruals).
  let invoiceRows: { square_tax_id: string; amount_cents: number | null }[] = [];
  try {
    invoiceRows = await fetchAllRows<{ square_tax_id: string; amount_cents: number | null }>(() =>
      supabase
        .from("invoice_line_item_taxes")
        .select(
          "square_tax_id, amount_cents, invoice_line_items!inner ( invoices!invoice_line_items_invoice_id_fkey!inner ( invoice_date, status ) )",
        )
        .neq("invoice_line_items.invoices.status", "voided")
        .lte("invoice_line_items.invoices.invoice_date", periodEnd)
        .order("id", { ascending: true }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/does not exist|PGRST205|Could not find the table/i.test(msg)) throw err;
    invoiceRows = [];
  }

  const centsByAccount = new Map<string, number>();
  for (const r of [...posRows, ...invoiceRows]) {
    const coaId = accountByTaxId.get(r.square_tax_id);
    if (!coaId) continue;
    centsByAccount.set(coaId, (centsByAccount.get(coaId) ?? 0) + (r.amount_cents ?? 0));
  }
  return centsByAccount;
}

export const taxAccrual: BalanceProvider = {
  key: "taxAccrual",
  label: "Collected sales tax",
  kind: "derived",
  appliesTo: (coa) => coa.accountNumber === "2220" || coa.accountNumber === "2250",
  async compute(ctx: BalanceContext): Promise<number | null> {
    const accountByTaxId = await fetchTaxAccountMap(ctx.supabase);
    if (accountByTaxId.size === 0) return null;

    const centsByAccount = await fetchTaxAccrualCentsByAccount(ctx.supabase, ctx.periodEnd, accountByTaxId);
    const amountCents = centsByAccount.get(ctx.coaId) ?? 0;
    // Degenerate guard, ported verbatim: the original skips emitting a
    // record for a <= 0 account total rather than signing a negative sum
    // identically to a positive one.
    if (amountCents <= 0) return null;
    // Liability account: internal convention is negative.
    return -amountCents;
  },
};

registerProvider(openInvoiceAr);
registerProvider(tipAccrual);
registerProvider(taxAccrual);
