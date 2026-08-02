/**
 * Importing Chase transactions from Plaid into the shared bank ledger.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 * Square publishes nothing about money LEAVING its stored balance. Verified
 * exhaustively against the live v2 API: all 1,767 payouts are inflows, there are
 * no BANK_ACCOUNT destinations, and the legacy settlements endpoint is retired.
 * The outflow is only ever visible from the receiving side — the bank account
 * Square pays into, which the operator has already declared on the Square
 * method's setup. This module is the feed that makes that side visible.
 *
 * ── These rows do not reach the books, and that is enforced ──────────────────
 * Read this before changing what is written.
 *
 * ramp_bank_ledger is read by providers/transactionPostings.ts and by
 * financials/fetchSources.ts, which feed the balance sheet, the profit and loss,
 * the cash-flow statement and the transactions grid — all verified and in
 * production use. A Chase row reaching that aggregation would silently change
 * reported figures across up to two years of history.
 *
 * So every row this module writes carries `include_in_gl: false`, and every one
 * of those readers filters on it. Two further properties make the same promise
 * independently: the rows land with no chart_of_accounts_id, which the
 * balance-sheet reader matches on, and with `affects_pl: false`, which the P&L
 * and cash-flow reader filters on. Whether Chase transactions SHOULD feed the
 * general ledger, and which counterparties map where, is separate work that has
 * a switch to throw because of this; throwing it is not this module's job.
 *
 * ── Why the cursor feed rather than a date range ─────────────────────────────
 * /transactions/sync replays every CHANGE since a cursor, so a transaction that
 * posts late, gets recategorised, or is reversed arrives as a modified or
 * removed entry. A date-windowed import misses all three the moment the window
 * moves past them, and nothing would ever say so.
 *
 * ── Committing per page, not per pass ────────────────────────────────────────
 * Plaid's own guidance is to accumulate a whole pagination sequence and commit
 * it atomically. That is wrong for the first sync here: the link asks for 730
 * days of history, which is tens of thousands of transactions, and holding them
 * all in memory to lose the lot when a serverless function hits its time limit
 * is worse than a briefly inconsistent intermediate state.
 *
 * So each page is written and only THEN is its cursor persisted. The invariant
 * that matters is that the stored cursor is never ahead of the stored rows —
 * if it were, the skipped transactions would never be revisited by anything.
 * Being behind is harmless: the feed replays and every write is an upsert keyed
 * on the source and its transaction id, so a replayed page converges rather
 * than duplicating.
 */
import { syncTransactions, isSyncMutationError, transactionAmountToCents, type PlaidTransaction } from "@/lib/plaid";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { listConnections, getConnectionWithSecrets, recordSyncResult, type ConnectionWithSecrets } from "./connections";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** The `source` discriminator these rows carry in the shared ledger. */
export const PLAID_LEDGER_SOURCE = "plaid";

/**
 * Where the cursor lives.
 *
 * `config`, never `credentials`. A cursor is an opaque position in a feed, not a
 * secret, and credentials is the one column that must never reach a response —
 * putting a routinely-updated field in there would mean writing to it on every
 * run and give a reason to read it back in places that have no business holding
 * a bank token.
 */
export const CURSOR_KEY = "transactionsCursor";

/**
 * Pages before a run gives up and leaves the rest for tomorrow.
 *
 * A bound rather than a completeness guarantee, on purpose. The first sync of
 * two years may not finish inside one invocation; because the cursor is
 * persisted per page, the next run simply carries on from where this one
 * stopped instead of starting over. 200 pages of 500 is 100,000 transactions,
 * which is far more than a brewery's operating account produces in two years.
 */
const MAX_PAGES_PER_RUN = 200;

/**
 * Restarts allowed after Plaid reports the item mutated mid-pagination.
 *
 * Two, because the condition is transient — it means the bank pushed an update
 * while we were walking — and a third failure in one run means something is
 * genuinely churning, at which point stopping and reporting beats looping.
 */
const MAX_MUTATION_RESTARTS = 2;

export interface SyncOutcome {
  /** Connections considered. */
  considered: number;
  /** Rows inserted or updated. */
  upserted: number;
  /** Rows deleted because Plaid withdrew the transaction. */
  removed: number;
  /** Connections whose sync failed outright. */
  failed: number;
  /** True when a connection stopped on the page bound with more still to fetch. */
  incomplete: boolean;
  errors: string[];
}

