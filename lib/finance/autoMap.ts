/**
 * Retroactive auto-mapping. One home for "fill the account on already-ingested,
 * still-unmapped rows" across all four finance sources. Pure resolvers decide the
 * updates (unit-tested); thin IO wrappers fetch rows + rules and apply the writes.
 *
 * Every resolver is fill-nulls-only and never touches a manual pin — the same
 * convention the ingest paths and the (soon thin) manual-button routes follow.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** Apply per-row CoA updates in bounded parallel chunks. Returns { mapped, errors? }. */
async function applyLineItemUpdates(
  supabase: AdminClient,
  table: "pos_line_items" | "invoice_line_items" | "ramp_bank_ledger",
  updates: { id: string; chart_of_accounts_id: string }[],
  extra?: Record<string, unknown>,
): Promise<{ mapped: number; errors?: string[] }> {
  if (updates.length === 0) return { mapped: 0 };
  const CHUNK = 100;
  let mapped = 0;
  const errors: string[] = [];
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    const results = await Promise.allSettled(
      chunk.map((u) =>
        supabase.from(table).update({ chart_of_accounts_id: u.chart_of_accounts_id, ...extra }).eq("id", u.id),
      ),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && !r.value.error) mapped++;
      else if (r.status === "rejected") errors.push(String(r.reason));
      else if (r.status === "fulfilled" && r.value.error) errors.push(r.value.error.message);
    }
  }
  return { mapped, errors: errors.length ? errors : undefined };
}

/**
 * The key a counterparty rule is looked up by. A rule belongs to ONE bank feed:
 * expense_counterparty_mappings is unique on (source, counterparty_key), and the
 * same payee name arriving on two accounts is two rules with two accounts. Look
 * a row up by its name alone and a Chase transaction silently inherits the
 * account someone chose for the Ramp payee of the same name.
 */
export function counterpartyRuleKey(source: string, counterpartyKey: string): string {
  return `${source} ${counterpartyKey}`;
}

/** Bank-ledger rows: map from counterparty rules, preserving manual + existing. */
export function resolveBankBackfill(
  rows: { id: string; source: string; counterparty_key: string | null; mapping_source: string; chart_of_accounts_id: string | null }[],
  counterpartyRules: Map<string, string>,
): { id: string; chart_of_accounts_id: string }[] {
  const updates: { id: string; chart_of_accounts_id: string }[] = [];
  for (const row of rows) {
    if (row.mapping_source === "manual") continue;
    if (row.chart_of_accounts_id) continue;
    if (!row.counterparty_key) continue;
    const coaId = counterpartyRules.get(counterpartyRuleKey(row.source, row.counterparty_key));
    if (coaId) updates.push({ id: row.id, chart_of_accounts_id: coaId });
  }
  return updates;
}

/** POS line items: map from catalog-variation → CoA. */
export function resolvePosBackfill(
  lineItems: { id: string; square_variation_id: string | null }[],
  coaByVarId: Map<string, string>,
): { id: string; chart_of_accounts_id: string }[] {
  const updates: { id: string; chart_of_accounts_id: string }[] = [];
  for (const li of lineItems) {
    if (!li.square_variation_id) continue;
    const coaId = coaByVarId.get(li.square_variation_id);
    if (coaId) updates.push({ id: li.id, chart_of_accounts_id: coaId });
  }
  return updates;
}

/** A line item, as far as the label index cares. */
export interface InvoiceLabelSource {
  line_item_name: string | null;
  variation_name?: string | null;
  note: string | null;
}

/**
 * The text key a line is matched on when it has no catalog variation to match by.
 *
 * Catalog-backed lines compose it from the atoms Square gave us, which is exactly
 * the shape `autoMapInvoiceLineItems` builds its catalog-variation index under
 * ("Item Name — Variation Name"). Manual lines have no catalog identity, so their
 * note IS the label. This used to read a stored `description` column that held
 * the same two things; composing on demand means the key cannot go stale when an
 * item is renamed in the catalog.
 */
