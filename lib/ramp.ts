import { env } from "./env";

const RAMP_TOKEN_URL = "https://api.ramp.com/developer/v1/token";
const RAMP_BASE      = "https://api.ramp.com/developer/v1";
const RAMP_SCOPES    =
  "transactions:read statements:read cards:read users:read business:read reimbursements:read";

let _tokenCache: { token: string; expiresAt: number } | null = null;

export async function getRampToken(): Promise<string> {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt > now + 60_000) return _tokenCache.token;

  const clientId     = env.rampClientId();
  const clientSecret = env.rampClientSecret();
  const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res  = await fetch(RAMP_TOKEN_URL, {
    method:  "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({ grant_type: "client_credentials", scope: RAMP_SCOPES }),
    cache:   "no-store",
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Ramp auth failed: ${data.error_v2?.message ?? "unknown"}`);

  _tokenCache = { token: data.access_token, expiresAt: now + data.expires_in * 1000 };
  return _tokenCache.token;
}

/**
 * The GL account a transaction is coded against in Ramp. Ramp mirrors the same
 * chart of accounts as QuickBooks, so this is what lets an imported expense
 * resolve directly to a `chart_of_accounts` row without manual mapping.
 *
 * Sourced from the selected value of the transaction's (or a line item's)
 * `accounting_field_selections` entry whose dimension `type === "GL_ACCOUNT"`.
 */
export interface RampGlAccount {
  id:          string;         // Ramp's stable option id for the GL account
  external_id: string | null;  // ERP/QuickBooks account id or number, when present
  name:        string;         // account name as it appears in Ramp
}

export interface RampTransaction {
  id:                               string;
  amount:                           number;   // USD dollars (positive = spend, negative = refund/credit)
  currency_code:                    string;
  memo:                             string;
  merchant_name:                    string;
  merchant_category_code_description: string;
  sk_category_name:                 string | null;
  state:                            string;
  user_transaction_time:            string;   // ISO
  accounting_date:                  string;   // ISO
  gl_account:                       RampGlAccount | null;
  card_holder: {
    first_name:      string;
    last_name:       string;
    department_name: string;
    user_id:         string;
  };
}

export interface RampStatement {
  id:              string;
  end_date:        string;
  charges:         number;
  credits:         number;
  payments:        number;
  ending_balance:  number;
  statement_url:   string | null;
}

function parseAmount(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  const r = raw as Record<string, number>;
  return (r.amount ?? 0) / (r.minor_unit_conversion_rate ?? 100);
}

/**
 * Pull the GL account a transaction is coded against out of Ramp's
 * `accounting_field_selections`. The field lives at the transaction level and,
 * on split transactions, on each line item — we check both and take the first
 * GL_ACCOUNT selection found. Returns null when the transaction is uncoded.
 *
 * Shape note: each selection has two parts. `category_info` describes the
 * accounting FIELD/dimension itself (e.g. the "Category" GL dimension, with a
 * stable field id and `type: "GL_ACCOUNT"`) — it is NOT the chosen account. The
 * SELECTED account lives on the selection element's own top-level fields:
 * `name` (account name), `external_id` (its ERP/QuickBooks account number) and
 * `id` (Ramp's option id). Reading the account out of `category_info` is what
 * previously collapsed every expense into a single "Category" group.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractGlAccount(txn: any): RampGlAccount | null {
  const pools: unknown[] = [];
  if (Array.isArray(txn?.accounting_field_selections)) pools.push(...txn.accounting_field_selections);
  for (const li of txn?.line_items ?? []) {
    if (Array.isArray(li?.accounting_field_selections)) pools.push(...li.accounting_field_selections);
  }

  for (const raw of pools) {
    const sel  = raw as Record<string, unknown>;
    const info = (sel.category_info ?? null) as Record<string, unknown> | null;
    // The dimension's type gates whether this selection maps to the chart of
    // accounts. It lives on `category_info` (nested shape) or on the selection
    // itself (flat/legacy shape).
    const type = (info?.type ?? sel.type) as string | undefined;
    if (type !== "GL_ACCOUNT") continue;

    // Always read the selected account from the selection element itself — never
    // from `category_info`, which only ever holds the dimension label.
    const id   = sel.id as string | undefined;
    const name = sel.name as string | undefined;
    const ext  = sel.external_id as string | undefined;
    if (!id && !name && !ext) continue;

    return {
      id:          id ?? (ext ?? name)!,
      external_id: ext ?? null,
      name:        name ?? "",
    };
  }
  return null;
}

/**
 * Ramp's from_date/to_date want an RFC 3339 datetime, not a bare date — a plain
 * "2026-01-01" is rejected with "Not a valid datetime". Coerce date-only inputs
 * (start → midnight, end → end-of-day) and pass through anything already timed.
 */
export function toRampDatetime(value: string, endOfDay = false): string {
  if (value.includes("T")) return value;
  return `${value}T${endOfDay ? "23:59:59" : "00:00:00"}Z`;
}

export async function getRampTransactions(from?: string, to?: string): Promise<RampTransaction[]> {
  const token   = await getRampToken();
  const results: RampTransaction[] = [];

  const params = new URLSearchParams({ page_size: "100" });
  if (from) params.set("from_date", toRampDatetime(from));
  if (to)   params.set("to_date",   toRampDatetime(to, true));

  let url: string | null = `${RAMP_BASE}/transactions?${params}`;

  while (url) {
    const fetchRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await fetchRes.json();
    if (data.error_v2) throw new Error(`Ramp transactions: ${data.error_v2.message}`);

    for (const t of data.data ?? []) {
      results.push({
        id:                               t.id,
        amount:                           parseAmount(t.original_transaction_amount),
        currency_code:                    t.currency_code ?? "USD",
        memo:                             t.memo ?? "",
        merchant_name:                    t.merchant_name ?? "",
        merchant_category_code_description: t.merchant_category_code_description ?? "Other",
        sk_category_name:                 t.sk_category_name ?? null,
        state:                            t.state ?? "",
        user_transaction_time:            t.user_transaction_time ?? "",
        accounting_date:                  t.accounting_date ?? "",
        gl_account:                       extractGlAccount(t),
        card_holder: {
          first_name:      t.card_holder?.first_name      ?? "",
          last_name:       t.card_holder?.last_name       ?? "",
          department_name: t.card_holder?.department_name ?? "",
          user_id:         t.card_holder?.user_id         ?? "",
        },
      });
    }

    url = data.page?.next ?? null;
  }

  return results;
}

export async function getRampStatements(): Promise<RampStatement[]> {
  const token = await getRampToken();
  const res   = await fetch(`${RAMP_BASE}/statements?page_size=24`, {
    headers: { Authorization: `Bearer ${token}` },
    cache:   "no-store",
  });
  const data  = await res.json();
  if (data.error_v2) throw new Error(`Ramp statements: ${data.error_v2.message}`);

  return (data.data ?? []).map((s: Record<string, unknown>) => {
    const sec = ((s.balance_sections as Record<string, unknown>[])?.[0] ?? {}) as Record<string, unknown>;
    return {
      id:             s.id as string,
      end_date:       s.end_date as string,
      charges:        parseAmount(sec.charges),
      credits:        parseAmount(sec.credits),
      payments:       parseAmount(sec.payments),
      ending_balance: parseAmount(sec.ending_balance),
      statement_url:  (s.statement_url as string | null) ?? null,
    };
  });
}

export interface RampBankAccount {
  id:           string;
  name:         string;
  account_type: string;
}

export interface RampBankLine {
  id:                       string;
  amount:                   number;  // USD dollars, unsigned magnitude
  currency_code:            string;
  date:                     string;  // ISO
  description:              string;  // Withdrawal | Deposit | Interest | Vendor Payment | …
  source_account_name:      string | null;
  destination_account_name: string | null;
}

/** Normalize a counterparty/account name into a stable key (lowercase, single-spaced). */
export function normalizeCounterparty(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export async function getRampBankAccounts(): Promise<RampBankAccount[]> {
  const token = await getRampToken();
  const res   = await fetch(`${RAMP_BASE}/banking/accounts`, {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
  });
  const data  = await res.json();
  if (data.error_v2) throw new Error(`Ramp banking accounts: ${data.error_v2.message}`);
  return (data.data ?? []).map((a: Record<string, unknown>) => ({
    id: a.id as string, name: (a.name as string) ?? "", account_type: (a.account_type as string) ?? "",
  }));
}

export async function getRampBankTransactions(): Promise<RampBankLine[]> {
  const token = await getRampToken();
  const results: RampBankLine[] = [];

  let url: string | null = `${RAMP_BASE}/banking/syncable-transactions?page_size=100`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    if (data.error_v2) throw new Error(`Ramp banking transactions: ${data.error_v2.message}`);

    for (const t of data.data ?? []) {
      results.push({
        id:                       t.id,
        amount:                   parseAmount(t.amount),
        currency_code:            t.amount?.currency_code ?? "USD",
        date:                     t.date ?? "",
        description:              t.description ?? "",
        source_account_name:      t.source_account_name ?? null,
        destination_account_name: t.destination_account_name ?? null,
      });
    }
    url = data.page?.next ?? null;
  }
  return results;
}
