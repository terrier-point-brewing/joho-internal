/**
 * Retroactive auto-mapping. One home for "fill the account on already-ingested,
 * still-unmapped rows" across all four finance sources. Pure resolvers decide the
 * updates (unit-tested); thin IO wrappers fetch rows + rules and apply the writes.
 *
 * Every resolver is fill-nulls-only and never touches a manual pin — the same
 * convention the ingest paths and the (soon thin) manual-button routes follow.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  loadBankLedgerInclusion,
  counterpartyKeyOf,
  INCLUSION_COLUMNS,
  type InclusionFacts,
} from "@/lib/finance/bankLedgerInclusion";
import { counterpartyFromDescriptor } from "@/lib/finance/bankDescriptor";
import { flowNeedsAccount, flowAffectsPl, isFlowType, type FlowType } from "@/lib/finance/flowTypes";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/**
 * Apply per-row updates in bounded parallel chunks. Returns { mapped, errors? }.
 *
 * Every field on an update other than `id` is written. The line-item resolvers
 * only ever set `chart_of_accounts_id`; the bank-ledger one also sets the flow
 * type and the affects_pl derived from it, which is why this takes the whole row
 * rather than one named column.
 */
async function applyLineItemUpdates(
  supabase: AdminClient,
  table: "pos_line_items" | "invoice_line_items" | "bank_ledger",
  updates: { id: string; [column: string]: unknown }[],
  extra?: Record<string, unknown>,
): Promise<{ mapped: number; errors?: string[] }> {
  if (updates.length === 0) return { mapped: 0 };
  const CHUNK = 100;
  let mapped = 0;
  const errors: string[] = [];
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    const results = await Promise.allSettled(
      chunk.map(({ id, ...fields }) =>
        supabase.from(table).update({ ...fields, ...extra }).eq("id", id),
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

/** What a counterparty rule says about its lines. Either half may be absent. */
export interface CounterpartyRule {
  chart_of_accounts_id: string | null;
  /** Null = the rule has no opinion; the row stays unclassified for a human. */
  flow_type: FlowType | null;
}

/** One bank-ledger row's update. `flow_type` is present only when a rule supplied one. */
export interface BankRowUpdate {
  // Indexed so applyLineItemUpdates can spread the whole row into an update.
  [column: string]: unknown;
  id: string;
  chart_of_accounts_id: string | null;
  flow_type?: FlowType;
  affects_pl?: boolean;
}

/**
 * Bank-ledger rows: apply counterparty rules, preserving manual + existing.
 *
 * ── Two halves, filled independently ─────────────────────────────────────────
 * A rule may name an account, a flow, or both, and a row may already have one
 * and not the other. Each half is filled only where the row is still empty:
 *
 *   * the account, only when `chart_of_accounts_id` is null;
 *   * the flow, only when the row is still `unclassified`.
 *
 * A row that already says what it is has been answered -- by a person, an
 * importer, or an earlier run -- and a rule written afterwards is not grounds to
 * revisit it. That is the same fill-nulls-only convention every resolver in this
 * file follows, applied per column rather than per row.
 *
 * ── Why the account is dropped when the flow does not use one ────────────────
 * Four of the eight flows never carry an account (flowTypes.ts). A rule that
 * pairs "internal transfer" with an account is a rule someone half-changed; the
 * flow wins, because the balance-sheet reader matches on the account alone and
 * would go on counting a transfer it has no business counting.
 *
 * `affects_pl` is derived here, never stored on the rule -- it is a function of
 * the flow and the registry is the only thing that computes it.
 */
export function resolveBankBackfill(
  rows: { id: string; source: string; counterparty_key: string | null; counterparty_name?: string | null; mapping_source: string; chart_of_accounts_id: string | null; flow_type?: string | null }[],
  counterpartyRules: Map<string, CounterpartyRule>,
): BankRowUpdate[] {
  const updates: BankRowUpdate[] = [];
  for (const row of rows) {
    if (row.mapping_source === "manual") continue;
    // Derived rather than read straight off the column, for the reason
    // counterpartyKeyOf() documents: Ramp's rows carry the key, Plaid's carry
    // only a name. Reading the column alone would mean a switched-on Chase feed
    // could never match a rule, however the rule was written.
    const key = counterpartyKeyOf(row);
    if (!key) continue;
    const rule = counterpartyRules.get(counterpartyRuleKey(row.source, key));
    if (!rule) continue;

    const rowFlow = row.flow_type ?? "unclassified";
    const setsFlow = rule.flow_type !== null && rowFlow === "unclassified";
    const flow = setsFlow ? rule.flow_type! : rowFlow;
    // An account is set only when the row's resulting flow actually uses one.
    //
    // An UNCLASSIFIED row therefore gets NOTHING, which is a deliberate reversal
    // of the first cut of this. Letting an account land on a row whose flow is
    // still unanswered produced the one state the grid has to draw a warning
    // for: an account nobody can see a picker for, on a row that counts for
    // nothing, waiting on a decision that may never make it relevant. Writing
    // the very state the UI calls a problem is not a convenience.
    //
    // Nothing is lost by waiting. The rule still holds the account, and the
    // moment the flow is answered -- by a person or by the rule growing a
    // flow_type -- the next pass fills it in. And the rule's account goes on
    // coding `expenses` rows either way: that path is resolveExpenseMapping and
    // has never consulted a flow type.
    const setsAccount = rule.chart_of_accounts_id !== null
      && row.chart_of_accounts_id === null
      && flowNeedsAccount(flow);
    if (!setsFlow && !setsAccount) continue;

    const update: BankRowUpdate = {
      id: row.id,
      chart_of_accounts_id: setsAccount ? rule.chart_of_accounts_id : row.chart_of_accounts_id,
    };
    if (setsFlow) {
      update.flow_type = rule.flow_type!;
      update.affects_pl = flowAffectsPl(rule.flow_type);
      // The flow the rule just applied does not use an account, so any account
      // already sitting on the row is cleared with it -- see above.
      if (!flowNeedsAccount(rule.flow_type)) update.chart_of_accounts_id = null;
    }
    updates.push(update);
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

/** A bank-ledger row, as far as counterparty derivation cares. */
interface NameableRow { id: string; counterparty_name: string | null; description: string | null }

/**
 * Fill `counterparty_name` from the bank's own descriptor on rows that have
 * none, and return the rows with the derived names applied in memory.
 *
 * Fill-nulls-only, like every other resolver here: a name a feed or a person
 * already supplied is never overwritten. A row whose descriptor names nobody a
 * machine can read -- a cheque, a wire -- is left null and stays a human's job.
 *
 * The in-memory copy matters as much as the write: `autoMapBankLedger` matches
 * rules against these same rows in the same pass, so a name derived now takes
 * effect now rather than on the next click.
 */
async function applyDerivedNames<T extends NameableRow>(supabase: AdminClient, rows: T[]): Promise<T[]> {
  const derived = new Map<string, string>();
  for (const row of rows) {
    if (row.counterparty_name) continue;
    const name = counterpartyFromDescriptor(row.description, row.counterparty_name);
    if (name) derived.set(row.id, name);
  }
  if (derived.size === 0) return rows;

  const CHUNK = 100;
  const entries = [...derived.entries()];
  for (let i = 0; i < entries.length; i += CHUNK) {
    await Promise.allSettled(
      entries.slice(i, i + CHUNK).map(([id, counterparty_name]) =>
        supabase.from("bank_ledger").update({ counterparty_name }).eq("id", id),
      ),
    );
  }
  // A failed write is not fatal: the name is still applied in memory for this
  // pass, and the next run derives it again from the same descriptor.
  return rows.map((row) => (derived.has(row.id) ? { ...row, counterparty_name: derived.get(row.id)! } : row));
}

/**
 * Name every already-imported bank line the feed left anonymous.
 *
 * Run from the bank-transactions sync job, so the "Refresh bank feed" button and
 * the nightly cron both do it. It cannot be left to the importer alone:
 * /transactions/sync is CURSORED, so a re-run returns only what changed and
 * never replays the history that arrived before the descriptor was read. Those
 * rows would stay anonymous -- and therefore unmatchable by any rule -- until
 * somebody reset the cursor.
 *
 * Reads the table rather than the feed, so rows older than Plaid's ~24-month
 * window are covered too.
 */
export async function backfillBankLedgerCounterparties(
  supabase: AdminClient,
): Promise<{ named: number }> {
  const { data, error } = await supabase
    .from("bank_ledger")
    .select("id, counterparty_name, description")
    .is("counterparty_name", null);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as NameableRow[];
  const after = await applyDerivedNames(supabase, rows);
  return { named: after.filter((r) => r.counterparty_name !== null).length };
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
  // A row the books deliberately ignore must not be quietly given an account by
  // a counterparty rule: the moment anyone opted a source in, a backlog of rows
  // would already be mapped by a rule nobody applied to them on purpose.
  //
  // What decides "ignored" is the standing rule, not the row's own flag. This
  // used to hardcode `.eq("include_in_gl", true)` on the reasoning that every
  // general-ledger reader filtered the same flag — true until the rules layer
  // shipped, and false afterwards. Left as it was, a feed switched on in
  // Settings would count towards the books while auto-mapping skipped every one
  // of its rows, so they would surface in the grid permanently unmapped.
  const inclusion = await loadBankLedgerInclusion(supabase);
  let rowQuery = inclusion.applyTo(
    supabase
      .from("bank_ledger")
      .select(`id, mapping_source, chart_of_accounts_id, flow_type, description, ${INCLUSION_COLUMNS}`)
      // No `.is("chart_of_accounts_id", null)` here any more. A rule now carries
      // a flow type as well as an account, and a row can be missing one without
      // the other -- an already-coded row still needs its flow. resolveBankBackfill
      // decides per column which halves are still empty, and skips a row where
      // neither is.
      .neq("mapping_source", "manual")
      .gte("transaction_date", opts.from)
      .lte("transaction_date", opts.to),
  );
  // Deliberately NOT narrowed by counterparty_key, even when one is given. That
  // column is populated on Ramp's rows and null on Plaid's -- counterpartyKeyOf()
  // derives the key from the NAME for exactly that reason -- so an
  // `.eq("counterparty_key", ...)` filter here silently excluded every Chase row
  // from the cascade a rule save triggers, which is the one moment the rule is
  // supposed to take effect. The narrowing is done by the rule map instead:
  // `cpQuery` below is scoped, so a row whose derived key is not in it is
  // skipped by resolveBankBackfill anyway. The cost is fetching a year of one
  // feed's rows rather than one counterparty's, which is a few dozen here.
  if (opts.source) rowQuery = rowQuery.eq("source", opts.source);
  const { data: allRows, error } = await rowQuery;
  if (error) throw new Error(error.message);
  // applyTo() is a superset: a feed switched on still carries the counterparty
  // exclusions someone made within it, and only allows() knows those.
  // Cast because the select is interpolated: PostgREST cannot type-check a
  // non-literal column list, the same reason INCLUSION_COLUMNS is typed `string`.
  const fetched = (allRows ?? []) as unknown as (InclusionFacts & {
    id: string;
    mapping_source: string;
    chart_of_accounts_id: string | null;
    flow_type: string | null;
    description: string | null;
  })[];
  const rows = fetched.filter((row) => inclusion.allows(row));
  if (rows.length === 0) return { mapped: 0 };

  // Give a row a counterparty before asking which rule matches it.
  //
  // Plaid names one on a minority of Chase lines, so most arrive with
  // counterparty_name null -- and counterpartyKeyOf() derives the rule key from
  // that name, so a nameless row can never match a rule however carefully one is
  // written. It is not a mapping failure a person can fix from the grid; it is
  // the lookup having nothing to look up.
  //
  // Derived here rather than in a SQL backfill so the patterns have ONE
  // implementation (lib/finance/bankDescriptor.ts) shared with the Plaid
  // importer, and so rows older than Plaid's ~24-month window are covered too:
  // this reads the table, not the feed. Written back in the same shape as any
  // other update, and only ever filling a null.
  const named = await applyDerivedNames(supabase, rows);

  // Rules are fetched for every feed, not just Ramp, and matched to a row by
  // (feed, counterparty). The old `.eq("source","ramp")` was correct only while
  // Ramp was the sole writer of this table: it would have handed a Chase row the
  // account a bookkeeper chose for the Ramp payee of the same name, which is the
  // one conflation the (source, counterparty_key) rule identity exists to stop.
  //
  // The `.not("chart_of_accounts_id","is",null)` this used to carry is gone: a
  // rule is now useful with a flow type and no account at all -- "every Ramp
  // wallet funding is an internal transfer" needs no account and must never be
  // given one. Rules with neither half are dropped when the map is built.
  let cpQuery = supabase
    .from("expense_counterparty_mappings")
    .select("source, counterparty_key, chart_of_accounts_id, flow_type");
  if (opts.counterpartyKey) cpQuery = cpQuery.eq("counterparty_key", opts.counterpartyKey);
  if (opts.source)          cpQuery = cpQuery.eq("source", opts.source);
  const { data: cpRules, error: cpErr } = await cpQuery;
  if (cpErr) throw new Error(cpErr.message);

  const rules = new Map<string, CounterpartyRule>();
  for (const r of cpRules ?? []) {
    const coaId = (r.chart_of_accounts_id ?? null) as string | null;
    // A stored flow this build does not recognise is treated as no opinion
    // rather than passed through: the readers branch on these values, and one
    // they have no branch for would be counted as nothing while looking mapped.
    const stored = (r.flow_type ?? null) as string | null;
    const flow = stored !== null && isFlowType(stored) ? stored : null;
    if (coaId === null && flow === null) continue;
    rules.set(counterpartyRuleKey(r.source as string, r.counterparty_key as string), {
      chart_of_accounts_id: coaId,
      flow_type: flow,
    });
  }
  const updates = resolveBankBackfill(named, rules);
  return applyLineItemUpdates(supabase, "bank_ledger", updates, { mapping_source: "rule" });
}
