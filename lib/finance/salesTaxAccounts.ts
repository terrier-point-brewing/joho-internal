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
  excluded: boolean;
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
      sb.from(table).select("square_tax_id, tax_name, tax_pct").order("id", { ascending: true }),
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
      .select("square_tax_id, tax_name, tax_pct, chart_of_accounts_id, excluded, chart_of_accounts ( account_name, account_number )")
      .order("square_tax_id", { ascending: true }),
  );
  return rows.sort((a, b) => (a.tax_name ?? a.square_tax_id).localeCompare(b.tax_name ?? b.square_tax_id));
}

/**
 * Updates one tax's liability account and/or its excluded flag. Only the
 * fields present in `patch` are touched, so a settings-page toggle of one
 * never clobbers the other -- see the counterparty-mappings PATCH route,
 * which has the same "in body" split for the same reason.
 */
export async function setSalesTaxAccount(
  sb: SupabaseClient,
  squareTaxId: string,
  patch: { chartOfAccountsId?: string | null; excluded?: boolean },
): Promise<void> {
  const update: Record<string, unknown> = {};
  if ("chartOfAccountsId" in patch) update.chart_of_accounts_id = patch.chartOfAccountsId;
  if ("excluded" in patch) update.excluded = patch.excluded;

  // `updated_at` used to sit in this payload and doubled as the guarantee that
  // it was never empty. The trigger owns the timestamp now, so a patch carrying
  // neither field would send an empty body, which PostgREST rejects. Nothing to
  // write is not an error -- but the caller still gets the unknown-id check
  // below, so a bogus id fails the same way it would with a real edit.
  const { data, error } = Object.keys(update).length === 0
    ? await sb
        .from("square_tax_accounts")
        .select("square_tax_id")
        .eq("square_tax_id", squareTaxId)
    : await sb
        .from("square_tax_accounts")
        .update(update)
        .eq("square_tax_id", squareTaxId)
        .select("square_tax_id");
  if (error) throw new Error(error.message);
  // An UPDATE matching zero rows returns no PostgREST error -- without this
  // check the route would reply {ok:true} and the UI would show "saved" for a
  // mapping that was never written.
  if (!data || data.length === 0) throw new Error(`unknown square_tax_id: ${squareTaxId}`);
}
