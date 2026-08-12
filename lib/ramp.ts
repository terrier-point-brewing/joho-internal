import { env } from "./env";

const RAMP_TOKEN_URL = "https://api.ramp.com/developer/v1/token";
const RAMP_BASE      = "https://api.ramp.com/developer/v1";
const RAMP_SCOPES    =
  "transactions:read statements:read cards:read users:read business:read reimbursements:read bills:read banking:read transfers:read accounting:read treasury:read";

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
  sync_status:                      string | null;  // raw Ramp QB sync_status: NOT_SYNC_READY | SYNC_READY | SYNCED
  qb_synced_at:                     string | null;  // ISO; when Ramp pushed it to QuickBooks (from the API's synced_at)
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

export interface RampBillLineItem {
  amount:                      number;        // USD dollars for this line
  memo:                        string | null;
  accounting_field_selections: unknown[];     // GL coding lives here (per line)
}

export interface RampBill {
  id:              string;
  amount:          number;   // USD dollars, bill total
  currency_code:   string;
  vendor_name:     string;
  status:          string;   // OPEN | PAID
  issued_at:       string;   // ISO
  accounting_date: string;   // ISO
  due_at:          string | null;
  memo:            string | null;
  invoice_number:  string | null;
  sync_status:     string | null;  // raw Ramp QB sync_status: NOT_SYNCED | BILL_SYNCED | BILL_AND_PAYMENT_SYNCED
  remote_id:       string | null;  // the QuickBooks object id Ramp created for this bill
  line_items:      RampBillLineItem[];
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
    // from `category_info`, which only ever holds the dimension label. The
    // QuickBooks account NUMBER lives in `external_code`; `external_id` is a Ramp
    // internal id, so prefer `external_code` for the code we match on.
    const id   = sel.id as string | undefined;
    const name = sel.name as string | undefined;
    const code = (sel.external_code as string | undefined) ?? (sel.external_id as string | undefined);
    if (!id && !name && !code) continue;

