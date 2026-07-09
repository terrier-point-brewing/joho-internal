# Ramp Bank-Account Ledger — Classification, De-dup & Counterparty Mapping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest Ramp operating **bank-account** money movement (`/banking/syncable-transactions`) into the ledger — routing true operating-expense debits (Gusto, Erie) into `expenses` and everything else (interest income, transfers, bill/card settlements, deposits) into a new `ramp_bank_ledger` table — classified so statements never double-count.

**Architecture:** A pure `classifyBankLine` decides each line's `flow_type`, sign, P&L relevance, and target table from its `description` + counterparty (using the set of own account names). Operating-expense lines become `ExpenseRecord`s (`ramp_object='bank'`) coded via a new **counterparty→CoA** rule table; the rest become `ramp_bank_ledger` rows carrying `flow_type` + `affects_pl`. Anything unrecognized lands as `unclassified` for manual review — never silently dropped or booked. De-dup is achieved by classification: `Vendor Payment` and card-balance payments are settlements (excluded), so the underlying bill/card records aren't double-counted.

**Tech Stack:** Next.js 16 (App Router, TS), Supabase Postgres (raw SQL migrations), Ramp REST API (raw `fetch`), Vitest.

**This is Plan B of two.** It depends on **Plan A** (`docs/superpowers/plans/2026-07-08-ramp-bills-to-expenses.md`) having landed: `expenses.ramp_object`, the outflow-negative sign convention, `RampObject`, and the shared `syncExpenseRecords(supabase, records)` core. Full spike findings & design basis: `docs/ramp-ledger-ingest.md`.

## Global Constraints

- **Migrations are append-only.** New file in `supabase/migrations/`; number after the latest present (this plan assumes `20260725_…`; bump if higher exists).
- **`lib/` modules ship with co-located `*.test.ts`.** CI runs `npm run test`; keep `lib/` coverage above the `vitest.config.ts` floor. The classifier (`classifyBankLine`) is the drift-critical unit — test it exhaustively.
- **Sign convention (locked):** `amount_cents` signed by cash direction — outflow negative, inflow positive. `formatCurrencyCents` renders negatives as accounting brackets. Bank amounts arrive as unsigned magnitudes; sign is derived from the classified direction.
- **No silent drops or silent bookings.** Every bank line lands in exactly one table. Ambiguous lines are `flow_type='unclassified'` in `ramp_bank_ledger`, visible for manual coding. Never route an ambiguous line into `expenses`.
- **De-dup rule:** `Vendor Payment` → `bill_settlement`; card-balance payments → `card_settlement`; both `affects_pl=false`. Only direct external debits with no bill/card behind them become expenses.
- **No raw colors; token utilities only.** Route handlers use `createSupabaseAdminClient` + `apiError()`. Business logic in `lib/`, not `app/api/**`.

## Flow-type vocabulary (single source of truth)

```
type FlowType =
  | "operating_expense"  // direct external debit (Gusto, Erie) → routes to expenses, affects_pl
  | "interest_income"    // interest earned            → ramp_bank_ledger, affects_pl (income)
  | "internal_transfer"  // between own accounts        → ramp_bank_ledger, NOT P&L
  | "bill_settlement"    // Vendor Payment settling a bill → ramp_bank_ledger, NOT P&L (bill already booked)
  | "card_settlement"    // card-balance payment        → ramp_bank_ledger, NOT P&L (txns already booked)
  | "deposit"            // funds in (funding/other)    → ramp_bank_ledger, NOT P&L pending review
  | "unclassified";      // unrecognized                → ramp_bank_ledger, flagged for manual review
```

`operating_expense` is the **only** flow_type that routes to `expenses`; all others live in `ramp_bank_ledger`.

---

### Task 1: Migration — `ramp_bank_ledger`, `expense_counterparty_mappings`, expenses counterparty columns

**Files:**
- Create: `supabase/migrations/20260725_ramp_bank_ledger.sql`

**Interfaces:**
- Produces: table `ramp_bank_ledger`; table `expense_counterparty_mappings`; `expenses.counterparty_key` + `expenses.counterparty_label` columns.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260725_ramp_bank_ledger.sql
-- Operating bank-account money movement from Ramp.
--
--   1. ramp_bank_ledger — non-expense bank lines (interest income, internal
--      transfers, bill/card settlements, deposits, unclassified). Operating-
--      expense bank debits do NOT live here — they go to `expenses`
--      (ramp_object='bank'), coded via the counterparty rule table below.
--   2. expense_counterparty_mappings — reusable rule mapping a bank counterparty
--      (e.g. GUSTO, ERIE INSURANCE) to a chart_of_accounts row. Bank lines carry
--      no GL coding, so this is how their expenses get an account. Unlike GL
--      rules these don't auto-match by name (GUSTO ≠ "Payroll"); the user assigns.
--   3. expenses.counterparty_key/label — so bank-sourced expense rows re-resolve
--      their account from the counterparty rule on every sync.

-- ── ramp_bank_ledger ─────────────────────────────────────────────────────────
create table if not exists public.ramp_bank_ledger (
  id                    uuid        primary key default gen_random_uuid(),
  source                text        not null default 'ramp' check (source in ('ramp')),
  source_transaction_id text        not null,
  -- Signed by cash direction: outflow negative, inflow positive. Integer cents.
  amount_cents          integer     not null,
  currency_code         text        not null default 'USD',
  description           text,            -- Ramp's raw description (Withdrawal/Deposit/Interest/Vendor Payment)
  counterparty_name     text,            -- external party or own-account name
  source_account_name   text,
  destination_account_name text,
  flow_type             text        not null
                          check (flow_type in ('interest_income','internal_transfer','bill_settlement','card_settlement','deposit','unclassified')),
  affects_pl            boolean     not null,
  transaction_date      date,
  chart_of_accounts_id  uuid        references public.chart_of_accounts(id) on delete set null,
  mapping_source        text        not null default 'unmapped'
                          check (mapping_source in ('unmapped','rule','manual')),
  synced_at             timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint ramp_bank_ledger_source_txn_unique unique (source, source_transaction_id)
);

create index if not exists idx_ramp_bank_ledger_flow_type on public.ramp_bank_ledger (flow_type);
create index if not exists idx_ramp_bank_ledger_txn_date  on public.ramp_bank_ledger (transaction_date);

-- ── expense_counterparty_mappings ────────────────────────────────────────────
create table if not exists public.expense_counterparty_mappings (
  id                   uuid        primary key default gen_random_uuid(),
  source               text        not null default 'ramp' check (source in ('ramp')),
  -- Normalized counterparty key (lowercased/trimmed) — the join key.
  counterparty_key     text        not null,
  counterparty_label   text        not null,
  chart_of_accounts_id uuid        references public.chart_of_accounts(id) on delete set null,
  auto_matched         boolean     not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint expense_counterparty_mappings_source_key_unique unique (source, counterparty_key)
);

create index if not exists idx_expense_counterparty_mappings_coa
  on public.expense_counterparty_mappings (chart_of_accounts_id);

-- ── expenses: counterparty columns (for bank-sourced expense rows) ───────────
alter table public.expenses add column if not exists counterparty_key   text;
alter table public.expenses add column if not exists counterparty_label text;

-- ── triggers (reuse the shared updated_at fn from earlier migrations) ─────────
create trigger ramp_bank_ledger_updated_at
  before update on public.ramp_bank_ledger
  for each row execute procedure set_expense_updated_at();

