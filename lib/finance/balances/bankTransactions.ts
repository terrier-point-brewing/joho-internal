/**
 * Reading a GL account's imported bank lines, for the Square reconciliation.
 *
 * Deliberately NOT a general-ledger read. It hands back the shape
 * squareSweeps.ts wants and nothing else — no account codes, no directions, no
 * postings — and it makes no distinction about `include_in_gl`, because the
 * whole point is to look at rows the books deliberately ignore. Anything that
 * wants these rows as accounting facts belongs in
 * providers/transactionPostings.ts, which filters them out on purpose.
 *
 * ── How a GL account reaches its transactions ────────────────────────────────
 * Two hops, and deliberately no shortcut. Plaid rows carry no
 * chart_of_accounts_id, so the route is: the GL account names a connection in
 * balance_sheet_account_sources.config, and the connection names the bank
 * account in external_id. Coding the rows to an account instead would be more
 * convenient and would also be the first step toward treating them as postings,
 * which is a decision nobody has taken.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { BankLine } from "./squareSweeps";
import { getConnection } from "./connections";
import { PLAID_LEDGER_SOURCE } from "./plaidTransactionSync";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

interface LedgerRow {
  amount_cents: number;
  description: string | null;
  original_description: string | null;
  counterparty_name: string | null;
}

/**
 * Pure. Everything the recogniser could match on, in one string.
 *
 * Both description fields are concatenated rather than one being chosen,
 * because the Square ACH descriptor lands somewhere different at every
 * institution: the cleaned-up description at some, the raw one at others, and
 * neither at a feed that only surfaces a counterparty. Choosing a field would be
 * a guess, and the wrong guess reads as "no sweeps found" rather than as an
 * error.
 *
 * The counterparty is passed through separately, not folded in: the recogniser's
 * bare-counterparty rule requires that field to be exactly the sender's name,
 * and merging it into the description would defeat the rule.
 */
export function toBankLine(row: LedgerRow): BankLine {
  return {
    description: [row.description, row.original_description].filter(Boolean).join(" ") || null,
    counterpartyName: row.counterparty_name,
    amountCents: row.amount_cents,
  };
}

/**
 * Which Plaid connection and which bank account a GL account is fed by, or null
 * when it is not fed by one at all.
 */
async function resolveBankFeed(
  supabase: AdminClient,
  coaId: string,
): Promise<{ connectionId: string; externalAccountId: string } | null> {
  const { data, error } = await supabase
    .from("balance_sheet_account_sources")
    .select("config")
    .eq("chart_of_accounts_id", coaId)
    .eq("active", true);
  if (error || !data) return null;

  for (const row of data as { config: Record<string, unknown> | null }[]) {
    const connectionId = (row.config ?? {}).connectionId;
    if (typeof connectionId !== "string" || connectionId.length === 0) continue;

    // getConnection, not getConnectionWithSecrets. Nothing here needs a bank
    // token, and the module that does not ask for one cannot leak it.
    const connection = await getConnection(supabase, connectionId);
    if (!connection || connection.provider !== "plaid" || !connection.externalId) continue;

    return { connectionId: connection.id, externalAccountId: connection.externalId };
  }

  return null;
}

/**
 * The bank lines for a GL account over `(after, through]`, or null when there
 * is no feed to read.
 *
 * ── Null is not an empty list, and the difference is the whole point ─────────
 * Null means "this account has nothing to check against": no connection, no
 * chosen bank account, or no imported transactions in the window at all. The
 * caller must leave its figures unset rather than record a zero, because a
 * missing feed reporting "nothing was swept" is a confident-looking claim built
 * on no evidence — precisely what the reconciliation log exists to avoid.
 *
 * An empty window is treated as no feed for the same reason. The link asks for
 * two years of history, so a month with no lines at all in a business's
 * operating account means the import has not reached it, not that the account
 * sat idle.
 *
 * ── Half-open on the left ────────────────────────────────────────────────────
 * `after` is exclusive and `through` inclusive, matching the anchor window the
 * Square derivation uses: the previous month end is already accounted for in the
 * anchor figure, so a sweep dated that day belongs to the previous period.
 *
 * ── Pending excluded ─────────────────────────────────────────────────────────
 * A pending ACH credit may post later under a different transaction id. Counting
 * both would double the sweep and make a reconciled month look overexplained.
 */
export async function readBankLines(
  supabase: AdminClient,
  coaId: string,
  after: string,
  through: string,
): Promise<BankLine[] | null> {
  const feed = await resolveBankFeed(supabase, coaId);
  if (!feed) return null;

  const { data, error } = await supabase
    .from("bank_ledger")
    .select("amount_cents, description, original_description, counterparty_name")
    .eq("source", PLAID_LEDGER_SOURCE)
    .eq("connection_id", feed.connectionId)
    .eq("external_account_id", feed.externalAccountId)
    .eq("pending", false)
    .gt("transaction_date", after)
    .lte("transaction_date", through);
  if (error) return null;

  const rows = (data ?? []) as LedgerRow[];
  if (rows.length === 0) return null;

  return rows.map(toBankLine);
}
