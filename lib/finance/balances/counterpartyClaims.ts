/**
 * Counterparties that a balance-sheet calculation already accounts for.
 *
 * ── The fact this reads was already stated, once, by an operator ─────────────
 * GL 1040's Square method has a setup field: "Bank account Square pays out to"
 * (`sweepDestinationCoaId`, methods/definitions.ts). Filling it in is the
 * sentence "Square's deposits into that account are part of this calculation" —
 * squareDrift.ts consumes it to explain the month's drift from the bank's own
 * record.
 *
 * The Counterparties settings screen had no idea. Square therefore sat in its
 * list as an ordinary unmapped payee, one click away from being coded to GL
 * 1040 — which ADDS to the balance it emptied, because 1040 is a bank-section
 * account and normalizeSign passes a bank cash direction through unchanged (the
 * trap documented at methods/definitions.ts's squareStoredBalance). A screen
 * that invites the operator to make that mistake is the bug; a warning next to
 * the invitation would not have been a fix.
 *
 * So this module answers the question the screen should have been asking all
 * along: is anything already handling this counterparty? What comes back is
 * rendered read-only, so there is nothing to get wrong and nothing to keep in
 * step.
 *
 * ── Derived every time, never stored ─────────────────────────────────────────
 * A claim is not written to expense_counterparty_mappings.routing. Persisting
 * it would recreate exactly the second source of truth this exists to remove:
 * clearing the field on GL 1040 has to release the counterparty by itself, and
 * it does, because no copy was ever taken. The cost is one small query set per
 * settings-screen load, which is the cheapest read on that page.
 *
 * ── Adding the next calculation ──────────────────────────────────────────────
 * New balance-sheet methods arrive continuously. A method that accounts for
 * bank lines by counterparty gets a resolver in CLAIM_RESOLVERS below and
 * nothing else: no migration, no new dropdown option, no operator action, and
 * no change to the settings screen. The screen gets SHORTER as calculations are
 * added, because each one takes rows out of the unmapped pile.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { BALANCE_SHEET } from "../counterpartyHandlers";
import { matchSquareOriginator } from "./squareSweeps";
import { getConnection } from "./connections";
import { PLAID_LEDGER_SOURCE } from "./plaidTransactionSync";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** The identity of a counterparty row, which is (feed, counterparty) — never the name alone. */
export interface CounterpartyRef {
  source: string;
  counterparty_key: string;
  counterparty_label: string;
}

export interface CounterpartyClaim {
  /** The handler key this row reports as. Always a non-selectable one. */
  handler: string;
  /** Pill text. Names the specific account doing the work, never the mechanism. */
  badge: string;
  /** Deep link to where the claim was actually declared. */
  manageHref: string;
}

/** (feed, counterparty) as one map key. Matches the settings panel's own rowKey. */
export function claimKey(ref: { source: string; counterparty_key: string }): string {
  return `${ref.source} ${ref.counterparty_key}`;
}

const BALANCE_SHEET_ACCOUNTS_HREF = "/settings/finance/balance-sheet-accounts";

/** "Cash & Bank Accounts:Square Deposit Account" -> "Square Deposit Account". */
function leafAccountName(name: string): string {
  const parts = name.split(":");
  return parts[parts.length - 1].trim();
}

/** "GL 1040 Square Deposit Account", or just the leaf when an account has no number. */
function accountLabel(account: { account_number: string | null; account_name: string }): string {
  const leaf = leafAccountName(account.account_name);
  return account.account_number ? `GL ${account.account_number} ${leaf}` : leaf;
}

interface SourceRow {
  chart_of_accounts_id: string;
  config: Record<string, unknown> | null;
}

/**
 * Which bank feed a general-ledger account's transactions arrive on, or null
 * when it is not fed by one.
 *
 * The route is deliberately the same two hops bankTransactions.ts takes — the
 * account names a connection, the connection knows its provider — rather than a
 * shortcut through the ledger. Plaid rows carry no chart_of_accounts_id at all,
 * so there is no shortcut to take, and inventing one would mean guessing a
 * feed from a name.
 */
