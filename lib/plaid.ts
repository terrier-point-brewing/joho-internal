/**
 * Plaid client for the GL 1020 Chase Operating balance feed.
 *
 * Raw fetch rather than the `plaid` npm SDK, matching lib/ramp.ts and
 * lib/square.ts -- three endpoints do not justify a dependency, and the SDK's
 * generated types would be the only thing it bought us.
 *
 * ── The one constraint that shapes everything else ───────────────────────────
 * `/accounts/balance/get` answers "what is the balance RIGHT NOW". It takes no
 * as-of date and there is no historical balance endpoint at any price tier. A
 * month-end figure therefore only exists if something recorded it on the day,
 * which is why lib/finance/balances/dailyCapture.ts exists and why the balance
 * provider reads that capture table rather than calling this module.
 *
 * Nothing here should ever run in a page load: the endpoint is synchronous
 * against the bank and can take 30 seconds.
 *
 * ── Plan ─────────────────────────────────────────────────────────────────────
 * Verified 2026-08-01 against Plaid's help centre: the Trial plan is free,
 * carries real production data, includes Balance and Transactions, covers Chase
 * over OAuth, and allows 10 Production Items. We need one. Eligibility is
 * US/Canada with no pre-existing Production account, which this business meets.
 */
import { env } from "./env";

/**
 * Trial and paid plans both live on the production host; `sandbox` exists here
 * only so a developer can exercise Link without touching a real bank. Plaid
 * retired the separate `development` environment, so there is no third option.
 */
const PLAID_HOSTS: Record<string, string> = {
  production: "https://production.plaid.com",
  sandbox: "https://sandbox.plaid.com",
};

function plaidHost(): string {
  const name = env.plaidEnv();
  const host = PLAID_HOSTS[name];
  if (!host) throw new Error(`PLAID_ENV must be one of ${Object.keys(PLAID_HOSTS).join(", ")} (got "${name}")`);
  return host;
}

/**
 * A Plaid API error, carrying the fields the connection store needs to decide
 * whether an operator has to act.
 */
export class PlaidError extends Error {
  readonly errorCode: string;
  readonly errorType: string;

  constructor(message: string, errorType: string, errorCode: string) {
    super(message);
    this.name = "PlaidError";
    this.errorType = errorType;
    this.errorCode = errorCode;
  }

  /**
   * True when the item's credential no longer works and only the operator can
   * fix it by re-running Link. Distinguished from an ordinary failure because
   * these two states need different words on the Settings status line: "it will
   * retry" versus "you must reconnect".
   */
  get needsReauth(): boolean {
    return (
      this.errorType === "ITEM_ERROR" &&
      ["ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT", "ITEM_LOCKED"].includes(this.errorCode)
    );
  }
}

interface PlaidErrorBody {
  error_type?: string;
  error_code?: string;
  error_message?: string;
  display_message?: string | null;
}

/**
 * POSTs to Plaid with the app-level credentials injected.
 *
 * `client_id`/`secret` are app-level and belong in env; the per-item
 * `access_token` is minted at link time and is passed in by the caller from
 * integration_connections.credentials. See the credential table in
 * docs/finance/balance-methods-handoff.md.
 */
async function plaidPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${plaidHost()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.plaidClientId(),
      secret: env.plaidSecret(),
      ...body,
    }),
    cache: "no-store",
  });

  const json = (await res.json()) as unknown;

  if (!res.ok) {
    const err = (json ?? {}) as PlaidErrorBody;
    throw new PlaidError(
      err.error_message ?? err.display_message ?? `Plaid request to ${path} failed with ${res.status}`,
      err.error_type ?? "API_ERROR",
      err.error_code ?? String(res.status),
    );
  }

  return json as T;
}

// ── Link ─────────────────────────────────────────────────────────────────────

export interface LinkTokenResult {
  linkToken: string;
  expiration: string;
}

/**
 * Creates a Link token for the browser to open Plaid Link with.
 *
 * `products: ["transactions"]` is deliberate and is NOT an accident of
 * copy-paste. Balance cannot initialise a Link session on its own -- it is only
 * ever an add-on to another product -- so a Transactions link is the supported
 * way to reach a bank balance. It also happens to be the thing that would give
 * us Chase transaction data later, at no extra cost on the Trial plan.
 *
 * `redirectUri` must be supplied for OAuth institutions (Chase is one) and must
 * exactly match a URI registered in the Plaid dashboard. Omitted when unset so
 * a sandbox developer is not forced to register one.
 *
 * ── `days_requested` is set HERE or not at all ───────────────────────────────
 * How much transaction history Plaid pulls is decided when the Item is created,
 * and it defaults to 90 days. Linking Chase without this and then discovering
 * later that a year of history was wanted means the history simply is not
 * there -- the same shape of loss as the balance feed, where a month with no
 * capture can never be filled in.
 *
 * 730 is Plaid's maximum. It costs nothing extra to ask for and the bank
 * supplies whatever it actually holds, so asking for the maximum is the only
 * choice that cannot be regretted. It matters for GL 1040 specifically: the
 * Square sweeps are identifiable only from this account's transactions (see
 * balances/squareSweeps.ts), so the history depth here bounds how far back that
 * account's drift can ever be explained.
 */