export function invoiceLineLabel(item: InvoiceLabelSource): string | null {
  if (item.line_item_name) {
    return item.variation_name
      ? `${item.line_item_name} — ${item.variation_name}`
      : item.line_item_name;
  }
  return item.note;
}

/**
 * Invoice line items: map from the line's own catalog variation id first (the
 * reliable key — a line carries its Square variation even when its label is
 * free text), falling back to a label(lowercased) → CoA index for
 * manual/QuickBooks lines that have no variation.
 */
export function resolveInvoiceBackfill(
  allItems: (InvoiceLabelSource & { id: string; square_catalog_variation_id?: string | null; chart_of_accounts_id: string | null })[],
  descToCoa: Map<string, string>,
  coaByVarId?: Map<string, string>,
): { id: string; chart_of_accounts_id: string }[] {
  const updates: { id: string; chart_of_accounts_id: string }[] = [];
  for (const item of allItems) {
    if (item.chart_of_accounts_id) continue;
    const byVar = item.square_catalog_variation_id ? coaByVarId?.get(item.square_catalog_variation_id) : undefined;
    if (byVar) { updates.push({ id: item.id, chart_of_accounts_id: byVar }); continue; }
    const label = invoiceLineLabel(item);
    if (!label) continue;
    const coaId = descToCoa.get(label.trim().toLowerCase());
    if (coaId) updates.push({ id: item.id, chart_of_accounts_id: coaId });
  }
  return updates;
}

/**
 * IO wrapper for `POST /api/finance/transactions/auto-map`. Reproduces the
 * route's query logic exactly, adding an optional `variationIds` narrowing
 * used by the rule-edit trigger (Tasks 6–7).
 *
 * Fills `chart_of_accounts_id` from the catalog mapping — a RULE, not a human
 * decision. It must never set `pos_line_items.gl_manually_set`: that flag is
 * what lets the financials tell a person's override apart from a rule, and the
 * Orders grid PATCH is its only writer.
 */
export async function autoMapPosLineItems(
  supabase: AdminClient,
  opts: { year: number; variationIds?: string[] },
): Promise<{ mapped: number; errors?: string[] }> {
  const startDate = `${opts.year}-01-01`;
  const endDate   = `${opts.year + 1}-01-01`;

  const { data: orders, error: ordersErr } = await supabase
    .from("square_orders")
    .select("id")
    .gte("transaction_date", startDate)
    .lt("transaction_date", endDate)
    .is("invoice_id", null);
  if (ordersErr) throw new Error(ordersErr.message);
  const orderIds = (orders ?? []).map((o) => o.id);
  if (orderIds.length === 0) return { mapped: 0 };

  // Chunk the order-id filter: a full year can have thousands of orders, and a
  // single .in() with that many UUIDs overflows PostgREST's request-URI length
  // (400 Bad Request). Accumulate unmapped line items across bounded batches.
  const ORDER_ID_CHUNK = 200;
  const lineItems: { id: string; square_variation_id: string | null }[] = [];
  for (let i = 0; i < orderIds.length; i += ORDER_ID_CHUNK) {
    let liQuery = supabase
      .from("pos_line_items")
      .select("id, square_variation_id")
      .is("chart_of_accounts_id", null)
      .not("square_variation_id", "is", null)
      .in("order_id", orderIds.slice(i, i + ORDER_ID_CHUNK));
    if (opts.variationIds && opts.variationIds.length > 0) {
      liQuery = liQuery.in("square_variation_id", opts.variationIds);
    }
    const { data, error: liErr } = await liQuery;
    if (liErr) throw new Error(liErr.message);
    if (data) lineItems.push(...data);
  }
  if (lineItems.length === 0) return { mapped: 0 };

  const varIds = opts.variationIds && opts.variationIds.length > 0
    ? opts.variationIds
    : [...new Set(lineItems.map((li) => li.square_variation_id as string))];
  const { data: mappings, error: mapErr } = await supabase
    .from("square_catalog_variations")
    .select("square_variation_id, chart_of_accounts_id")
    .in("square_variation_id", varIds)
    .not("chart_of_accounts_id", "is", null);
  if (mapErr) throw new Error(mapErr.message);

  const coaByVarId = new Map<string, string>(
    (mappings ?? []).map((m) => [m.square_variation_id as string, m.chart_of_accounts_id as string]),
  );
  const updates = resolvePosBackfill(lineItems, coaByVarId);
  return applyLineItemUpdates(supabase, "pos_line_items", updates);
}