create trigger expense_counterparty_mappings_updated_at
  before update on public.expense_counterparty_mappings
  for each row execute procedure set_expense_updated_at();

-- ── RLS (mirror expenses: authenticated read, admin/manager manage) ──────────
alter table public.ramp_bank_ledger              enable row level security;
alter table public.expense_counterparty_mappings enable row level security;

create policy "Authenticated users can read bank ledger"
  on public.ramp_bank_ledger for select using (auth.role() = 'authenticated');
create policy "Admins can manage bank ledger"
  on public.ramp_bank_ledger for all using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role in ('admin','manager')));

create policy "Authenticated users can read counterparty mappings"
  on public.expense_counterparty_mappings for select using (auth.role() = 'authenticated');
create policy "Admins can manage counterparty mappings"
  on public.expense_counterparty_mappings for all using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role in ('admin','manager')));
```

- [ ] **Step 2: Verify the SQL parses**

Run: `grep -c "create table" supabase/migrations/20260725_ramp_bank_ledger.sql`
Expected: `2`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260725_ramp_bank_ledger.sql
git commit -m "feat(finance): add ramp_bank_ledger + counterparty mappings + expenses counterparty cols"
```

> Prod apply is manual + gated (explicit OK + backup). This task only authors the file.

---

### Task 2: Ramp API client — bank transactions + accounts

**Files:**
- Modify: `lib/ramp.ts` (add types + fetchers)
- Test: `lib/ramp.test.ts`

**Interfaces:**
- Produces:
  - `interface RampBankAccount { id: string; name: string; account_type: string }`
  - `interface RampBankLine { id: string; amount: number; currency_code: string; date: string; description: string; source_account_name: string | null; destination_account_name: string | null }`
  - `getRampBankAccounts(): Promise<RampBankAccount[]>` — GET `/banking/accounts`.
  - `getRampBankTransactions(): Promise<RampBankLine[]>` — GET `/banking/syncable-transactions`, paginated.

- [ ] **Step 1: Write the failing test**

Add to `lib/ramp.test.ts`:

```ts
import { normalizeCounterparty } from "./ramp";

describe("normalizeCounterparty", () => {
  it("lowercases, trims, and collapses whitespace", () => {
    expect(normalizeCounterparty("  ERIE   INSURANCE ")).toBe("erie insurance");
    expect(normalizeCounterparty("GUSTO")).toBe("gusto");
    expect(normalizeCounterparty(null)).toBe("");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -- lib/ramp.test.ts`
Expected: FAIL — `normalizeCounterparty` not exported.

- [ ] **Step 3: Add types, `normalizeCounterparty`, and fetchers**

In `lib/ramp.ts` add:

```ts
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
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run test -- lib/ramp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ramp.ts lib/ramp.test.ts
git commit -m "feat(ramp): add bank-account transaction + account fetchers"
```

---

### Task 3: Extend expense mapping with counterparty rules

**Files:**
- Modify: `lib/finance/expenses.ts`
- Test: `lib/finance/expenses.test.ts`

**Interfaces:**
- Consumes: existing `RuleRef`, `MappingSource`.
- Produces:
  - `ExpenseRecord` gains `counterparty_key: string | null` and `counterparty_label: string | null`.
  - `interface CounterpartyRuleRef { counterparty_key: string; chart_of_accounts_id: string | null }`
  - `resolveExpenseMapping` signature extended: `(expense: { external_account_id: string | null; counterparty_key: string | null; mapping_source: MappingSource; chart_of_accounts_id: string | null }, glRules: Map<string, RuleRef>, counterpartyRules: Map<string, CounterpartyRuleRef>) => { chart_of_accounts_id: string | null; mapping_source: MappingSource }`

- [ ] **Step 1: Write the failing tests**

Add to `lib/finance/expenses.test.ts`:

```ts
import { resolveExpenseMapping, type RuleRef, type CounterpartyRuleRef } from "./expenses";

describe("resolveExpenseMapping with counterparty rules", () => {
  const gl = new Map<string, RuleRef>([["ext-1", { external_account_id: "ext-1", chart_of_accounts_id: "coa-gl" }]]);
  const cp = new Map<string, CounterpartyRuleRef>([["gusto", { counterparty_key: "gusto", chart_of_accounts_id: "coa-payroll" }]]);

  it("resolves via counterparty rule when there is no GL account", () => {
    const r = resolveExpenseMapping(
      { external_account_id: null, counterparty_key: "gusto", mapping_source: "unmapped", chart_of_accounts_id: null }, gl, cp);
    expect(r).toEqual({ chart_of_accounts_id: "coa-payroll", mapping_source: "rule" });
  });

  it("prefers the GL rule over the counterparty rule", () => {
    const r = resolveExpenseMapping(
      { external_account_id: "ext-1", counterparty_key: "gusto", mapping_source: "unmapped", chart_of_accounts_id: null }, gl, cp);
    expect(r.chart_of_accounts_id).toBe("coa-gl");
  });

  it("keeps a manual pin untouched", () => {
    const r = resolveExpenseMapping(
      { external_account_id: null, counterparty_key: "gusto", mapping_source: "manual", chart_of_accounts_id: "coa-pinned" }, gl, cp);
    expect(r).toEqual({ chart_of_accounts_id: "coa-pinned", mapping_source: "manual" });
  });

  it("is unmapped when neither key resolves", () => {
    const r = resolveExpenseMapping(
      { external_account_id: null, counterparty_key: "unknown", mapping_source: "unmapped", chart_of_accounts_id: null }, gl, cp);
    expect(r).toEqual({ chart_of_accounts_id: null, mapping_source: "unmapped" });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run test -- lib/finance/expenses.test.ts`
Expected: FAIL — `CounterpartyRuleRef` not exported / `resolveExpenseMapping` arity.

- [ ] **Step 3: Extend the types and resolver**

In `lib/finance/expenses.ts`:

Add the two fields to `ExpenseRecord` (after `external_account_code`):

```ts
  // For bank-sourced rows with no GL coding: the external party (Gusto, Erie),
  // used to resolve an account from the counterparty rule table.
  counterparty_key:      string | null;
  counterparty_label:    string | null;
```

Add the rule ref type (near `RuleRef`):

```ts
export interface CounterpartyRuleRef {
  counterparty_key:     string;
  chart_of_accounts_id: string | null;
}
```

Replace `resolveExpenseMapping` with:

```ts
/**
 * Resolve the effective CoA + source for an expense. Priority: a manual pin wins;
 * else a GL-account rule (card/bill coding); else a counterparty rule (bank
 * lines, which carry no GL); else unmapped.
 */
export function resolveExpenseMapping(
  expense: { external_account_id: string | null; counterparty_key: string | null; mapping_source: MappingSource; chart_of_accounts_id: string | null },
  glRules: Map<string, RuleRef>,
  counterpartyRules: Map<string, CounterpartyRuleRef>,
): { chart_of_accounts_id: string | null; mapping_source: MappingSource } {
  if (expense.mapping_source === "manual") {
    return { chart_of_accounts_id: expense.chart_of_accounts_id, mapping_source: "manual" };
  }
  if (expense.external_account_id) {
    const rule = glRules.get(expense.external_account_id);
    if (rule?.chart_of_accounts_id) return { chart_of_accounts_id: rule.chart_of_accounts_id, mapping_source: "rule" };
  }
  if (expense.counterparty_key) {
    const rule = counterpartyRules.get(expense.counterparty_key);
    if (rule?.chart_of_accounts_id) return { chart_of_accounts_id: rule.chart_of_accounts_id, mapping_source: "rule" };
  }
  return { chart_of_accounts_id: null, mapping_source: "unmapped" };
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npm run test -- lib/finance/expenses.test.ts`
Expected: PASS. (Type errors in `rampExpenses.ts` / expenses PATCH route are expected until Tasks 4 & 9.)