export async function createLinkToken(clientUserId: string): Promise<LinkTokenResult> {
  const redirectUri = env.plaidRedirectUri();

  const data = await plaidPost<{ link_token: string; expiration: string }>("/link/token/create", {
    user: { client_user_id: clientUserId },
    client_name: "Terrier Point",
    products: ["transactions"],
    transactions: { days_requested: 730 },
    country_codes: ["US"],
    language: "en",
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
  });

  return { linkToken: data.link_token, expiration: data.expiration };
}

/**
 * Creates a Link token in UPDATE mode, to repair an item whose credential has
 * stopped working, without minting a new one.
 *
 * `products` is omitted rather than repeated — Plaid rejects a token that names
 * both an access token and a product list. The point of update mode is that the
 * existing access_token stays valid afterwards, so the connection row, its
 * captured history and the account choice all survive a re-login. Deleting and
 * re-linking would keep the history (connection_id is ON DELETE SET NULL) but
 * would leave it attributed to nothing.
 */
export async function createUpdateLinkToken(clientUserId: string, accessToken: string): Promise<LinkTokenResult> {
  const redirectUri = env.plaidRedirectUri();

  const data = await plaidPost<{ link_token: string; expiration: string }>("/link/token/create", {
    user: { client_user_id: clientUserId },
    client_name: "Terrier Point",
    country_codes: ["US"],
    language: "en",
    access_token: accessToken,
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
  });

  return { linkToken: data.link_token, expiration: data.expiration };
}

export interface ExchangeResult {
  accessToken: string;
  itemId: string;
}

/**
 * Exchanges Link's short-lived public token for the long-lived access token.
 *
 * Server-side only, and the returned token must go straight into
 * integration_connections.credentials via writeCredentials(). It must never be
 * returned to the browser or written to a log -- it is a live bank credential
 * with no expiry.
 */
export async function exchangePublicToken(publicToken: string): Promise<ExchangeResult> {
  const data = await plaidPost<{ access_token: string; item_id: string }>("/item/public_token/exchange", {
    public_token: publicToken,
  });
  return { accessToken: data.access_token, itemId: data.item_id };
}

// ── Balances ─────────────────────────────────────────────────────────────────

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  /** "depository" | "credit" | "loan" | "investment" | "brokerage" | "other". */
  type: string;
  subtype: string | null;
  balances: {
    /** Posted balance including pending activity. Null at a few institutions. */
    current: number | null;
    /** Posted balance less holds and pending outflows. */
    available: number | null;
    iso_currency_code: string | null;
    unofficial_currency_code: string | null;
  };
}

/**
 * Real-time balances for every account on an item. Forces a fresh pull from the
 * bank, so it is slow (up to ~30s) and belongs only in a cron.
 */
export async function getAccountBalances(accessToken: string): Promise<PlaidAccount[]> {
  const data = await plaidPost<{ accounts: PlaidAccount[] }>("/accounts/balance/get", {
    access_token: accessToken,
  });
  return data.accounts ?? [];
}

/**
 * The cents figure to store for a depository account.
 *
 * `current` over `available`, deliberately. Available subtracts holds and
 * pending debits, which are bank-side artefacts that have not posted and are
 * not in the books either -- using it would introduce a difference against the
 * ledger that no reconciliation could explain. `available` is only a fallback
 * for the institutions that return a null current.
 *
 * Returns null rather than throwing when neither figure is present, so a bank
 * that answers with nothing reads as an uncaptured day instead of a false zero.
 */
export function balanceToCents(account: PlaidAccount): number | null {
  const dollars = account.balances.current ?? account.balances.available;
  if (dollars === null || dollars === undefined || !Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100);
}

/** Depository accounts only — see readPlaidBalance in the daily capture module. */
export function isDepository(account: PlaidAccount): boolean {
  return account.type === "depository";
}

// ── Transactions ─────────────────────────────────────────────────────────────

