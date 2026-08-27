/**
 * Daily import of bank transactions from Plaid.
 *
 * Exists for one reason: Square publishes nothing about money leaving its
 * stored balance, so the only place a sweep is visible is the bank account it
 * arrives in. This job fetches those bank lines; balance-close then matches them
 * against Square's ACH originator id and splits GL 1040's month-end drift into
 * "swept to the bank" and "genuinely unexplained".
 *
 * The rows land in the shared bank ledger but are imported EXCLUDED from the
 * general ledger, so the profit and loss, the cash-flow statement, the balance
 * sheet and the transactions grid are unchanged by this job running. Opting a
 * source in is a deliberate act with its own switch. See
 * lib/finance/balances/plaidTransactionSync.ts for the three properties that
 * enforce it.
 *
 * ── Why 03:00 UTC ────────────────────────────────────────────────────────────
 * Two constraints, and one slot satisfies both.
 *
 * It has to be well before balance-close at 09:00 UTC, which is what reads these
 * transactions to explain the drift — a sync running after it would leave every
 * month end explained by yesterday's data.
 *
 * And it has to be clear of balance-capture at 02:00 UTC. That job calls the
 * bank synchronously and is allowed five minutes; overlapping two jobs on the
 * same Plaid item invites a mid-pagination mutation on this one for no benefit.
 * An hour of headroom costs nothing, because unlike the balance capture this
 * feed has no deadline: /transactions/sync replays everything since its cursor,
 * so a missed run is picked up in full by the next one. A missed BALANCE capture
 * is a month end that can never be recovered; a missed transaction sync is a day
 * of latency.
 *
 * ── The first run is not like the others ─────────────────────────────────────
 * The link token asks for 730 days of history, so the first sync after a bank is
 * connected walks up to two years — many pages, where every subsequent run is
 * one page of nothing. The cursor is persisted per page, so a first run that
 * does not finish inside the function's time limit simply continues on the next
 * run rather than starting over. `incomplete` in the response says that
 * happened, and is the reason a manual run reports that it started rather than
 * waiting for an answer.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncPlaidTransactions } from "@/lib/finance/balances/plaidTransactionSync";
import { autoMapBankLedger, backfillBankLedgerCounterparties } from "@/lib/finance/autoMap";

export async function runBankTransactionsSync(supabase: SupabaseClient) {
  // Reported rather than thrown, matching balance-capture: one bank failing is
  // a fact for the Settings status line, not a reason to mark the whole run
  // failed and discard what the others imported.
  const result = await syncPlaidTransactions(supabase);

  // Name the lines the feed left anonymous, over the whole table rather than
  // just this run's page.
  //
  // The importer already derives a counterparty from the ACH descriptor for
  // every row it writes (lib/finance/bankDescriptor.ts), but /transactions/sync
  // is CURSORED: a re-run returns only what changed, so history imported before
  // that existed would stay anonymous forever. A row with no counterparty has no
  // rule key, so no counterparty rule can ever match it — it is hand-coded every
  // month for no reason anyone can see.
  //
  // Swallowed, not thrown. This is a convenience pass over rows that are already
  // imported; failing the whole sync over it would discard transactions that
  // landed correctly, and the next run derives the same names from the same
  // descriptors.
  let named = 0;
  try {
    ({ named } = await backfillBankLedgerCounterparties(supabase as never));
  } catch (e) {
    console.error("[bank-transactions-sync] counterparty backfill failed", e);
  }

  // Then apply the standing counterparty rules to what just arrived.
  //
  // The importer writes `unclassified` on every new row on purpose -- it will
  // not guess what a movement IS -- and until now the rules only ran when
  // somebody SAVED one. So a rule set in Settings answered the history in front
  // of it and nothing after: the next payout from a counterparty already ruled
  // on landed unclassified and waited for a human to re-save a rule that had not
  // changed. The 2026-08-25 Ramp reimbursement debit is the case in point --
  // "Ramp Reimbursement -> bill payment" had been standing for two days, and its
  // five older siblings carried it, while the new one sat unclassified.
  //
  // A rule is a standing answer, so the moment to apply it is the moment a line
  // it answers arrives. Fill-nulls-only and per column (resolveBankBackfill), so
  // it cannot overwrite a manual pin or an answer a person already gave.
  //
  // Three years, matching the feed opt-in cascade in the bank-ledger-rules
  // route: a first sync after a bank is connected walks up to two years of
  // history, and this run may be the one that imported it.
  //
  // Swallowed per year, for the same reason the naming pass above is: a
  // convenience over rows that are already safely imported must not fail a sync.
  let mapped = 0;
  const thisYear = new Date().getFullYear();
  for (const y of [thisYear, thisYear - 1, thisYear - 2]) {
    try {
      const r = await autoMapBankLedger(supabase as never, { from: `${y}-01-01`, to: `${y}-12-31` });
      mapped += r.mapped;
    } catch (e) {
      console.error("[bank-transactions-sync] counterparty rule pass failed", { year: y, error: e });
    }
  }

  return { ...result, counterparties_named: named, rules_applied: mapped };
}