/**
 * IO wrapper for `POST /api/finance/ledger/invoices/auto-map`. Reproduces the
 * route's two-source label index (mapped siblings + catalog-variation
 * mappings), adding an optional `variationIds` narrowing that restricts which
 * variation-derived labels are added to the index.
 */
export async function autoMapInvoiceLineItems(
  supabase: AdminClient,
  opts: { year: number; variationIds?: string[] },
): Promise<{ mapped: number; errors?: string[] }> {
  const { data: allItems, error } = await supabase
    .from("invoice_line_items")
    .select("id, line_item_name, variation_name, note, square_catalog_variation_id, chart_of_accounts_id, invoices!invoice_line_items_invoice_id_fkey!inner(invoice_date)")
    .gte("invoices.invoice_date", `${opts.year}-01-01`)
    .lte("invoices.invoice_date", `${opts.year}-12-31`);
  if (error) throw new Error(error.message);
  if (!allItems || allItems.length === 0) return { mapped: 0 };

  const descToCoa = new Map<string, string>();
  // Variation-primary index: a line's own catalog variation → CoA (takes priority
  // over the label). Built from the same variation rows the label index uses.
  const coaByVarId = new Map<string, string>();
  // Source 1: label → CoA from already-mapped siblings.
  for (const item of allItems) {
    const label = invoiceLineLabel(item);
    if (item.chart_of_accounts_id && label) {
      descToCoa.set(label.trim().toLowerCase(), item.chart_of_accounts_id as string);
    }
  }
  // Source 2: catalog variation mappings, keyed "item_name — variation_name" and plain item_name.
  let varQuery = supabase
    .from("square_catalog_variations")
    .select("square_variation_id, variation_name, chart_of_accounts_id, chart_of_accounts_id_invoice, square_catalog_items ( item_name )")
    .or("chart_of_accounts_id.not.is.null,chart_of_accounts_id_invoice.not.is.null");
  if (opts.variationIds && opts.variationIds.length > 0) {
    varQuery = varQuery.in("square_variation_id", opts.variationIds);
  }
  const { data: variations } = await varQuery;
  for (const v of variations ?? []) {
    const coaId = (v.chart_of_accounts_id_invoice ?? v.chart_of_accounts_id) as string | null;
    if (!coaId) continue;
    if (v.square_variation_id) coaByVarId.set(v.square_variation_id as string, coaId);
    const itemName = (v.square_catalog_items as unknown as { item_name: string } | null)?.item_name;
    if (!itemName) continue;
    const key = `${itemName} — ${v.variation_name}`.trim().toLowerCase();
    if (!descToCoa.has(key)) descToCoa.set(key, coaId);
    const plainKey = itemName.trim().toLowerCase();
    if (!descToCoa.has(plainKey)) descToCoa.set(plainKey, coaId);
  }

  const updates = resolveInvoiceBackfill(allItems, descToCoa, coaByVarId);
  return applyLineItemUpdates(supabase, "invoice_line_items", updates);
}

/**
 * IO wrapper for `POST /api/finance/expenses/auto-map`. Reproduces the
 * route's per-rule bulk update, adding an optional `externalAccountId`
 * narrowing.
 */