- [ ] **Step 5: Commit**

```bash
git add lib/finance/expenses.ts lib/finance/expenses.test.ts
git commit -m "feat(finance): counterparty rule resolution in resolveExpenseMapping"
```

---

### Task 4: `syncExpenseRecords` resolves + auto-creates counterparty rules; card/bill mappers set null counterparty

**Files:**
- Modify: `lib/finance/rampExpenses.ts` (`syncExpenseRecords`; `rampTxnToExpenseRecord`; `rampBillToExpenseRecords`)
- Test: `lib/finance/rampExpenses.test.ts`

**Interfaces:**
- Consumes: `CounterpartyRuleRef` (Task 3), extended `resolveExpenseMapping`.
- Produces: `syncExpenseRecords` loads `expense_counterparty_mappings`, ensures a rule row exists for every new `counterparty_key` in the batch (unmapped, `auto_matched=false`), and resolves each record via both GL + counterparty rules. Card/bill records set `counterparty_key: null, counterparty_label: null`.

- [ ] **Step 1: Set null counterparty on card + bill mappers**

In `rampTxnToExpenseRecord`, add to the returned object: `counterparty_key: null, counterparty_label: null,`.
In `rampBillToExpenseRecords`, add the same two nulls to the `base` object.

- [ ] **Step 2: Update the existing sync test's expectation (both-rule-maps)**

In `lib/finance/rampExpenses.test.ts`, the existing `syncRampExpenses` test's fake Supabase must also answer a select on `expense_counterparty_mappings` (return `{ data: [] }`). Locate the fake client's `.from(table)` switch and add a branch: for `"expense_counterparty_mappings"` return an object whose `.select().eq()` resolves to `{ data: [], error: null }` and whose `.upsert()` resolves `{ error: null }`. (Mirror the existing `expense_account_mappings` branch.)

- [ ] **Step 3: Run it and watch it fail**

Run: `npm run test -- lib/finance/rampExpenses.test.ts`
Expected: FAIL — sync reads/writes `expense_counterparty_mappings` which the fake doesn't handle yet, or resolver arity mismatch.

- [ ] **Step 4: Extend `syncExpenseRecords`**

In `lib/finance/rampExpenses.ts`, inside `syncExpenseRecords`, after loading GL rules (`ruleByAccountId`), add counterparty-rule loading + ensure:

```ts
  // Counterparty rules (for bank-sourced rows with no GL coding).
  const { data: cpRows, error: cpErr } = await supabase
    .from("expense_counterparty_mappings")
    .select("counterparty_key, chart_of_accounts_id")
    .eq("source", SOURCE);
  if (cpErr) throw new Error(`Load counterparty mappings failed: ${cpErr.message}`);

  const ruleByCounterparty = new Map<string, CounterpartyRuleRef>();
  for (const r of cpRows ?? []) {
    ruleByCounterparty.set(r.counterparty_key, { counterparty_key: r.counterparty_key, chart_of_accounts_id: r.chart_of_accounts_id });
  }

  // Ensure a rule row exists for every counterparty in this batch (unmapped —
  // counterparties don't name-match the CoA, so the user assigns in Settings).
  const newCpRules: { source: string; counterparty_key: string; counterparty_label: string; chart_of_accounts_id: null; auto_matched: boolean }[] = [];
  for (const rec of records) {
    if (rec.counterparty_key && !ruleByCounterparty.has(rec.counterparty_key)) {
      ruleByCounterparty.set(rec.counterparty_key, { counterparty_key: rec.counterparty_key, chart_of_accounts_id: null });
      newCpRules.push({ source: SOURCE, counterparty_key: rec.counterparty_key, counterparty_label: rec.counterparty_label ?? rec.counterparty_key, chart_of_accounts_id: null, auto_matched: false });
    }
  }
  if (newCpRules.length > 0) {
    const { error } = await supabase
      .from("expense_counterparty_mappings")
      .upsert(newCpRules, { onConflict: "source,counterparty_key" });
    if (error) throw new Error(`Insert counterparty mappings failed: ${error.message}`);
  }
```

Update the existing-override select to also fetch `counterparty_key`, and the `resolveExpenseMapping` call to pass both maps:

```ts
    const resolved = resolveExpenseMapping(
      {
        external_account_id:  rec.external_account_id,
        counterparty_key:     rec.counterparty_key,
        mapping_source:       prior?.mapping_source ?? "unmapped",
        chart_of_accounts_id: prior?.chart_of_accounts_id ?? null,
      },
      ruleByAccountId,
      ruleByCounterparty,
    );
```

Import `CounterpartyRuleRef` from `./expenses` at the top.

- [ ] **Step 5: Run it and watch it pass**

Run: `npm run test -- lib/finance/rampExpenses.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/finance/rampExpenses.ts lib/finance/rampExpenses.test.ts
git commit -m "feat(finance): syncExpenseRecords resolves + seeds counterparty rules"
```

---

### Task 5: `classifyBankLine` — the drift-critical classifier

**Files:**
- Create: `lib/finance/bankLedger.ts`
- Test: `lib/finance/bankLedger.test.ts`

**Interfaces:**
- Consumes: `RampBankLine`, `normalizeCounterparty` (Task 2).
- Produces:
  - `type FlowType = "operating_expense" | "interest_income" | "internal_transfer" | "bill_settlement" | "card_settlement" | "deposit" | "unclassified"`
  - `interface BankClassification { flow_type: FlowType; affects_pl: boolean; is_expense: boolean; direction: "inflow" | "outflow"; counterparty_name: string; counterparty_key: string }`
  - `classifyBankLine(line: RampBankLine, ownAccounts: Set<string>): BankClassification` — `ownAccounts` holds **normalized** own-account names.

- [ ] **Step 1: Write the failing tests (cover every branch — this is where drift hides)**