/**
 * One transaction as Plaid reports it.
 *
 * Only the fields this app actually reads are typed. The whole object is kept
 * verbatim on the stored row, because the Square ACH descriptor turns up in a
 * different field depending on how much addenda the institution passes through
 * and a field we did not think to type is exactly the one that will carry it.
 */
export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /** Posted date, or the authorised date while still pending. YYYY-MM-DD. */
  date: string;
  authorized_date?: string | null;
  /** Dollars, and see amountToCents below before assuming which way. */
  amount: number;
  iso_currency_code: string | null;
  unofficial_currency_code?: string | null;
  /** The bank's own description. Usually where the ACH addenda lands. */
  name: string;
  /** Plaid's cleaned-up merchant, when it recognises one. */
  merchant_name?: string | null;
  /** The raw descriptor, only present when asked for at request time. */
  original_description?: string | null;
  pending: boolean;
  pending_transaction_id?: string | null;
  /** Plaid's enrichment, when the plan and institution supply it. */
  counterparties?: { name?: string | null; type?: string | null }[] | null;
}

export interface TransactionsSyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  /** Removals carry only the id — the transaction itself is gone. */
  removed: { transaction_id: string }[];
  nextCursor: string;
  hasMore: boolean;
}

/**
 * True when Plaid refused a page because the item's data changed mid-pagination.
 *
 * The documented recovery is to throw away everything fetched in this pass and
 * start again from the last cursor that was actually persisted — NOT from the
 * cursor the failed page returned, which describes a state we never committed.
 * Applying a half-walked set of pages would leave the stored cursor ahead of the
 * stored transactions and the gap would never be revisited.
 */
export function isSyncMutationError(err: unknown): boolean {
  return err instanceof PlaidError && err.errorCode === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";
}

/**
 * One page of the transactions feed.
 *
 * Cursor-based rather than date-ranged, which is what makes this safe to run
 * daily forever: Plaid replays every change since the cursor, so a transaction
 * that posts late, gets recategorised, or is reversed arrives as a `modified`
 * or `removed` entry rather than being missed because the date window had
 * already moved past it.
 *
 * `cursor` is null on the very first call for an item, which asks for the whole
 * history the item was created with — up to two years here, since the link token
 * requests `days_requested: 730`. That first walk is many pages; every one after
 * it is normally one page of nothing.
 *
 * `include_original_description` is not optional for this application's purpose.
 * The Square sweep is identified from its ACH descriptor, and the descriptor
 * survives in `original_description` at institutions that clean up `name`.
 */
export async function syncTransactions(
  accessToken: string,
  cursor: string | null,
  count = 500,
): Promise<TransactionsSyncPage> {
  const data = await plaidPost<{
    added?: PlaidTransaction[];
    modified?: PlaidTransaction[];
    removed?: { transaction_id: string }[];
    next_cursor: string;
    has_more: boolean;
  }>("/transactions/sync", {
    access_token: accessToken,
    // Plaid rejects an explicit null, so the first call simply omits it.
    ...(cursor ? { cursor } : {}),
    count,
    options: { include_original_description: true },
  });

  return {
    added: data.added ?? [],
    modified: data.modified ?? [],
    removed: data.removed ?? [],
    nextCursor: data.next_cursor,
    hasMore: data.has_more,
  };
}

/**
 * A transaction's amount in cents, in THIS application's direction.
 *
 * ── Read this before changing it ─────────────────────────────────────────────
 * Plaid's sign is the opposite of the intuitive one. For a depository account a
 * POSITIVE `amount` means money LEFT the account and a negative amount means
 * money arrived: Plaid documents it as "positive values when money moves out of
 * the account". Everything downstream here wants the cash direction a bookkeeper
 * would write — a deposit is positive — so the sign is flipped exactly once,
 * here, and never again.
 *
 * This matters beyond tidiness. classifySquareSweep ignores any line whose
 * amount is not positive, on the grounds that a Square-originated debit is a
 * chargeback rather than a payout. Leave Plaid's sign alone and every Square
 * deposit is silently discarded as a chargeback, and the reconciliation reports
 * a confident zero swept. There is no error state for getting this backwards,
 * which is why it is tested explicitly rather than merely commented.
 */
export function transactionAmountToCents(txn: Pick<PlaidTransaction, "amount">): number {
  const cents = Math.round(txn.amount * 100);
  // `-0` is not `0` under Object.is, which is what a test comparison uses, and
  // it would serialise into the database as an oddity nobody expects.
  return cents === 0 ? 0 : -cents;
}
