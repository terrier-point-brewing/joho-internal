# Ramp Bills → Expenses (line-item grain) + Accounting Sign Convention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest Ramp **bill-pay** records into the existing `expenses` table at **line-item grain**, and flip the money-column sign convention to accounting style (outflow negative, displayed in brackets), so the Transactions → Expenses tab shows card spend and bills in one clean ledger.

**Architecture:** The `expenses` table is already source-agnostic (`source='ramp'`). We add a `ramp_object` discriminator (`card`|`bill`|`bank`), a per-line-item bill mapper that reuses the existing GL auto-map path, and a one-time sign flip of existing rows. The Ramp API client gains `getRampBills`; the sync route/cron/webhook fetch bills alongside transactions and feed one shared `syncExpenseRecords` core.

**Tech Stack:** Next.js 16 (App Router, TS), Supabase Postgres (raw SQL migrations), Ramp REST API (raw `fetch`), Vitest.

**This is Plan A of two.** Plan B (separate) adds the operating **bank-account ledger** (`/banking/syncable-transactions`), its classifier, the counterparty→CoA rule table, and a Bank Ledger tab. Plan A establishes the `ramp_object` column, the sign convention, and the shared sync core that Plan B builds on. Full spike findings & design basis: `docs/ramp-ledger-ingest.md`.

## Global Constraints

- **Migrations are append-only.** Add a new file in `supabase/migrations/`; never edit an existing one. Number after the latest present file (this plan assumes `20260724_…`; bump if a higher number exists at execution time).
- **`lib/` modules ship with co-located `*.test.ts`.** CI runs `npm run test`; do not drop `lib/` coverage below the `vitest.config.ts` threshold floor.
- **Sign convention (locked):** money-column `amount_cents` is signed by cash direction — **outflow negative, inflow positive**. Display uses `formatCurrencyCents`, which already renders negatives as accounting brackets `($25.00)` and exact zero as the em-dash sentinel. Never hand-roll money display.
- **No raw colors.** Use token utilities only (`text-success`, `text-danger`, `text-muted`, `bg-surface-*`, etc.). No `zinc/amber/red/green/blue/gray`.
- **Route handlers use the Supabase admin client** (`createSupabaseAdminClient`) and `apiError()` for error JSON. No business logic in `app/api/**` — it lives in `lib/`.
- **Ramp amounts** arrive as `{ amount, minor_unit_conversion_rate, currency_code }`; divide `amount` by `minor_unit_conversion_rate` (default 100) for dollars. `parseAmount` in `lib/ramp.ts` already does this.

---

### Task 1: Migration — `ramp_object` discriminator + sign flip

**Files:**
- Create: `supabase/migrations/20260724_expenses_ramp_object_and_sign.sql`

**Interfaces:**
- Produces: `expenses.ramp_object` column (`'card'|'bill'|'bank'`), and existing `expenses.amount_cents` values negated to the new outflow-negative convention.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260724_expenses_ramp_object_and_sign.sql
-- Two coupled changes to the source-agnostic expenses ledger:
--
-- 1. ramp_object — which Ramp resource a row came from. Existing rows are all
--    card transactions; bills (this plan) and bank lines (Plan B) reuse the same
--    table with source='ramp' and are told apart by this column.
-- 2. Sign convention flip — move to accounting style: amount_cents is now signed
--    by CASH DIRECTION (outflow negative, inflow positive). Existing rows stored
--    spend as POSITIVE; negate them once so the whole ledger is consistent.
--
-- WARNING: the UPDATE is a one-time, NON-idempotent negation. Migrations run
-- exactly once (tracked), so this is safe as a forward migration — do NOT re-run
-- it by hand against a DB that already has it applied.

alter table public.expenses
  add column ramp_object text not null default 'card'
    check (ramp_object in ('card', 'bill', 'bank'));
-- Existing rows are correctly defaulted to 'card'; drop the default so new
-- inserts must state their object explicitly.
alter table public.expenses alter column ramp_object drop default;

create index if not exists idx_expenses_ramp_object on public.expenses (ramp_object);

-- Flip existing spend (positive) to outflow-negative; existing credits/refunds
-- (negative) become positive inflows. One-time.
update public.expenses set amount_cents = -amount_cents;

comment on column public.expenses.amount_cents is
  'Signed by cash direction: outflow (spend) negative, inflow (refund/credit) positive. Integer cents.';
comment on column public.expenses.ramp_object is
  'Which Ramp resource this row came from: card | bill | bank.';