```ts
// lib/finance/bankLedger.test.ts
import { describe, it, expect } from "vitest";
import { classifyBankLine } from "./bankLedger";
import { normalizeCounterparty, type RampBankLine } from "@/lib/ramp";

const OWN = new Set(["operating account", "investment account"].map(normalizeCounterparty));

function line(over: Partial<RampBankLine> = {}): RampBankLine {
  return {
    id: "k1", amount: 150.39, currency_code: "USD", date: "2026-07-07T00:00:00Z",
    description: "Withdrawal", source_account_name: "Operating Account", destination_account_name: "GUSTO",
    ...over,
  };
}

describe("classifyBankLine", () => {
  it("Withdrawal to an external party is an operating expense (routes to expenses)", () => {
    const c = classifyBankLine(line(), OWN);
    expect(c).toMatchObject({ flow_type: "operating_expense", is_expense: true, affects_pl: true, direction: "outflow", counterparty_key: "gusto" });
  });

  it("Interest is income, not an expense", () => {
    const c = classifyBankLine(line({ description: "Interest", source_account_name: null, destination_account_name: "Operating Account" }), OWN);
    expect(c).toMatchObject({ flow_type: "interest_income", is_expense: false, affects_pl: true, direction: "inflow" });
  });

  it("Vendor Payment is a bill settlement, excluded from P&L (no double-count with bills)", () => {
    const c = classifyBankLine(line({ description: "Vendor Payment", destination_account_name: null }), OWN);
    expect(c).toMatchObject({ flow_type: "bill_settlement", is_expense: false, affects_pl: false });
  });

  it("Withdrawal between own accounts is an internal transfer", () => {
    const c = classifyBankLine(line({ destination_account_name: "Investment Account" }), OWN);
    expect(c).toMatchObject({ flow_type: "internal_transfer", is_expense: false, affects_pl: false });
  });

  it("a card-balance payment is a card settlement, excluded from P&L", () => {
    const c = classifyBankLine(line({ destination_account_name: "Ramp Card" }), OWN);
    expect(c).toMatchObject({ flow_type: "card_settlement", is_expense: false, affects_pl: false });
  });

  it("Deposit is non-P&L pending review", () => {
    const c = classifyBankLine(line({ description: "Deposit", source_account_name: "OUTSIDE BANK", destination_account_name: "Operating Account" }), OWN);
    expect(c).toMatchObject({ flow_type: "deposit", is_expense: false, affects_pl: false, direction: "inflow" });
  });

  it("a Withdrawal with no counterparty is unclassified (never silently an expense)", () => {
    const c = classifyBankLine(line({ destination_account_name: null }), OWN);
    expect(c).toMatchObject({ flow_type: "unclassified", is_expense: false });
  });

  it("an unknown description is unclassified", () => {
    const c = classifyBankLine(line({ description: "Adjustment" }), OWN);
    expect(c.flow_type).toBe("unclassified");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run test -- lib/finance/bankLedger.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `classifyBankLine`**

```ts
// lib/finance/bankLedger.ts
/**
 * Bank-account ledger: classify each Ramp bank line into a flow_type that decides
 * (a) which table it lands in and (b) how statements treat it. This is the anti-
 * drift core — settlements (Vendor Payment, card payment) are excluded so the
 * underlying bill/card records aren't double-counted, and only direct external
 * debits become expenses. Anything unrecognized is `unclassified` for review.
 */
import { normalizeCounterparty, type RampBankLine } from "@/lib/ramp";

export type FlowType =
  | "operating_expense"
  | "interest_income"
  | "internal_transfer"
  | "bill_settlement"
  | "card_settlement"
  | "deposit"
  | "unclassified";

export interface BankClassification {
  flow_type:         FlowType;
  affects_pl:        boolean;
  is_expense:        boolean;   // true ⇒ routes to `expenses`; else `ramp_bank_ledger`
  direction:         "inflow" | "outflow";
  counterparty_name: string;
  counterparty_key:  string;
}

/** True when a name looks like a Ramp card account (card-balance payment target). */
function isRampCard(name: string): boolean {
  return /ramp/i.test(name);
}

