/**
 * square_tax_accounts — maps each Square catalog tax to the balance-sheet
 * liability account its collections are credited to.
 *
 * Collected sales tax is money held for NC DOR / Wake County, not revenue.
 * Which authority a given Square tax belongs to is a business decision, so the
 * map is user-editable (Finance > Settings > Sales Tax Accounts) rather than
 * hardcoded.
 *
 * Rows SEED THEMSELVES from observed pos_line_item_taxes / invoice_line_item_taxes,
 * following the counterparty-rules precedent: a tax that starts appearing in
 * Square shows up in settings with a null account instead of being silently
 * dropped from the balance sheet.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";

export interface SalesTaxAccountRow {
  square_tax_id: string;
  tax_name: string | null;
  tax_pct: number | null;
  chart_of_accounts_id: string | null;
  chart_of_accounts: { account_name: string; account_number: string | null } | null;
}

interface ObservedTax {
  square_tax_id: string;
  tax_name: string | null;
  tax_pct: number | null;
}

/** Distinct taxes seen in a tax table. Invoice source degrades to [] if its table is missing. */
async function observedTaxes(sb: SupabaseClient, table: string, tolerateMissing: boolean): Promise<ObservedTax[]> {
  try {
    const rows = await fetchAllRows<ObservedTax>(() =>
      sb.from(table).select("square_tax_id, tax_name, tax_pct").order("line_item_id", { ascending: true }),
    );
    const byId = new Map<string, ObservedTax>();
    for (const r of rows) if (!byId.has(r.square_tax_id)) byId.set(r.square_tax_id, r);
    return [...byId.values()];
  } catch (err) {
    if (tolerateMissing) return [];
    throw err;
  }
}

/**
 * Every mapping row, seeding any observed-but-unseeded tax first. Ordered by
 * tax_name so the settings table is stable.
 */
export async function listSalesTaxAccounts(sb: SupabaseClient): Promise<SalesTaxAccountRow[]> {
  const existing = await fetchAllRows<{ square_tax_id: string }>(() =>
    sb.from("square_tax_accounts").select("square_tax_id").order("square_tax_id", { ascending: true }),
  );
  const known = new Set(existing.map((r) => r.square_tax_id));

  const [pos, invoice] = await Promise.all([
    observedTaxes(sb, "pos_line_item_taxes", false),
    observedTaxes(sb, "invoice_line_item_taxes", true),
  ]);

  const toSeed = new Map<string, ObservedTax>();
  for (const t of [...pos, ...invoice]) {
    if (!known.has(t.square_tax_id) && !toSeed.has(t.square_tax_id)) toSeed.set(t.square_tax_id, t);
  }

  if (toSeed.size > 0) {
    const { error } = await sb.from("square_tax_accounts").insert(
      [...toSeed.values()].map((t) => ({
        square_tax_id: t.square_tax_id,
        tax_name: t.tax_name,
        tax_pct: t.tax_pct,
        chart_of_accounts_id: null,
      })),
    );
    if (error) throw new Error(error.message);
  }

  // Paged on the PRIMARY KEY, not tax_name: tax_name is nullable and
  // non-unique, and an unstable sort key makes fetchAllRows' range paging drop
  // or duplicate rows. Display order is applied in JS afterwards.
  const rows = await fetchAllRows<SalesTaxAccountRow>(() =>
    sb
      .from("square_tax_accounts")
      .select("square_tax_id, tax_name, tax_pct, chart_of_accounts_id, chart_of_accounts ( account_name, account_number )")
      .order("square_tax_id", { ascending: true }),
  );
  return rows.sort((a, b) => (a.tax_name ?? a.square_tax_id).localeCompare(b.tax_name ?? b.square_tax_id));
}

/** Points one tax at a liability account, or clears it with null. */
export async function setSalesTaxAccount(
  sb: SupabaseClient,
  squareTaxId: string,
  chartOfAccountsId: string | null,
): Promise<void> {
  const { error } = await sb
    .from("square_tax_accounts")
    .update({ chart_of_accounts_id: chartOfAccountsId, updated_at: new Date().toISOString() })
    .eq("square_tax_id", squareTaxId);
  if (error) throw new Error(error.message);
}