```

- [ ] **Step 2: Verify the SQL parses (dry lint)**

Run: `grep -c "alter table" supabase/migrations/20260724_expenses_ramp_object_and_sign.sql`
Expected: `2`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260724_expenses_ramp_object_and_sign.sql
git commit -m "feat(finance): add expenses.ramp_object + flip to accounting sign convention"
```

> **Prod apply is manual and gated** (see memory: orchestrator applies per-migration after explicit OK + backup). This task only authors the file.

---

### Task 2: Ramp API client — scopes, `getRampBills`, GL-code fix

**Files:**
- Modify: `lib/ramp.ts` (`RAMP_SCOPES` line 5-6; `extractGlAccount` lines 96-126; add bill types + `getRampBills` near line 180)
- Test: `lib/ramp.test.ts`

**Interfaces:**
- Produces:
  - `RAMP_SCOPES` extended with `bills:read banking:read transfers:read accounting:read`.
  - `extractGlAccount(txn: any): RampGlAccount | null` — now reads the QuickBooks account **number** from `external_code` (falling back to `external_id`).
  - `interface RampBillLineItem { amount: number; memo: string | null; accounting_field_selections: unknown[] }`
  - `interface RampBill { id: string; amount: number; currency_code: string; vendor_name: string; status: string; issued_at: string; accounting_date: string; due_at: string | null; memo: string | null; invoice_number: string | null; line_items: RampBillLineItem[] }`
  - `getRampBills(from?: string, to?: string): Promise<RampBill[]>` — paginated; filters client-side by `accounting_date` within `[from, to]` when provided.

- [ ] **Step 1: Write the failing test for the GL-code fix**

Add to `lib/ramp.test.ts`:

```ts
import { extractGlAccount } from "./ramp";

describe("extractGlAccount", () => {
  it("reads the QuickBooks account number from external_code, not external_id", () => {
    const gl = extractGlAccount({
      line_items: [{
        accounting_field_selections: [{
          id: "opt-1",
          name: "COST OF GOODS SOLD (COGS):Raw Materials",
          external_id: "1150040025",   // Ramp internal id — NOT the account number
          external_code: "5110",        // the QuickBooks account number
          category_info: { type: "GL_ACCOUNT", name: "Category" },
        }],
      }],
    });
    expect(gl).toEqual({
      id: "opt-1",
      external_id: "5110",
      name: "COST OF GOODS SOLD (COGS):Raw Materials",
    });
  });

  it("falls back to external_id when external_code is absent", () => {
    const gl = extractGlAccount({
      accounting_field_selections: [{
        id: "opt-2", name: "Meals", external_id: "6000", external_code: null,
        category_info: { type: "GL_ACCOUNT" },
      }],
    });
    expect(gl?.external_id).toBe("6000");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -- lib/ramp.test.ts`
Expected: FAIL — first test gets `external_id: "1150040025"` (current code reads `sel.external_id`).

- [ ] **Step 3: Fix `extractGlAccount` to prefer `external_code`**

In `lib/ramp.ts`, inside `extractGlAccount`, replace the account-extraction block (currently lines ~112-124):

```ts
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
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run test -- lib/ramp.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend scopes and add bill types + `getRampBills`**

In `lib/ramp.ts`, change `RAMP_SCOPES` (lines 5-6):

```ts
const RAMP_SCOPES    =
  "transactions:read statements:read cards:read users:read business:read reimbursements:read bills:read banking:read transfers:read accounting:read";
