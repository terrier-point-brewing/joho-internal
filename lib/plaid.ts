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
 */
export async function createLinkToken(clientUserId: string): Promise<LinkTokenResult> {
  const redirectUri = env.plaidRedirectUri();

  const data = await plaidPost<{ link_token: string; expiration: string }>("/link/token/create", {
    user: { client_user_id: clientUserId },
    client_name: "Terrier Point",
    products: ["transactions"],
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