export function classifyBankLine(line: RampBankLine, ownAccounts: Set<string>): BankClassification {
  const desc    = line.description.trim();
  const destKey = normalizeCounterparty(line.destination_account_name);
  const srcKey  = normalizeCounterparty(line.source_account_name);
  const destOwn = destKey !== "" && ownAccounts.has(destKey);

  const make = (flow_type: FlowType, affects_pl: boolean, direction: "inflow" | "outflow", partyName: string): BankClassification => ({
    flow_type,
    affects_pl,
    is_expense: flow_type === "operating_expense",
    direction,
    counterparty_name: partyName,
    counterparty_key:  normalizeCounterparty(partyName),
  });

  if (desc === "Interest") return make("interest_income", true, "inflow", line.source_account_name ?? "Interest");
  if (desc === "Deposit")  return make("deposit", false, "inflow", line.source_account_name ?? "");
  if (desc === "Vendor Payment") return make("bill_settlement", false, "outflow", line.destination_account_name ?? "");

  if (desc === "Withdrawal") {
    const dest = line.destination_account_name ?? "";
    if (dest === "") return make("unclassified", false, "outflow", "");
    if (isRampCard(dest)) return make("card_settlement", false, "outflow", dest);
    if (destOwn) return make("internal_transfer", false, "outflow", dest);
    return make("operating_expense", true, "outflow", dest);
  }

  // Unknown description — surface for manual review, never auto-book.
  return make("unclassified", false, srcKey && !ownAccounts.has(srcKey) ? "inflow" : "outflow", line.destination_account_name ?? line.source_account_name ?? "");
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npm run test -- lib/finance/bankLedger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/finance/bankLedger.ts lib/finance/bankLedger.test.ts
git commit -m "feat(finance): classifyBankLine — anti-drift bank-line classifier"
```

> **Known follow-up (documented, not a blocker):** the card-balance-payment representation wasn't in the spike sample. `isRampCard` is a defensive heuristic; validate against a longer window (re-run `scripts/ramp-api-spike.mjs`) and tighten if a real card autopay reveals a different counterparty. Mis-classification here is caught by the `unclassified`/review UI (Task 11).

---

### Task 6: Bank line → record builders + `partitionBankLines`

**Files:**
- Modify: `lib/finance/bankLedger.ts`
- Test: `lib/finance/bankLedger.test.ts`

**Interfaces:**
- Consumes: `classifyBankLine`, `ExpenseRecord` (`@/lib/finance/expenses`), `dollarsToCents`.
- Produces:
  - `interface BankLedgerRecord { source: "ramp"; source_transaction_id: string; amount_cents: number; currency_code: string; description: string | null; counterparty_name: string | null; source_account_name: string | null; destination_account_name: string | null; flow_type: FlowType; affects_pl: boolean; transaction_date: string | null }`
  - `partitionBankLines(lines: RampBankLine[], ownAccounts: Set<string>): { expenseRecords: ExpenseRecord[]; ledgerRecords: BankLedgerRecord[] }`

- [ ] **Step 1: Write the failing tests**

Append to `lib/finance/bankLedger.test.ts`:

```ts
import { partitionBankLines } from "./bankLedger";

describe("partitionBankLines", () => {
  const lines = [
    line({ id: "exp", description: "Withdrawal", destination_account_name: "ERIE INSURANCE", amount: 271.05 }),
    line({ id: "int", description: "Interest", source_account_name: null, destination_account_name: "Operating Account", amount: 40.01 }),
    line({ id: "xfer", description: "Withdrawal", destination_account_name: "Investment Account", amount: 5000 }),
  ];
  const { expenseRecords, ledgerRecords } = partitionBankLines(lines, OWN);

  it("routes operating expenses to expense records (ramp_object=bank, outflow-negative)", () => {
    expect(expenseRecords).toHaveLength(1);
    expect(expenseRecords[0]).toMatchObject({
      source: "ramp", ramp_object: "bank", source_transaction_id: "exp",
      amount_cents: -27105, merchant_name: "ERIE INSURANCE", counterparty_key: "erie insurance",
      external_account_id: null,
    });
  });

  it("routes interest + transfer to ledger records with flow_type + affects_pl and correct sign", () => {
    expect(ledgerRecords.map((r) => r.flow_type).sort()).toEqual(["interest_income", "internal_transfer"]);
    const interest = ledgerRecords.find((r) => r.flow_type === "interest_income")!;
    expect(interest).toMatchObject({ amount_cents: 4001, affects_pl: true });   // inflow positive
    const xfer = ledgerRecords.find((r) => r.flow_type === "internal_transfer")!;
    expect(xfer.amount_cents).toBe(-500000);                                     // outflow negative
    expect(xfer.affects_pl).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run test -- lib/finance/bankLedger.test.ts`
Expected: FAIL — `partitionBankLines` not exported.

- [ ] **Step 3: Implement the builders + partition**

Append to `lib/finance/bankLedger.ts` (add imports for `ExpenseRecord`, `dollarsToCents` from `./expenses`):

```ts
import { dollarsToCents, type ExpenseRecord } from "./expenses";

export interface BankLedgerRecord {
  source:                   "ramp";
  source_transaction_id:    string;
  amount_cents:             number;
  currency_code:            string;
  description:              string | null;
  counterparty_name:        string | null;
  source_account_name:      string | null;
  destination_account_name: string | null;
  flow_type:                FlowType;
  affects_pl:               boolean;
  transaction_date:         string | null;
}

/** Signed cents from an unsigned magnitude + direction. */
function signedCents(amount: number, direction: "inflow" | "outflow"): number {
  const cents = dollarsToCents(amount);
  return direction === "outflow" ? -cents : cents;
}

function bankLineToExpenseRecord(line: RampBankLine, c: BankClassification): ExpenseRecord {
  return {
    source:                "ramp",
    ramp_object:           "bank",
    source_transaction_id: line.id,
    amount_cents:          signedCents(line.amount, c.direction),
    currency_code:         line.currency_code || "USD",
    memo:                  line.description || null,
    merchant_name:         c.counterparty_name || null,
    merchant_category:     null,
    sk_category_name:      null,
    state:                 null,
    card_holder_name:      null,
    department_name:       null,
    transaction_time:      line.date || null,
    accounting_date:       line.date ? line.date.slice(0, 10) : null,
    external_account_id:   null,
    external_account_name: null,
    external_account_code: null,
    counterparty_key:      c.counterparty_key || null,
    counterparty_label:    c.counterparty_name || null,
  };
}

function bankLineToLedgerRecord(line: RampBankLine, c: BankClassification): BankLedgerRecord {
  return {
    source:                   "ramp",
    source_transaction_id:    line.id,
    amount_cents:             signedCents(line.amount, c.direction),
    currency_code:            line.currency_code || "USD",
    description:              line.description || null,
    counterparty_name:        c.counterparty_name || null,
    source_account_name:      line.source_account_name,
    destination_account_name: line.destination_account_name,
    flow_type:                c.flow_type,
    affects_pl:               c.affects_pl,
    transaction_date:         line.date ? line.date.slice(0, 10) : null,
  };
}

/** Classify every bank line and split into expense-bound vs ledger-bound records. */
export function partitionBankLines(
  lines: RampBankLine[],
  ownAccounts: Set<string>,
): { expenseRecords: ExpenseRecord[]; ledgerRecords: BankLedgerRecord[] } {
  const expenseRecords: ExpenseRecord[] = [];
  const ledgerRecords:  BankLedgerRecord[] = [];
  for (const line of lines) {
    const c = classifyBankLine(line, ownAccounts);
    if (c.is_expense) expenseRecords.push(bankLineToExpenseRecord(line, c));
    else              ledgerRecords.push(bankLineToLedgerRecord(line, c));
  }
  return { expenseRecords, ledgerRecords };
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npm run test -- lib/finance/bankLedger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/finance/bankLedger.ts lib/finance/bankLedger.test.ts
git commit -m "feat(finance): partition bank lines into expense vs ledger records"
```

---

### Task 7: `syncBankLedger` — upsert ledger rows (idempotent)

**Files:**
- Modify: `lib/finance/bankLedger.ts`
- Test: `lib/finance/bankLedger.test.ts`

**Interfaces:**
- Consumes: `BankLedgerRecord`; a Supabase admin client.
- Produces: `syncBankLedger(supabase, records: BankLedgerRecord[]): Promise<{ imported: number; by_flow_type: Record<string, number> }>` — upserts on `(source, source_transaction_id)`, preserving a prior `manual` `mapping_source` + `chart_of_accounts_id` (interest coded by hand stays coded).

- [ ] **Step 1: Write the failing test with a minimal fake client**

Append to `lib/finance/bankLedger.test.ts`:

```ts
import { syncBankLedger, type BankLedgerRecord } from "./bankLedger";

function fakeSupabase(existing: Record<string, { mapping_source: string; chart_of_accounts_id: string | null }> = {}) {
  const upserts: BankLedgerRecord[] = [];
  return {
    upserts,
    from() {
      return {
        select() { return { eq() { return { in: async () => ({ data: Object.entries(existing).map(([source_transaction_id, v]) => ({ source_transaction_id, ...v })), error: null }) }; } }; },
        upsert: async (rows: BankLedgerRecord[]) => { upserts.push(...rows); return { error: null }; },
      };
    },
  };
}

describe("syncBankLedger", () => {
  const rec: BankLedgerRecord = {
    source: "ramp", source_transaction_id: "int", amount_cents: 4001, currency_code: "USD",
    description: "Interest", counterparty_name: "Interest", source_account_name: null,
    destination_account_name: "Operating Account", flow_type: "interest_income", affects_pl: true, transaction_date: "2026-07-01",
  };

  it("upserts ledger rows and reports counts by flow_type", async () => {
    const sb = fakeSupabase();
    const res = await syncBankLedger(sb as never, [rec]);
    expect(res.imported).toBe(1);
    expect(res.by_flow_type.interest_income).toBe(1);
    expect(sb.upserts[0].source_transaction_id).toBe("int");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -- lib/finance/bankLedger.test.ts`
Expected: FAIL — `syncBankLedger` not exported.

- [ ] **Step 3: Implement `syncBankLedger`**

Append to `lib/finance/bankLedger.ts` (add `import type { createSupabaseAdminClient } from "@/lib/supabase/admin"` and a local `AdminClient` type + `chunk` helper — mirror `rampExpenses.ts`):

```ts
type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function syncBankLedger(
  supabase: AdminClient,
  records: BankLedgerRecord[],
): Promise<{ imported: number; by_flow_type: Record<string, number> }> {
  // Preserve manual coding on interest/other income across re-syncs.
  const existing = new Map<string, { mapping_source: string; chart_of_accounts_id: string | null }>();
  for (const ids of chunk(records.map((r) => r.source_transaction_id), 500)) {
    const { data } = await supabase
      .from("ramp_bank_ledger")
      .select("source_transaction_id, mapping_source, chart_of_accounts_id")
      .eq("source", "ramp")
      .in("source_transaction_id", ids);
    for (const e of data ?? []) existing.set(e.source_transaction_id, { mapping_source: e.mapping_source, chart_of_accounts_id: e.chart_of_accounts_id });
  }

  const syncedAt = new Date().toISOString();
  const by_flow_type: Record<string, number> = {};
  const rows = records.map((rec) => {
    by_flow_type[rec.flow_type] = (by_flow_type[rec.flow_type] ?? 0) + 1;
    const prior = existing.get(rec.source_transaction_id);
    const manual = prior?.mapping_source === "manual";
    return {
      ...rec,
      chart_of_accounts_id: manual ? prior!.chart_of_accounts_id : null,
      mapping_source:       manual ? "manual" : "unmapped",
      synced_at:            syncedAt,
    };
  });

  for (const batch of chunk(rows, 500)) {
    const { error } = await supabase.from("ramp_bank_ledger").upsert(batch, { onConflict: "source,source_transaction_id" });
    if (error) throw new Error(`Upsert bank ledger failed: ${error.message}`);
  }
  return { imported: records.length, by_flow_type };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run test -- lib/finance/bankLedger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/finance/bankLedger.ts lib/finance/bankLedger.test.ts
git commit -m "feat(finance): syncBankLedger idempotent upsert with manual-code preservation"
```

---

### Task 8: Wire bank ingest into sync route, cron, and webhook

**Files:**
- Modify: `app/api/finance/expenses/sync/route.ts`
- Modify: `app/api/cron/ramp-expenses-sync/route.ts`
- Modify: `app/api/webhooks/ramp/route.ts`
- Modify: `lib/ramp/webhook.ts` + `lib/ramp/webhook.test.ts`

**Interfaces:**
- Consumes: `getRampBankTransactions`, `getRampBankAccounts`, `normalizeCounterparty`, `partitionBankLines`, `syncBankLedger`.

- [ ] **Step 1: Failing test — banking events reconcile**

In `lib/ramp/webhook.test.ts` add:

```ts
it("treats banking transaction events as reconcilable", () => {
  expect(isReconcilableRampEvent("banking.transaction.created")).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -- lib/ramp/webhook.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `isReconcilableRampEvent`**

```ts
export function isReconcilableRampEvent(type: unknown): boolean {
  return typeof type === "string" && (type.startsWith("transactions.") || type.startsWith("bill.") || type.startsWith("banking."));
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run test -- lib/ramp/webhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Add a shared ingest helper (avoid triplicating the fetch/partition/sync)**

Create `lib/finance/rampSync.ts`:

```ts
/**
 * One place that pulls every Ramp money-movement object for a window and lands it
 * in the ledger: card txns + bills + operating-expense bank debits → `expenses`
 * (one syncExpenseRecords call so GL + counterparty rules resolve together); all
 * other bank lines → `ramp_bank_ledger`. Reused by the on-demand route, the daily
 * cron, and the webhook re-sync.
 */
import { getRampTransactions, getRampBills, getRampBankTransactions, getRampBankAccounts, normalizeCounterparty } from "@/lib/ramp";
import { rampTxnToExpenseRecord, rampBillToExpenseRecords, syncExpenseRecords } from "./rampExpenses";
import { partitionBankLines, syncBankLedger } from "./bankLedger";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function syncAllRamp(supabase: ReturnType<typeof createSupabaseAdminClient>, from?: string, to?: string) {
  const [txns, bills, bankLines, bankAccounts] = await Promise.all([
    getRampTransactions(from, to), getRampBills(from, to), getRampBankTransactions(), getRampBankAccounts(),
  ]);
  const ownAccounts = new Set(bankAccounts.map((a) => normalizeCounterparty(a.name)));
  const { expenseRecords, ledgerRecords } = partitionBankLines(bankLines, ownAccounts);

  const records = [...txns.map(rampTxnToExpenseRecord), ...bills.flatMap(rampBillToExpenseRecords), ...expenseRecords];
  const expenses = await syncExpenseRecords(supabase, records);
  const bank = await syncBankLedger(supabase, ledgerRecords);
  return { ...expenses, bank };
}
```

- [ ] **Step 6: Point the route, cron, and webhook at `syncAllRamp`**

`app/api/finance/expenses/sync/route.ts` try-block:

```ts
import { syncAllRamp } from "@/lib/finance/rampSync";
// …
  try {
    const supabase = createSupabaseAdminClient();
    const result = await syncAllRamp(supabase, from, to);
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err);
  }
```

`app/api/cron/ramp-expenses-sync/route.ts` callback:

```ts
import { syncAllRamp } from "@/lib/finance/rampSync";
// …
  const outcome = await runCronJob("ramp-expenses-sync", async () => {
    const supabase = createSupabaseAdminClient();
    const result = await syncAllRamp(supabase, fromStr, toStr);
    return { ...result, window: { from: fromStr, to: toStr } };
  });
```

`app/api/webhooks/ramp/route.ts` `after(...)` block:

```ts
import { syncAllRamp } from "@/lib/finance/rampSync";
// …
      const supabase = createSupabaseAdminClient();
      const result = await syncAllRamp(supabase, fromStr, toStr);
      console.log("[ramp-webhook] reconcile", { type, eventId: event.id, imported: result.imported, bank: result.bank.imported, window: { from: fromStr, to: toStr } });
```

Remove now-unused direct imports (`getRampTransactions`, `rampTxnToExpenseRecord`, etc.) from the three route files.

- [ ] **Step 7: Typecheck + tests + build**

Run: `npm run test -- lib/ramp/webhook.test.ts && npx tsc --noEmit && npm run build`
Expected: PASS / no errors.

- [ ] **Step 8: Commit**

```bash
git add lib/finance/rampSync.ts lib/ramp/webhook.ts lib/ramp/webhook.test.ts app/api/finance/expenses/sync/route.ts app/api/cron/ramp-expenses-sync/route.ts app/api/webhooks/ramp/route.ts
git commit -m "feat(finance): unified syncAllRamp — bank ledger wired into route/cron/webhook"
```

---

### Task 9: Expenses PATCH-clear path resolves counterparty rules

**Files:**
- Modify: `app/api/finance/expenses/route.ts` (PATCH clear branch, lines ~89-116; GET select)

**Interfaces:**
- Consumes: extended `resolveExpenseMapping`.

- [ ] **Step 1: Add counterparty columns to the GET select**

In the `.select(...)`, add `counterparty_key,` and `counterparty_label,` after `external_account_code,`.

- [ ] **Step 2: Fix the PATCH clear branch to pass both rule maps**

Replace the clear-override block so it also loads a counterparty rule and calls the new resolver:

```ts
  if (!coaId) {
    const { data: expense } = await supabase
      .from("expenses")
      .select("source, external_account_id, counterparty_key")
      .eq("id", body.id)
      .single();

    const glRules = new Map<string, { external_account_id: string; chart_of_accounts_id: string | null }>();
    if (expense?.external_account_id) {
      const { data: rule } = await supabase
        .from("expense_account_mappings")
        .select("external_account_id, chart_of_accounts_id")
        .eq("source", expense.source).eq("external_account_id", expense.external_account_id).single();
      if (rule) glRules.set(rule.external_account_id, rule);
    }
    const cpRules = new Map<string, { counterparty_key: string; chart_of_accounts_id: string | null }>();
    if (expense?.counterparty_key) {
      const { data: rule } = await supabase
        .from("expense_counterparty_mappings")
        .select("counterparty_key, chart_of_accounts_id")
        .eq("source", expense.source).eq("counterparty_key", expense.counterparty_key).single();
      if (rule) cpRules.set(rule.counterparty_key, rule);
    }
    const resolved = resolveExpenseMapping(
      { external_account_id: expense?.external_account_id ?? null, counterparty_key: expense?.counterparty_key ?? null, mapping_source: "unmapped", chart_of_accounts_id: null },
      glRules, cpRules,
    );
    coaId  = resolved.chart_of_accounts_id;
    source = resolved.mapping_source;
  }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/finance/expenses/route.ts
git commit -m "feat(finance): expenses PATCH resolves counterparty rules on clear"
```

---

### Task 10: Bank-ledger + counterparty-mapping API routes

**Files:**
- Create: `app/api/finance/bank-ledger/route.ts`
- Create: `app/api/finance/expense-counterparty-mappings/route.ts`

**Interfaces:**
- Produces:
  - `GET /api/finance/bank-ledger?from&to` → rows joined to CoA; `PATCH` → set `flow_type`/`chart_of_accounts_id` (manual) by row id.
  - `GET /api/finance/expense-counterparty-mappings` → rows joined to CoA; `PATCH { id, chart_of_accounts_id }` → assign account, set `auto_matched=false`.

- [ ] **Step 1: Bank-ledger route**

```ts
// app/api/finance/bank-ledger/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requireRole(["viewer"]); } catch (res) { return res as Response; }
  const from = req.nextUrl.searchParams.get("from");
  const to   = req.nextUrl.searchParams.get("to");

  const supabase = createSupabaseAdminClient();
  let query = supabase
    .from("ramp_bank_ledger")
    .select(`id, source_transaction_id, amount_cents, currency_code, description, counterparty_name, source_account_name, destination_account_name, flow_type, affects_pl, transaction_date, chart_of_accounts_id, mapping_source, chart_of_accounts!ramp_bank_ledger_chart_of_accounts_id_fkey ( account_name, account_number, account_type )`)
    .order("transaction_date", { ascending: false, nullsFirst: false });
  if (from) query = query.gte("transaction_date", from);
  if (to)   query = query.lte("transaction_date", to);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }
  const body = await req.json() as { id: string; flow_type?: string; chart_of_accounts_id?: string | null };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if (body.flow_type) patch.flow_type = body.flow_type;
  if ("chart_of_accounts_id" in body) {
    patch.chart_of_accounts_id = body.chart_of_accounts_id ?? null;
    patch.mapping_source = body.chart_of_accounts_id ? "manual" : "unmapped";
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from("ramp_bank_ledger").update(patch).eq("id", body.id).select("id, flow_type, chart_of_accounts_id, mapping_source").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
```

- [ ] **Step 2: Counterparty-mappings route**

```ts
// app/api/finance/expense-counterparty-mappings/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["viewer"]); } catch (res) { return res as Response; }
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("expense_counterparty_mappings")
    .select(`id, counterparty_key, counterparty_label, chart_of_accounts_id, auto_matched, chart_of_accounts!expense_counterparty_mappings_chart_of_accounts_id_fkey ( account_name, account_number )`)
    .order("counterparty_label", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }
  const body = await req.json() as { id: string; chart_of_accounts_id: string | null };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("expense_counterparty_mappings")
    .update({ chart_of_accounts_id: body.chart_of_accounts_id ?? null, auto_matched: false })
    .eq("id", body.id).select("id, chart_of_accounts_id").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/finance/bank-ledger/route.ts app/api/finance/expense-counterparty-mappings/route.ts
git commit -m "feat(finance): bank-ledger + counterparty-mapping API routes"
```

---

### Task 11: Bank Ledger tab

**Files:**
- Create: `app/finance/transactions/bank-ledger/page.tsx`
- Modify: `app/finance/transactions/TransactionsNav.tsx`

**Interfaces:**
- Consumes: `GET /api/finance/bank-ledger`, `PATCH /api/finance/bank-ledger`, `formatCurrencyCents`, existing `YearSelect`, `LedgerTable`, `SummaryStatBar`, `Badge`.

- [ ] **Step 1: Add the nav entry**

In `TransactionsNav.tsx`, add to `TABS` after Expenses:

```ts
  { href: "/finance/transactions/bank-ledger", label: "Bank Ledger" },
```

- [ ] **Step 2: Build the page**

Create `app/finance/transactions/bank-ledger/page.tsx` — a client page mirroring the Expenses page structure: `YearSelect`, a `SummaryStatBar` (row count, count needing review = `flow_type==='unclassified'`, net P&L-affecting total = sum of `amount_cents` where `affects_pl`), and a `LedgerTable` with columns Date · Counterparty · Description · Flow type (`<Badge>` — `unclassified` uses `tone="warning"`, `interest_income` `tone="success"`, others neutral) · P&L? · Amount (`formatCurrencyCents`, already bracketed). Unclassified rows expand to a `flow_type` `<select>` (the FlowType options) + an `AccountSelect` that PATCHes `chart_of_accounts_id`. Reuse the data-load pattern from `app/finance/transactions/expenses/page.tsx` (fetch on year change; optimistic update on PATCH). Empty state: "No bank-account activity for {year}. Click Sync Ramp on the Expenses tab to import."

```tsx
"use client";
import { useState, useEffect, useCallback } from "react";
import { formatCurrencyCents } from "@/lib/format";
import YearSelect from "../components/YearSelect";
import SummaryStatBar from "../components/SummaryStatBar";
import { LedgerTable, SortableTh, Th, useTableSort } from "../components/LedgerTable";
import Badge from "@/app/components/ui/Badge";
import AccountSelect, { type CoARef } from "../../AccountSelect";
import Banner from "@/app/components/ui/Banner";

const FLOW_TYPES = ["interest_income","internal_transfer","bill_settlement","card_settlement","deposit","unclassified"] as const;
type FlowType = typeof FLOW_TYPES[number];

interface CoaJoin { account_name: string; account_number: string | null; account_type: string }
interface BankRow {
  id: string; amount_cents: number; description: string | null; counterparty_name: string | null;
  source_account_name: string | null; destination_account_name: string | null; flow_type: FlowType;
  affects_pl: boolean; transaction_date: string | null; chart_of_accounts_id: string | null;
  mapping_source: "unmapped"|"rule"|"manual"; chart_of_accounts: CoaJoin | null;
}

function flowTone(f: FlowType): "success" | "warning" | "neutral" {
  if (f === "unclassified") return "warning";
  if (f === "interest_income") return "success";
  return "neutral";
}
function fmtDate(s: string | null) {
  if (!s) return "—";
  const [y,m,d] = s.split("-");
  return new Date(Number(y), Number(m)-1, Number(d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

type SortKey = "date" | "amount";

export default function BankLedgerPage() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [accounts, setAccounts] = useState<CoARef[]>([]);
  const [rows, setRows] = useState<BankRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sort = useTableSort<SortKey>("date");

  const loadAll = useCallback(async (y: number) => {
    setLoading(true); setError(null);
    try {
      const [coaRes, res] = await Promise.all([
        fetch("/api/finance/chart-of-accounts"),
        fetch(`/api/finance/bank-ledger?from=${y}-01-01&to=${y}-12-31`),
      ]);
      const [coa, data] = await Promise.all([coaRes.json(), res.json()]);
      setAccounts(Array.isArray(coa) ? coa : []);
      setRows(Array.isArray(data) ? data : []);
    } catch { setError("Failed to load bank ledger."); }
    finally { setLoading(false); }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadAll(year); }, [loadAll, year]);

  async function patchRow(id: string, patch: { flow_type?: FlowType; chart_of_accounts_id?: string | null }) {
    const res = await fetch("/api/finance/bank-ledger", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...patch }) });
    if (!res.ok) return;
    const upd = await res.json();
    setRows((rs) => rs.map((r) => r.id === id ? { ...r, flow_type: upd.flow_type ?? r.flow_type, chart_of_accounts_id: upd.chart_of_accounts_id ?? null, mapping_source: upd.mapping_source ?? r.mapping_source } : r));
  }

  const needsReview = rows.filter((r) => r.flow_type === "unclassified").length;
  const plNet = rows.filter((r) => r.affects_pl).reduce((s, r) => s + r.amount_cents, 0);
  const visible = rows.slice().sort((a,b) => {
    const diff = sort.key === "amount" ? a.amount_cents - b.amount_cents : (a.transaction_date ?? "").localeCompare(b.transaction_date ?? "");
    return sort.asc ? diff : -diff;
  });

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 py-3 border-b border-line flex items-center gap-3 flex-wrap">
        <YearSelect year={year} onChange={setYear} />
      </div>
      {rows.length > 0 && (
        <SummaryStatBar stats={[
          { label: "Lines", value: rows.length },
          { label: "Needs review", value: needsReview, tone: needsReview > 0 ? "accent" : "secondary" },
          { label: "P&L impact", value: formatCurrencyCents(plNet) },
        ]} />
      )}
      {error && <Banner className="mx-4 sm:mx-6 my-2">{error}</Banner>}
      {loading ? (
        <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted">Loading…</p></div>
      ) : rows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <p className="text-sm text-secondary">No bank-account activity for {year}. Click &ldquo;Sync Ramp&rdquo; on the Expenses tab to import.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
          <LedgerTable head={<>
            <SortableTh label="Date" sortKey="date" sort={sort} />
            <Th label="Counterparty" /><Th label="Description" /><Th label="Flow" /><Th label="P&L" />
            <SortableTh label="Amount" sortKey="amount" sort={sort} align="right" />
          </>}>
            {visible.map((r) => (
              <tr key={r.id} className="border-t border-line/40">
                <td className="px-4 py-2 text-secondary whitespace-nowrap">{fmtDate(r.transaction_date)}</td>
                <td className="px-4 py-2 text-body">{r.counterparty_name ?? "—"}</td>
                <td className="px-4 py-2 text-secondary">{r.description ?? "—"}</td>
                <td className="px-4 py-2">
                  {r.flow_type === "unclassified" ? (
                    <select className="inp-sm" value={r.flow_type} onChange={(e) => patchRow(r.id, { flow_type: e.target.value as FlowType })}>
                      {FLOW_TYPES.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                  ) : <Badge tone={flowTone(r.flow_type)}>{r.flow_type.replace(/_/g, " ")}</Badge>}
                </td>
                <td className="px-4 py-2 text-[10px] text-faint">{r.affects_pl ? "yes" : "—"}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-strong">{formatCurrencyCents(r.amount_cents)}</td>
              </tr>
            ))}
          </LedgerTable>
          <p className="py-3 text-[10px] text-faint">Bank lines are classified on sync. Settlements and internal transfers are excluded from P&amp;L to avoid double-counting card and bill records. Recode an <span className="text-warning">unclassified</span> line above.</p>
        </div>
      )}
    </>
  );
}
```

> If `Badge` doesn't expose a `warning` tone, use the nearest existing tone from `app/components/ui/Badge.tsx` (check its `tone` union before coding) and adjust `flowTone`.

- [ ] **Step 3: Verify in the browser**

Start dev server, open `/finance/transactions/bank-ledger`, Sync Ramp on the Expenses tab, then confirm via `preview_snapshot`: interest shows as inflow (positive), Gusto/Erie appear on the **Expenses** tab (not here), transfers/settlements show here excluded from P&L, and unclassified rows expose the recode select. Check `preview_console_logs`.

- [ ] **Step 4: Lint + build**

Run: `npm run lint && npm run build`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/finance/transactions/bank-ledger/page.tsx app/finance/transactions/TransactionsNav.tsx
git commit -m "feat(finance): Bank Ledger tab with flow-type review"
```

---

### Task 12: Counterparty-mapping settings + bank badge on Expenses

**Files:**
- Create: `app/finance/settings/counterparty-accounts/page.tsx`
- Modify: `app/finance/settings/nav-config` (add the entry — inspect the existing settings nav file first for its exact shape)
- Modify: `app/finance/transactions/expenses/page.tsx` (extend the Task-A type badge to label `bank` rows)

**Interfaces:**
- Consumes: `GET/PATCH /api/finance/expense-counterparty-mappings`, `AccountSelect`.

- [ ] **Step 1: Extend the Expenses type badge for bank rows**

In `app/finance/transactions/expenses/page.tsx`, replace the bill-only badge with a small map so `bill` and `bank` both label:

```tsx
            {e.ramp_object !== "card" && (
              <span className="shrink-0 px-1 py-0.5 rounded text-[9px] font-medium bg-surface-mid text-muted uppercase tracking-wide">
                {e.ramp_object === "bill" ? "Bill" : "Bank"}
              </span>
            )}
```

- [ ] **Step 2: Build the counterparty settings page**

Create `app/finance/settings/counterparty-accounts/page.tsx` — a client page listing counterparty rules (label + an `AccountSelect` bound to `chart_of_accounts_id`, PATCHing on change), mirroring `app/finance/settings/expense-accounts/page.tsx`. Read that file first and follow its structure/primitives exactly (same `PageHeader`, table, `AccountSelect`, load/patch pattern) so the two settings pages are consistent.

- [ ] **Step 3: Add the settings nav entry**

Inspect the finance settings nav file (the one `app/finance/settings/expense-accounts/page.tsx` renders under) and add a `Counterparty Accounts` entry pointing to `/finance/settings/counterparty-accounts`, matching the existing entry shape.

- [ ] **Step 4: Verify in the browser**

Open `/finance/settings/counterparty-accounts`; confirm Gusto/Erie appear (seeded by the first sync) with account selectors. Assign Gusto→Payroll, re-sync, and confirm the Gusto expense on the Expenses tab now shows that account. `preview_snapshot` + `preview_console_logs`.

- [ ] **Step 5: Lint + build + full test**

Run: `npm run lint && npm run build && npm run test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/finance/settings/counterparty-accounts/page.tsx app/finance/transactions/expenses/page.tsx
git commit -m "feat(finance): counterparty→account settings + bank badge on Expenses"
```

---

## Self-Review

**Spec coverage:**
- Operating bank lines ingested → Tasks 2, 6, 8. ✅
- Gusto/Erie direct debits → `expenses` → Task 5 (`operating_expense`) + Task 6 (`bankLineToExpenseRecord`). ✅
- Interest as income → Task 5 (`interest_income`, `affects_pl=true`) → `ramp_bank_ledger`. ✅
- Transfers / card payments excluded from P&L (no double-count) → Task 5 (`internal_transfer`, `bill_settlement`, `card_settlement`, all `affects_pl=false`). ✅
- No silent drops → `unclassified` always lands in `ramp_bank_ledger` with a review UI (Tasks 5, 11). ✅
- Counterparty→CoA mapping for uncoded bank expenses → Tasks 1, 3, 4, 10, 12. ✅
- Accounting sign (inflow +, outflow −, brackets) → Task 6 `signedCents` + `formatCurrencyCents`. ✅
- Second table for non-expenses → Task 1 `ramp_bank_ledger`. ✅
- Bank Ledger tab + review → Task 11. ✅

**Placeholder scan:** Tasks 11 & 12 reference "mirror the existing X page" for two UI pages — each names the exact file to follow and the primitives to reuse, with the non-trivial page (Task 11) written out in full. Task 12's settings page intentionally defers to the existing `expense-accounts` page structure rather than duplicating ~150 lines; this is a deliberate "follow the established pattern" instruction, not a missing spec. No TBD/TODO elsewhere. ✅

**Type consistency:** `FlowType` identical across `bankLedger.ts`, the migration CHECK, the API route, and the page. `BankLedgerRecord` fields match the `ramp_bank_ledger` columns (Task 1) and the `syncBankLedger` upsert. `resolveExpenseMapping(expense, glRules, counterpartyRules)` arity matches both callers (Task 4 sync, Task 9 route). `ExpenseRecord.counterparty_key/label` set by all mappers (card/bill null in Task 4; bank populated in Task 6). `partitionBankLines` return shape consumed by `syncAllRamp` (Task 8). ✅
```