export async function autoMapExpenses(
  supabase: AdminClient,
  opts: { from: string; to: string; externalAccountId?: string },
): Promise<{ mapped: number }> {
  let ruleQuery = supabase
    .from("expense_account_mappings")
    .select("source, external_account_id, chart_of_accounts_id")
    .not("chart_of_accounts_id", "is", null);
  if (opts.externalAccountId) ruleQuery = ruleQuery.eq("external_account_id", opts.externalAccountId);
  const { data: rules, error: ruleErr } = await ruleQuery;
  if (ruleErr) throw new Error(ruleErr.message);

  let mapped = 0;
  for (const rule of rules ?? []) {
    const { data: affected, error } = await supabase
      .from("expenses")
      .update({ chart_of_accounts_id: rule.chart_of_accounts_id, mapping_source: "rule" })
      .eq("source", rule.source)
      .eq("external_account_id", rule.external_account_id)
      .neq("mapping_source", "manual")
      .is("chart_of_accounts_id", null)
      .gte("accounting_date", opts.from)
      .lte("accounting_date", opts.to)
      .select("id");
    if (error) throw new Error(error.message);
    mapped += affected?.length ?? 0;
  }
  return { mapped };
}

/**
 * Retroactive counterpart to Task 2's ingest-time bank-ledger mapping: fills
 * `chart_of_accounts_id` on already-ingested, still-unmapped, non-manual rows
 * from `expense_counterparty_mappings` rules.
 */
export async function autoMapBankLedger(
  supabase: AdminClient,
  opts: { from: string; to: string; counterpartyKey?: string; source?: string },
): Promise<{ mapped: number; errors?: string[] }> {
  // include_in_gl: a row the books deliberately ignore must not be quietly
  // given an account by a counterparty rule. Coding it would change nothing
  // today, since every general-ledger reader filters the same flag, but it would
  // mean the moment anyone opted a source in, a backlog of rows would already
  // be mapped by a rule nobody applied to them on purpose.
  let rowQuery = supabase
    .from("ramp_bank_ledger")
    .select("id, source, counterparty_key, mapping_source, chart_of_accounts_id")
    .is("chart_of_accounts_id", null)
    .eq("include_in_gl", true)
    .neq("mapping_source", "manual")
    .gte("transaction_date", opts.from)
    .lte("transaction_date", opts.to);
  if (opts.counterpartyKey) rowQuery = rowQuery.eq("counterparty_key", opts.counterpartyKey);
  if (opts.source)          rowQuery = rowQuery.eq("source", opts.source);
  const { data: rows, error } = await rowQuery;
  if (error) throw new Error(error.message);
  if (!rows || rows.length === 0) return { mapped: 0 };

  // Rules are fetched for every feed, not just Ramp, and matched to a row by
  // (feed, counterparty). The old `.eq("source","ramp")` was correct only while
  // Ramp was the sole writer of this table: it would have handed a Chase row the
  // account a bookkeeper chose for the Ramp payee of the same name, which is the
  // one conflation the (source, counterparty_key) rule identity exists to stop.
  let cpQuery = supabase
    .from("expense_counterparty_mappings")
    .select("source, counterparty_key, chart_of_accounts_id")
    .not("chart_of_accounts_id", "is", null);
  if (opts.counterpartyKey) cpQuery = cpQuery.eq("counterparty_key", opts.counterpartyKey);
  if (opts.source)          cpQuery = cpQuery.eq("source", opts.source);
  const { data: cpRules, error: cpErr } = await cpQuery;
  if (cpErr) throw new Error(cpErr.message);

  const rules = new Map<string, string>(
    (cpRules ?? []).map((r) => [counterpartyRuleKey(r.source as string, r.counterparty_key as string), r.chart_of_accounts_id as string]),
  );
  const updates = resolveBankBackfill(rows, rules);
  return applyLineItemUpdates(supabase, "ramp_bank_ledger", updates, { mapping_source: "rule" });
}