async function feedSourceOfAccount(supabase: AdminClient, coaId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("balance_sheet_account_sources")
    .select("config")
    .eq("chart_of_accounts_id", coaId)
    .eq("active", true);
  if (error || !data) return null;

  for (const row of data as { config: Record<string, unknown> | null }[]) {
    const connectionId = (row.config ?? {}).connectionId;
    if (typeof connectionId !== "string" || connectionId.length === 0) continue;

    const connection = await getConnection(supabase, connectionId);
    if (!connection) continue;
    // Only the two providers that actually import bank lines. A Square
    // connection is a merchant account, not a feed, and has no ledger rows to
    // claim -- returning something for it would claim counterparties on a feed
    // that does not exist.
    if (connection.provider === "plaid") return PLAID_LEDGER_SOURCE;
    if (connection.provider === "ramp") return "ramp";
  }

  return null;
}

/**
 * Square's deposits, on whichever feed the operator said Square pays into.
 *
 * Matched on the counterparty NAME through the same recogniser the
 * reconciliation uses, so the settings screen and the drift calculation can
 * never disagree about what counts as a Square deposit. Amount and direction
 * are not consulted: a chargeback from Square is still Square, and the row on
 * this screen is the payee, not one transaction.
 */
async function squareSweepClaims(
  supabase: AdminClient,
  refs: CounterpartyRef[],
): Promise<Map<string, CounterpartyClaim>> {
  const claims = new Map<string, CounterpartyClaim>();

  const { data, error } = await supabase
    .from("balance_sheet_account_sources")
    .select("chart_of_accounts_id, config")
    .eq("provider_key", "squareStoredBalance")
    .eq("active", true);
  if (error || !data) return claims;

  for (const row of data as SourceRow[]) {
    const destination = (row.config ?? {}).sweepDestinationCoaId;
    // Optional on the method, and optional here. An account that never named a
    // destination claims nothing, and its counterparties stay ordinary --
    // which is correct, because nothing in the app knows where that money went
    // either.
    if (typeof destination !== "string" || destination.length === 0) continue;

    const source = await feedSourceOfAccount(supabase, destination);
    if (!source) continue;

    const { data: account } = await supabase
      .from("chart_of_accounts")
      .select("account_number, account_name")
      .eq("id", row.chart_of_accounts_id)
      .maybeSingle();
    if (!account) continue;

    const badge = `Handled by ${accountLabel(account as { account_number: string | null; account_name: string })}`;

    for (const ref of refs) {
      if (ref.source !== source) continue;
      if (!matchSquareOriginator(null, ref.counterparty_label)) continue;
      claims.set(claimKey(ref), { handler: BALANCE_SHEET, badge, manageHref: BALANCE_SHEET_ACCOUNTS_HREF });
    }
  }

  return claims;
}

/**
 * Every claim resolver. One entry per balance-sheet calculation that accounts
 * for bank lines by counterparty.
 *
 * First claim wins on a collision, and a collision is a real possibility worth
 * not resolving cleverly: two calculations both claiming one counterparty means
 * the SETUP is wrong -- two accounts naming the same sweep destination, say --
 * and quietly merging them into one plausible-looking pill would hide it.
 */
const CLAIM_RESOLVERS: ((
  supabase: AdminClient,
  refs: CounterpartyRef[],
) => Promise<Map<string, CounterpartyClaim>>)[] = [squareSweepClaims];

/**
 * Resolve every claim over the given counterparties.
 *
 * Failure resolves to "no claims", never to a thrown request. A claim makes a
 * row read-only, so the failure mode of this module going wrong must be the
 * screen an operator already knows -- editable, with Square listed as an
 * ordinary payee -- and not a settings page that will not load.
 */
export async function resolveCounterpartyClaims(
  supabase: AdminClient,
  refs: CounterpartyRef[],
): Promise<Map<string, CounterpartyClaim>> {
  const claims = new Map<string, CounterpartyClaim>();
  if (refs.length === 0) return claims;

  for (const resolve of CLAIM_RESOLVERS) {
    try {
      for (const [key, claim] of await resolve(supabase, refs)) {
        if (!claims.has(key)) claims.set(key, claim);
      }
    } catch (e) {
      console.error("[counterparty-claims] resolver failed", e);
    }
  }

  return claims;
}
