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

export interface RampTransaction {
  id:                               string;
  amount:                           number;   // USD dollars (positive = spend, negative = refund/credit)
  currency_code:                    string;
  memo:                             string;
  merchant_category_code_description: string;
  sk_category_name:                 string | null;
  state:                            string;
  user_transaction_time:            string;   // ISO
  accounting_date:                  string;   // ISO
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

export async function getRampTransactions(from?: string, to?: string): Promise<RampTransaction[]> {
  const token   = await getRampToken();
  const results: RampTransaction[] = [];

  const params = new URLSearchParams({ page_size: "100" });
  if (from) params.set("from_date", from);
  if (to)   params.set("to_date",   to);

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
        merchant_category_code_description: t.merchant_category_code_description ?? "Other",
        sk_category_name:                 t.sk_category_name ?? null,
        state:                            t.state ?? "",
        user_transaction_time:            t.user_transaction_time ?? "",
        accounting_date:                  t.accounting_date ?? "",
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