/** A ramp_bank_ledger row as this module writes it. */
export interface LedgerRow {
  source: string;
  source_transaction_id: string;
  connection_id: string;
  external_account_id: string;
  amount_cents: number;
  currency_code: string;
  description: string;
  original_description: string | null;
  counterparty_name: string | null;
  flow_type: string;
  affects_pl: boolean;
  include_in_gl: boolean;
  chart_of_accounts_id: null;
  mapping_source: string;
  transaction_date: string;
  pending: boolean;
  raw: PlaidTransaction;
}

/**
 * The best single counterparty name available.
 *
 * Plaid's enrichment is preferred over `merchant_name` because on an ACH credit
 * the counterparty is the originator — "Square Inc" — while merchant_name is
 * frequently null on transfers, which are not merchant activity at all. Either
 * is fed to the sweep matcher; neither is relied on alone, since the descriptor
 * fields carry the ACH originator id that the exact match actually keys on.
 */
export function counterpartyNameOf(txn: PlaidTransaction): string | null {
  const enriched = txn.counterparties?.find((c) => typeof c?.name === "string" && c.name.trim().length > 0);
  if (enriched?.name) return enriched.name.trim();
  const merchant = txn.merchant_name?.trim();
  return merchant && merchant.length > 0 ? merchant : null;
}

/**
 * Pure. One Plaid transaction as a ledger row.
 *
 * ── The sign ─────────────────────────────────────────────────────────────────
 * transactionAmountToCents is the single most error-prone line in this feature.
 * Plaid reports a DEPOSIT as a NEGATIVE amount on a depository account, and both
 * consumers of the result want the opposite: this ledger's own convention is
 * "outflow negative, inflow positive" (the 20260725 migration says so), and
 * classifySquareSweep ignores anything that is not positive on the grounds that
 * a Square-originated debit is a chargeback rather than a payout. Get it
 * backwards and every sweep is silently discarded, and the reconciliation
 * reports a confident zero explained with no error anywhere.
 *
 * ── Everything that keeps it out of the books ────────────────────────────────
 * Three independent properties, because one of them being edited away by
 * accident must not be enough:
 *   * `include_in_gl: false` — the explicit gate every general-ledger reader
 *     filters on.
 *   * `chart_of_accounts_id: null` — the balance-sheet reader matches on
 *     account id and skips a row that names none.
 *   * `affects_pl: false` — what the P&L and cash-flow reader filters on.
 *
 * `flow_type` is 'unclassified' rather than 'deposit' even for an obvious
 * incoming transfer. Classifying at import time would be inventing analysis from
 * a feed that says nothing about intent, and the one classification that matters
 * here — is this a Square sweep — is made by squareSweeps.ts from the descriptor
 * rather than guessed at from the amount's direction.
 */
export function toLedgerRow(
  connection: { id: string; externalId: string | null },
  txn: PlaidTransaction,
): LedgerRow {
  return {
    source: PLAID_LEDGER_SOURCE,
    source_transaction_id: txn.transaction_id,
    connection_id: connection.id,
    external_account_id: txn.account_id,
    amount_cents: transactionAmountToCents(txn),
    currency_code: txn.iso_currency_code ?? "USD",
    description: txn.name ?? "",
    original_description: txn.original_description ?? null,
    counterparty_name: counterpartyNameOf(txn),
    flow_type: "unclassified",
    affects_pl: false,
    include_in_gl: false,
    chart_of_accounts_id: null,
    mapping_source: "unmapped",
    transaction_date: txn.date,
    pending: txn.pending === true,
    raw: txn,
  };
}

async function writePage(
  supabase: AdminClient,
  connection: ConnectionWithSecrets,
  page: { added: PlaidTransaction[]; modified: PlaidTransaction[]; removed: { transaction_id: string }[] },
): Promise<{ upserted: number; removed: number }> {
  // added and modified are written the same way. Plaid distinguishes them, but
  // an upsert keyed on the transaction id makes the distinction irrelevant here
  // and immune to a replay landing a row in the other bucket.
  const rows = [...page.added, ...page.modified].map((t) => toLedgerRow(connection, t));

  if (rows.length > 0) {
    // Matches the table's own unique constraint, which was already
    // (source, source_transaction_id) — the ledger was half-generalised for a
    // second source before there was one.
    const { error } = await supabase
      .from("ramp_bank_ledger")
      .upsert(rows, { onConflict: "source,source_transaction_id" });
    if (error) throw new Error(error.message);
  }

  const removedIds = page.removed.map((r) => r.transaction_id);
  if (removedIds.length > 0) {
    // Deleted rather than flagged, and scoped to this source so a Ramp row can
    // never be caught by a Plaid id collision. A removed transaction never
    // happened as far as the bank is concerned, and leaving it behind would let
    // a reversed deposit keep explaining a month's drift forever.
    const { error } = await supabase
      .from("ramp_bank_ledger")
      .delete()
      .eq("source", PLAID_LEDGER_SOURCE)
      .in("source_transaction_id", removedIds);
    if (error) throw new Error(error.message);
  }

  return { upserted: rows.length, removed: removedIds.length };
}