    return {
      id:          id ?? (code ?? name)!,
      external_id: code ?? null,
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
        sync_status:                      t.sync_status ?? null,
        qb_synced_at:                     t.synced_at ?? null,
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

/**
 * Pull Ramp bill-pay records. The list endpoint doesn't reliably honor a date
 * filter, so we page through all and filter client-side by accounting_date when
 * a window is given (bill volume is low — monthly, not per-swipe). Line-item
 * amounts are pre-divided to dollars; `accounting_field_selections` are passed
 * through raw so `extractGlAccount` can read each line's GL account.
 */
export async function getRampBills(from?: string, to?: string): Promise<RampBill[]> {
  const token = await getRampToken();
  const results: RampBill[] = [];

  let url: string | null = `${RAMP_BASE}/bills?page_size=100`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    if (data.error_v2) throw new Error(`Ramp bills: ${data.error_v2.message}`);

    for (const b of data.data ?? []) {
      const accountingDate: string = b.accounting_date ?? b.issued_at ?? "";
      const day = accountingDate.slice(0, 10);
      if (from && day && day < from) continue;
      if (to && day && day > to) continue;

      results.push({
        id:              b.id,
        amount:          parseAmount(b.amount),
        currency_code:   b.amount?.currency_code ?? "USD",
        vendor_name:     b.vendor?.name ?? "",
        status:          b.status ?? "",
        issued_at:       b.issued_at ?? "",
        accounting_date: accountingDate,
        due_at:          b.due_at ?? null,
        memo:            b.memo ?? b.vendor_memo ?? null,
        invoice_number:  b.invoice_number ?? null,
        sync_status:     b.sync_status ?? null,
        remote_id:       b.remote_id ?? null,
        line_items: (b.line_items ?? []).map((li: Record<string, unknown>) => ({
          amount:                      parseAmount(li.amount),
          memo:                        (li.memo as string | null) ?? null,
          accounting_field_selections: (li.accounting_field_selections as unknown[]) ?? [],
        })),
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

/**
 * A transfer out of the Ramp Business Account. In practice these are the ACH
 * pulls that settle the monthly card statement — the endpoint is sparse (no
 * description/counterparty/type), so the card-statement link is recovered by
 * reconciling the amount against statement charges (see classifyTransfers).
 */
export interface RampTransfer {
  id:         string;
  amount:     number;   // USD dollars
  status:     string;
  created_at: string;   // ISO
}

/** Pull Ramp Business Account transfers, bounded client-side to the window (created_at). */
export async function getRampTransfers(from?: string, to?: string): Promise<RampTransfer[]> {
  const token = await getRampToken();
  const results: RampTransfer[] = [];

  let url: string | null = `${RAMP_BASE}/transfers?page_size=100`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    if (data.error_v2) throw new Error(`Ramp transfers: ${data.error_v2.message}`);

    for (const t of data.data ?? []) {
      const day = (t.created_at ?? "").slice(0, 10);
      if (from && day && day < from) continue;
      if (to && day && day > to) continue;
      results.push({
        id:         t.id,
        amount:     parseAmount(t.amount),
        status:     t.status ?? "",
        created_at: t.created_at ?? "",
      });
    }
    url = data.page?.next ?? null;
  }
  return results;
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
  sync_status:              string | null;  // raw Ramp QB sync_status for the bank line
}

/** Normalize a counterparty/account name into a stable key (lowercase, single-spaced). */
export function normalizeCounterparty(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** One day's closing balance on a Ramp treasury (banking) account. */
export interface RampDailyBalance {
  date:          string;  // "YYYY-MM-DD", the day the balance is for
  balance_cents: number;  // signed minor units, normalized to hundredths
  currency_code: string;
}

/**
 * One of Ramp's money objects, in cents.
 *
 * Ramp reports money as an integer in minor units plus the rate that converts
 * it to major units, so for USD `amount` already IS cents. It is still divided
 * through `minor_unit_conversion_rate` and re-scaled rather than passed
 * straight through, so a currency with different precision could not silently
 * arrive off by a factor of ten. `parseAmount` above is not reused because it
 * returns dollars and balances are stored in cents.
 */
function amountToCents(raw: unknown): { cents: number; currency_code: string } {
  const amount = (raw ?? {}) as Record<string, unknown>;
  const rate   = (amount.minor_unit_conversion_rate as number | undefined) ?? 100;
  const minor  = (amount.amount as number | undefined) ?? 0;
  return {
    cents:         Math.round((minor / rate) * 100),
    currency_code: (amount.currency_code as string | undefined) ?? "USD",
  };
}

/**
 * Daily balance history for a Ramp treasury account, used by the GL 1030
 * balance method. Needs `treasury:read`, already in RAMP_SCOPES above.
 *
 * Unlike Plaid's balance endpoint, this answers about the PAST, which is why
 * the Ramp balance method needs no daily capture cron -- a month end can always
 * be re-asked for. The CARD balance below is the opposite case, and the two are
 * worth reading together.
 *
 * This is the AVAILABLE balance. It can differ from a posted statement balance
 * when something is still pending on the last day of the month -- the balance
 * method's explainer copy says so to the operator.
 */
export async function getRampAccountBalanceHistory(
  accountId: string,
  startDate: string,  // "YYYY-MM-DD", inclusive
  endDate:   string,  // "YYYY-MM-DD", inclusive
): Promise<RampDailyBalance[]> {
  const token  = await getRampToken();
  const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
  const res    = await fetch(
    `${RAMP_BASE}/banking/accounts/${encodeURIComponent(accountId)}/balance-history?${params}`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json();
  if (data?.error_v2) throw new Error(`Ramp balance history: ${data.error_v2.message}`);
  if (!res.ok) throw new Error(`Ramp balance history: HTTP ${res.status}`);

  const rows: Record<string, unknown>[] = Array.isArray(data) ? data : (data?.data ?? []);
  return rows.map((r) => {
    const { cents, currency_code } = amountToCents(r.amount);
    return { date: String(r.date ?? "").slice(0, 10), balance_cents: cents, currency_code };
  });
}

/**
 * What is currently owed on the Ramp CARD program — the credit-card liability
 * behind GL 2110, not the treasury cash above.
 *
 * ── Why this endpoint and not the obvious ones ───────────────────────────────
 * Three candidates were checked against the live account before settling here.
 * `/limits` reports per-card spend within the current interval, which resets
 * monthly and is a budget rather than a debt (it also needs a scope this app is
 * not granted). `/statements` reports a real ending balance, but on Ramp's
 * BILLING cycle -- this business closes on the 26th -- so its figures answer
 * about a period no balance sheet ever asks for. Only this endpoint reports the
 * outstanding card balance itself.
 *
 * ── It answers only about NOW ────────────────────────────────────────────────
 * There is no as-of date and no history, which puts this on the Plaid side of
 * the line rather than the treasury side: a month-end card balance exists only
 * if something wrote it down that day. That is why this feeds the daily capture
 * -- see lib/finance/balances/rampCardCapture.ts.
 *
 * ── Settled vs pending ───────────────────────────────────────────────────────
 * Both are returned because they are genuinely different facts and the caller,
 * not this function, should decide which one its books mean. The balance method
 * uses the SETTLED figure; see the provider for why.
 */
export interface RampCardBalance {
  /** Charges that have actually posted, in cents. Positive means money owed. */
  settled_cents:           number;
  /** The same, plus card authorizations that have not settled yet. */
  including_pending_cents: number;
  currency_code:           string;
}

export async function getRampCardBalance(): Promise<RampCardBalance> {
  const token = await getRampToken();
  const res   = await fetch(`${RAMP_BASE}/business/balance`, {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json();
  if (data?.error_v2) throw new Error(`Ramp card balance: ${data.error_v2.message}`);
  if (!res.ok) throw new Error(`Ramp card balance: HTTP ${res.status}`);

  // Absent rather than zero. amountToCents would read a missing field as $0
  // owed, which is a plausible balance and an undetectable lie; a liability
  // that quietly reads as settled is exactly the failure worth refusing.
  const settled = data.card_balance_excluding_pending_amount;
  if (!settled || typeof settled !== "object") {
    throw new Error("Ramp card balance: the response carried no card balance");
  }

  const cleared = amountToCents(settled);
  return {
    settled_cents:           cleared.cents,
    including_pending_cents: amountToCents(data.card_balance_including_pending_amount).cents,
    currency_code:           cleared.currency_code,
  };
}

/** The Ramp business these credentials belong to. */
export interface RampBusiness {
  id:          string;
  legal_name:  string;
  /** The name printed on the cards, which is what an operator recognises. */
  card_name:   string;
}

export async function getRampBusiness(): Promise<RampBusiness> {
  const token = await getRampToken();
  const res   = await fetch(`${RAMP_BASE}/business`, {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json();
  if (data?.error_v2) throw new Error(`Ramp business: ${data.error_v2.message}`);
  if (!res.ok) throw new Error(`Ramp business: HTTP ${res.status}`);

  return {
    id:         data.id as string,
    legal_name: (data.business_name_legal as string | undefined) ?? "",
    card_name:  (data.business_name_on_card as string | undefined) ?? (data.business_name_legal as string | undefined) ?? "",
  };
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

/**
 * Pull bank-account (Ramp Business Account) money movement. The
 * syncable-transactions endpoint has no reliable server-side date filter, so we
 * bound the result client-side by each line's `date` when a window is given —
 * mirroring getRampBills — so callers only process (classify + upsert) the
 * window they asked for instead of the whole history on every sync.
 */
export async function getRampBankTransactions(from?: string, to?: string): Promise<RampBankLine[]> {
  const token = await getRampToken();
  const results: RampBankLine[] = [];

  let url: string | null = `${RAMP_BASE}/banking/syncable-transactions?page_size=100`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    if (data.error_v2) throw new Error(`Ramp banking transactions: ${data.error_v2.message}`);

    for (const t of data.data ?? []) {
      const day = (t.date ?? "").slice(0, 10);
      if (from && day && day < from) continue;
      if (to && day && day > to) continue;
      results.push({
        id:                       t.id,
        amount:                   parseAmount(t.amount),
        currency_code:            t.amount?.currency_code ?? "USD",
        date:                     t.date ?? "",
        description:              t.description ?? "",
        source_account_name:      t.source_account_name ?? null,
        destination_account_name: t.destination_account_name ?? null,
        sync_status:              t.sync_status ?? null,
      });
    }
    url = data.page?.next ?? null;
  }
  return results;
}