```

Add near the other interfaces (after `RampStatement`):

```ts
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
  line_items:      RampBillLineItem[];
}
```

Add the fetcher after `getRampTransactions`:

```ts
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
```

- [ ] **Step 6: Run the full ramp test file**

Run: `npm run test -- lib/ramp.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/ramp.ts lib/ramp.test.ts
git commit -m "feat(ramp): add getRampBills + bills/banking scopes + external_code GL fix"
```

---

### Task 3: `ExpenseRecord` gains `ramp_object`

**Files:**
- Modify: `lib/finance/expenses.ts` (lines 8-37)

**Interfaces:**
- Produces: `export type RampObject = "card" | "bill" | "bank"`, and `ExpenseRecord.ramp_object: RampObject`.

- [ ] **Step 1: Add the type and field**

In `lib/finance/expenses.ts`, after the `ExpenseSource` type (line 9):

```ts
/** Which Ramp resource an expense row originated from. */
export type RampObject = "card" | "bill" | "bank";
```

In `interface ExpenseRecord`, add as the second field (after `source`):

```ts
  ramp_object:           RampObject;
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: errors ONLY in `rampExpenses.ts` (its `rampTxnToExpenseRecord` doesn't set `ramp_object` yet) — fixed in Task 4. No errors in `expenses.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add lib/finance/expenses.ts
git commit -m "feat(finance): add ramp_object discriminator to ExpenseRecord"
```

---

### Task 4: Sign flip for card txns + extract shared `syncExpenseRecords` core

**Files:**
- Modify: `lib/finance/rampExpenses.ts` (`rampTxnToExpenseRecord` lines 36-60; `syncRampExpenses` lines 68-185)
- Test: `lib/finance/rampExpenses.test.ts`

**Interfaces:**
- Consumes: `RampObject` (Task 3), `getRampBills`/`RampBill` (Task 2).
- Produces:
  - `rampTxnToExpenseRecord(txn)` now sets `ramp_object: "card"` and `amount_cents` **negated** (outflow negative).
  - `syncExpenseRecords(supabase: AdminClient, records: ExpenseRecord[]): Promise<RampSyncResult>` — the source-agnostic upsert+auto-map core (was the body of `syncRampExpenses`).
  - `syncRampExpenses(supabase, txns)` retained as a thin wrapper over `syncExpenseRecords`.

- [ ] **Step 1: Update the card-mapper tests for the new sign + ramp_object**

In `lib/finance/rampExpenses.test.ts`, change the two assertions in the first `describe`:
- `amount_cents: 1234` → `amount_cents: -1234`
- add `ramp_object: "card",` to the `toMatchObject` in the first test.
- in the second test add: `expect(r.ramp_object).toBe("card");`

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -- lib/finance/rampExpenses.test.ts`
Expected: FAIL — `amount_cents` is `1234`, `ramp_object` undefined.

- [ ] **Step 3: Update `rampTxnToExpenseRecord`**

In `lib/finance/rampExpenses.ts`, in the returned object of `rampTxnToExpenseRecord`, change:

```ts
    source:                SOURCE,
    ramp_object:           "card",
    source_transaction_id: txn.id,
    amount_cents:          -dollarsToCents(txn.amount),   // outflow negative
```

(The rest of the object is unchanged. `dollarsToCents` and `SOURCE` already imported.)

- [ ] **Step 4: Extract `syncExpenseRecords`**

In `lib/finance/rampExpenses.ts`, change the signature of the sync function and its first line. Rename `syncRampExpenses` to `syncExpenseRecords`, take `records` directly, and delete the `const records = txns.map(...)` line:

```ts
export async function syncExpenseRecords(
  supabase: AdminClient,
  records: ExpenseRecord[],
): Promise<RampSyncResult> {
  // (body is unchanged from here down — it already operates on `records`)
  // Chart of accounts — for auto-matching new external accounts.
  const { data: accountRows, error: coaErr } = await supabase
  ...
```

Then add the thin back-compat wrapper right below it:

```ts
/** Back-compat: sync a batch of Ramp card transactions. */
export async function syncRampExpenses(
  supabase: AdminClient,
  txns: RampTransaction[],
): Promise<RampSyncResult> {
  return syncExpenseRecords(supabase, txns.map(rampTxnToExpenseRecord));
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npm run test -- lib/finance/rampExpenses.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/finance/rampExpenses.ts lib/finance/rampExpenses.test.ts
git commit -m "refactor(finance): syncExpenseRecords core + card outflow-negative sign + ramp_object"
```

---

### Task 5: Bill → expense records at line-item grain

**Files:**
- Modify: `lib/finance/rampExpenses.ts` (add `rampBillToExpenseRecords`)
- Test: `lib/finance/rampExpenses.test.ts`

**Interfaces:**
- Consumes: `RampBill`, `extractGlAccount` (Task 2); `dollarsToCents`, `ExpenseRecord` (existing).
- Produces: `rampBillToExpenseRecords(bill: RampBill): ExpenseRecord[]` — one record per line item; `source_transaction_id = "${bill.id}:${index}"`; `ramp_object: "bill"`; `amount_cents` negated; GL from each line's `accounting_field_selections`. A bill with no line items yields one record keyed `"${bill.id}:0"` coded uncoded.

- [ ] **Step 1: Write the failing tests**

Add to `lib/finance/rampExpenses.test.ts`:

```ts
import { rampBillToExpenseRecords } from "./rampExpenses";
import type { RampBill } from "@/lib/ramp";

function glSelection(name: string, code: string) {
  return { id: `opt-${code}`, name, external_id: "internal", external_code: code, category_info: { type: "GL_ACCOUNT" } };
}

function bill(over: Partial<RampBill> = {}): RampBill {
  return {
    id: "b1", amount: 130.44, currency_code: "USD", vendor_name: "RahrBSG",
    status: "PAID", issued_at: "2026-05-19T00:00:00Z", accounting_date: "2026-05-19T00:00:00Z",
    due_at: "2026-06-18T00:00:00Z", memo: "malt", invoice_number: "INV-1",
    line_items: [
      { amount: 100.00, memo: "malt", accounting_field_selections: [glSelection("COGS:Raw Materials", "5110")] },
      { amount: 30.44,  memo: "freight", accounting_field_selections: [glSelection("COGS:Freight", "5120")] },
    ],
    ...over,
  };
}

describe("rampBillToExpenseRecords", () => {
  it("emits one outflow-negative record per line item with its own GL account", () => {
    const recs = rampBillToExpenseRecords(bill());
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({
      source: "ramp", ramp_object: "bill", source_transaction_id: "b1:0",
      amount_cents: -10000, merchant_name: "RahrBSG", state: "PAID",
      accounting_date: "2026-05-19", external_account_code: "5110",
      external_account_name: "COGS:Raw Materials", memo: "malt",
    });
    expect(recs[1]).toMatchObject({ source_transaction_id: "b1:1", amount_cents: -3044, external_account_code: "5120" });
    expect(recs[0].card_holder_name).toBeNull();
    expect(recs[0].department_name).toBeNull();
  });

  it("falls back to a single uncoded record when a bill has no line items", () => {
    const recs = rampBillToExpenseRecords(bill({ line_items: [] }));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ source_transaction_id: "b1:0", amount_cents: -13044, external_account_id: null });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run test -- lib/finance/rampExpenses.test.ts`
Expected: FAIL — `rampBillToExpenseRecords` is not exported.

- [ ] **Step 3: Implement `rampBillToExpenseRecords`**

Add to `lib/finance/rampExpenses.ts` (import `extractGlAccount`, `type RampBill` from `@/lib/ramp` at top):

```ts
/**
 * Shape a Ramp bill into one ExpenseRecord PER LINE ITEM. Bills carry GL coding
 * per line and may split one invoice across accounts, so line-item grain keeps
 * statements accurate. source_transaction_id namespaces the line index under the
 * bill id so re-syncs upsert idempotently. A bill with no line items yields a
 * single uncoded record for the whole total.
 */
export function rampBillToExpenseRecords(bill: RampBill): ExpenseRecord[] {
  const day = bill.accounting_date ? bill.accounting_date.slice(0, 10) : null;

  const base = {
    source:            SOURCE,
    ramp_object:       "bill" as const,
    currency_code:     bill.currency_code || "USD",
    merchant_name:     bill.vendor_name || null,
    merchant_category: null,
    sk_category_name:  null,
    state:             bill.status || null,
    card_holder_name:  null,
    department_name:   null,
    transaction_time:  bill.issued_at || null,
    accounting_date:   day,
  };

  if (bill.line_items.length === 0) {
    return [{
      ...base,
      source_transaction_id: `${bill.id}:0`,
      amount_cents:          -dollarsToCents(bill.amount),
      memo:                  bill.memo,
      external_account_id:   null,
      external_account_name: null,
      external_account_code: null,
    }];
  }

  return bill.line_items.map((li, i) => {
    const gl = extractGlAccount({ accounting_field_selections: li.accounting_field_selections });
    return {
      ...base,
      source_transaction_id: `${bill.id}:${i}`,
      amount_cents:          -dollarsToCents(li.amount),
      memo:                  li.memo ?? bill.memo,
      external_account_id:   gl?.id ?? null,
      external_account_name: gl?.name ?? null,
      external_account_code: gl?.external_id ?? null,
    };
  });
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npm run test -- lib/finance/rampExpenses.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/finance/rampExpenses.ts lib/finance/rampExpenses.test.ts
git commit -m "feat(finance): map Ramp bills to expenses at line-item grain"
```

---

### Task 6: Wire bills into sync route, cron, and webhook

**Files:**
- Modify: `app/api/finance/expenses/sync/route.ts` (lines 10-33)
- Modify: `app/api/cron/ramp-expenses-sync/route.ts` (lines 10-37)
- Modify: `app/api/webhooks/ramp/route.ts` (lines 3-5, 89-112)
- Modify: `lib/ramp/webhook.ts` (`isReconcilableRampEvent` lines 40-51)
- Test: `lib/ramp/webhook.test.ts`

**Interfaces:**
- Consumes: `getRampBills`, `rampBillToExpenseRecords`, `syncExpenseRecords`, `rampTxnToExpenseRecord`.

- [ ] **Step 1: Failing test — bill events are reconcilable**

In `lib/ramp/webhook.test.ts`, add to the `isReconcilableRampEvent` describe:

```ts
it("treats bill events as reconcilable", () => {
  expect(isReconcilableRampEvent("bill.created")).toBe(true);
  expect(isReconcilableRampEvent("bill.paid")).toBe(true);
});
it("still ignores the verification handshake", () => {
  expect(isReconcilableRampEvent("webhooks.verification")).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -- lib/ramp/webhook.test.ts`
Expected: FAIL — `bill.created` returns false.

- [ ] **Step 3: Extend `isReconcilableRampEvent`**

In `lib/ramp/webhook.ts`, replace the return in `isReconcilableRampEvent`:

```ts
export function isReconcilableRampEvent(type: unknown): boolean {
  return typeof type === "string" && (type.startsWith("transactions.") || type.startsWith("bill."));
}
```

Update its doc comment's parenthetical to note bills now trigger a re-sync.

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run test -- lib/ramp/webhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the sync route to fetch txns + bills**

Replace the body of `POST` in `app/api/finance/expenses/sync/route.ts` (imports + try block):

```ts
import { getRampTransactions, getRampBills } from "@/lib/ramp";
import { rampTxnToExpenseRecord, rampBillToExpenseRecords, syncExpenseRecords } from "@/lib/finance/rampExpenses";
```

```ts
  try {
    const [txns, bills] = await Promise.all([getRampTransactions(from, to), getRampBills(from, to)]);
    const records = [
      ...txns.map(rampTxnToExpenseRecord),
      ...bills.flatMap(rampBillToExpenseRecords),
    ];
    const supabase = createSupabaseAdminClient();
    const result = await syncExpenseRecords(supabase, records);
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err);
  }
```

- [ ] **Step 6: Update the cron the same way**

In `app/api/cron/ramp-expenses-sync/route.ts`, change the import and the `runCronJob` callback:

```ts
import { getRampTransactions, getRampBills } from "@/lib/ramp";
import { rampTxnToExpenseRecord, rampBillToExpenseRecords, syncExpenseRecords } from "@/lib/finance/rampExpenses";
```

```ts
  const outcome = await runCronJob("ramp-expenses-sync", async () => {
    const [txns, bills] = await Promise.all([getRampTransactions(fromStr, toStr), getRampBills(fromStr, toStr)]);
    const records = [...txns.map(rampTxnToExpenseRecord), ...bills.flatMap(rampBillToExpenseRecords)];
    const supabase = createSupabaseAdminClient();
    const result = await syncExpenseRecords(supabase, records);
    return { ...result, window: { from: fromStr, to: toStr } };
  });
```

- [ ] **Step 7: Update the webhook background re-sync**

In `app/api/webhooks/ramp/route.ts`, change the import (line 3-4) and the `after(...)` fetch:

```ts
import { getRampTransactions, getRampBills } from "@/lib/ramp";
import { rampTxnToExpenseRecord, rampBillToExpenseRecords, syncExpenseRecords } from "@/lib/finance/rampExpenses";
```

Inside `after(async () => { ... })`, replace the txns fetch + sync:

```ts
      const [txns, bills] = await Promise.all([getRampTransactions(fromStr, toStr), getRampBills(fromStr, toStr)]);
      const records = [...txns.map(rampTxnToExpenseRecord), ...bills.flatMap(rampBillToExpenseRecords)];
      const supabase = createSupabaseAdminClient();
      const result = await syncExpenseRecords(supabase, records);
```

- [ ] **Step 8: Run tests + typecheck**

Run: `npm run test -- lib/ramp/webhook.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add app/api/finance/expenses/sync/route.ts app/api/cron/ramp-expenses-sync/route.ts app/api/webhooks/ramp/route.ts lib/ramp/webhook.ts lib/ramp/webhook.test.ts
git commit -m "feat(finance): sync Ramp bills alongside card transactions (route + cron + webhook)"
```

---

### Task 7: Surface bills on the Expenses tab (type badge + sign display)

**Files:**
- Modify: `app/api/finance/expenses/route.ts` (GET select, line 26-48)
- Modify: `app/finance/transactions/expenses/page.tsx` (`ExpenseRow` type; amount cell line 110-112; type badge; empty-state copy)

**Interfaces:**
- Consumes: `expenses.ramp_object` column, `formatCurrencyCents` (already accounting-bracketed).

- [ ] **Step 1: Add `ramp_object` to the API select**

In `app/api/finance/expenses/route.ts`, add `ramp_object,` to the `.select(...)` list (after `source,`).

- [ ] **Step 2: Add `ramp_object` to the page's `ExpenseRow` type**

In `app/finance/transactions/expenses/page.tsx`, in `interface ExpenseRow`, add after `source: string;`:

```ts
  ramp_object: "card" | "bill" | "bank";
```

- [ ] **Step 3: Fix the amount cell to use plain accounting display (drop the credit-green inversion)**

Replace the amount `<td>` (lines ~110-112) with:

```tsx
        <td className="px-4 py-2 text-right font-mono tabular-nums text-strong">
          {formatCurrencyCents(e.amount_cents)}
        </td>
```

(`formatCurrencyCents` already renders negatives — now the normal outflow — as `($25.00)`. No token-color inversion needed.)

- [ ] **Step 4: Add a small type badge next to the merchant**

In the merchant `<td>` (the `<div className="truncate ...">{e.merchant_name ?? "—"}</div>`), append a badge when the row is a bill:

```tsx
        <td className="px-4 py-2 text-body">
          <div className="flex items-center gap-1.5">
            <span className="truncate max-w-[240px]">{e.merchant_name ?? "—"}</span>
            {e.ramp_object === "bill" && (
              <span className="shrink-0 px-1 py-0.5 rounded text-[9px] font-medium bg-surface-mid text-muted uppercase tracking-wide">Bill</span>
            )}
          </div>
          {(e.memo || e.card_holder_name) && (
            <div className="text-[10px] text-faint truncate max-w-[240px]">
              {[e.memo, e.card_holder_name].filter(Boolean).join(" · ")}
            </div>
          )}
        </td>
```

- [ ] **Step 5: Update the empty-state copy**

Change the empty-state line (currently `Click "Sync Ramp" to import transactions.`) to:

```tsx
          <p className="text-xs text-faint mt-1">Click &ldquo;Sync Ramp&rdquo; to import transactions and bills.</p>
```

- [ ] **Step 6: Verify in the browser**

Start the dev server (`preview_start`), open `/finance/transactions/expenses`, click **Sync Ramp** for the current year. Confirm via `preview_snapshot`: bill rows appear with a **Bill** badge, amounts render in accounting form (outflows in brackets), and totals compute. Check `preview_console_logs` for errors.

- [ ] **Step 7: Run lint + build**

Run: `npm run lint && npm run build`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add app/api/finance/expenses/route.ts app/finance/transactions/expenses/page.tsx
git commit -m "feat(finance): show Ramp bills on Expenses tab with type badge + accounting amounts"
```

---

## Self-Review

**Spec coverage:**
- Bills ingested → Tasks 2, 5, 6. ✅
- Line-item grain → Task 5 (`"${bill.id}:${i}"`, one record per line). ✅
- Unified into `expenses` table (differentiation via `ramp_object`) → Tasks 1, 3. ✅
- Accounting sign convention, negatives in brackets → Task 1 (flip) + Task 7 (display; formatter already brackets). ✅
- GL auto-map reuse for bills → Task 5 uses `extractGlAccount` → existing `syncExpenseRecords` auto-map path. ✅
- `external_code` GL fix (bonus from spike) → Task 2. ✅
- Shared sync core for Plan B to extend → Task 4 (`syncExpenseRecords`). ✅
- Bank-account ledger → **out of scope, Plan B** (noted in header). ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✅

**Type consistency:** `RampObject`/`ramp_object` used identically across expenses.ts, rampExpenses.ts, route, page. `syncExpenseRecords(supabase, records)` signature matches all three callers (route, cron, webhook). `getRampBills`/`RampBill`/`RampBillLineItem` consistent between ramp.ts and its consumers. `rampBillToExpenseRecords` returns `ExpenseRecord[]` consumed via `.flatMap`. ✅
```