async function persistCursor(supabase: AdminClient, connection: ConnectionWithSecrets, cursor: string): Promise<void> {
  const { error } = await supabase
    .from("integration_connections")
    .update({ config: { ...connection.config, [CURSOR_KEY]: cursor } })
    .eq("id", connection.id);
  if (error) throw new Error(error.message);
  // Kept in step in memory so a later page in this same run merges onto the
  // current config rather than resurrecting the one this run started with.
  connection.config = { ...connection.config, [CURSOR_KEY]: cursor };
}

/**
 * Walks one connection's feed to the end, or to the page bound.
 *
 * Exported for the tests, which exercise the pagination, the write ordering and
 * the mid-pagination restart against a fake client rather than against a bank.
 */
export async function syncConnection(
  supabase: AdminClient,
  connection: ConnectionWithSecrets,
): Promise<{ upserted: number; removed: number; incomplete: boolean }> {
  const accessToken = connection.credentials.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("no stored bank credential — reconnect this account");
  }

  let upserted = 0;
  let removed = 0;
  let restarts = 0;
  let pages = 0;

  const storedCursor = (): string | null => {
    const value = connection.config[CURSOR_KEY];
    return typeof value === "string" && value.length > 0 ? value : null;
  };

  while (pages < MAX_PAGES_PER_RUN) {
    let page;
    try {
      page = await syncTransactions(accessToken, storedCursor());
    } catch (err) {
      // The item changed underneath the walk. Plaid's documented recovery is to
      // discard the pass and restart — which here means restarting from the last
      // cursor actually persisted, since nothing beyond it was ever committed.
      if (isSyncMutationError(err) && restarts < MAX_MUTATION_RESTARTS) {
        restarts++;
        continue;
      }
      throw err;
    }

    const written = await writePage(supabase, connection, page);
    upserted += written.upserted;
    removed += written.removed;

    // Only now. A cursor stored before its rows would put the feed permanently
    // past transactions that were never written down.
    await persistCursor(supabase, connection, page.nextCursor);
    pages++;

    if (!page.hasMore) return { upserted, removed, incomplete: false };
  }

  // Out of pages with the feed still going. Not an error: the cursor is stored,
  // so tomorrow's run continues from here rather than starting again.
  return { upserted, removed, incomplete: true };
}

/**
 * Syncs every linked bank.
 *
 * Driven off the connection list rather than off declared balance sources,
 * unlike the daily balance capture. A connection exists only because an operator
 * signed in at their bank to create it, so it is already the statement that this
 * feed is wanted; and the transactions are needed by an account OTHER than the
 * one the connection feeds — GL 1040's reconciliation reads GL 1020's bank
 * lines — so "which accounts use this method" is the wrong question to plan off.
 *
 * Failure is per connection, matching the daily capture, so one bank being
 * unreachable does not cost the others their sync.
 */
export async function syncPlaidTransactions(supabase: AdminClient): Promise<SyncOutcome> {
  const connections = await listConnections(supabase, "plaid");
  const outcome: SyncOutcome = {
    considered: 0,
    upserted: 0,
    removed: 0,
    failed: 0,
    incomplete: false,
    errors: [],
  };

  for (const summary of connections) {
    if (summary.status === "disabled") continue;
    outcome.considered++;

    try {
      const connection = await getConnectionWithSecrets(supabase, summary.id);
      if (!connection) throw new Error(`connection ${summary.id} no longer exists`);

      const result = await syncConnection(supabase, connection);
      outcome.upserted += result.upserted;
      outcome.removed += result.removed;
      outcome.incomplete = outcome.incomplete || result.incomplete;

      await recordSyncResult(supabase, connection.id, { ok: true });
    } catch (err) {
      outcome.failed++;
      const text = err instanceof Error ? err.message : String(err);
      outcome.errors.push(`plaid connection ${summary.id}: ${text}`);
      try {
        await recordSyncResult(supabase, summary.id, {
          ok: false,
          error: text,
          needsReauth: typeof err === "object" && err !== null && (err as { needsReauth?: unknown }).needsReauth === true,
        });
      } catch {
        // Best-effort, exactly as in dailyCapture: if the connection row itself
        // is unwritable there is nothing further to do and it must not take the
        // remaining connections down with it.
      }
    }
  }

  return outcome;
}
