# Transaction Manual Guards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exclude-as-duplicate and manual GL-split guards to the Finance > Transactions expenses ledger, and fix the `buildBillTotals` double-count that strands duplicate bank expenses.

**Execution Budget:** Mode = subagent-driven-development (9 tasks, 4 locality groups, ~14 files — above the 6-file inline tier in CLAUDE.md). **Spawn cap = 9**, raised from the formula's 6 by explicit operator decision on 2026-07-24: one implementer per locality group (4) + one review per group (4) + one final Opus whole-branch review (1). Tasks are dispatched per locality group, not per task, per CLAUDE.md. Token target ≈ 350k.

**Architecture:** Exclusion is three sync-safe columns on `expenses` filtered out at a single fetch point. Splitting reuses the existing `expense_gl_splits` table, whose `split_source='manual'` value and P&L aggregation path already exist and are already correct — so no aggregation code changes. Two sync fixes (per-line dedup in `buildBillTotals`, and a guarded prune of reclassified bank expenses) remove the defect class that motivated the feature.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, Supabase Postgres (PostgREST), Vitest.

## Global Constraints

- **NEVER add `excluded_at` / `excluded_reason` / `excluded_by` to the `ExpenseRecord` interface in `lib/finance/expenses.ts:21-50`.** `syncExpenseRecords` upserts exactly that interface's keys; PostgREST emits `ON CONFLICT DO UPDATE SET <supplied columns only>`, so columns absent from the payload survive re-sync. Adding them there silently breaks exclusion on every sync.
- Migration file is `supabase/migrations/20260816_expense_manual_guards.sql`. Do NOT hand-edit existing migrations. Do NOT apply to prod — human-gated.
- All mutation routes gate `requireRole(["manager"])` and use `createSupabaseAdminClient()`.
- Dynamic route handlers take `{ params }: { params: Promise<{ id: string }> }` and must `await params` (Next.js 16 convention — see `app/api/finance/expenses/[id]/payroll-match/route.ts:31-33`).
- No raw color utilities (`zinc-*`/`amber-*`/`red-*`/`green-*`/`blue-*`/`gray-*`) or hex literals in UI. Use token utilities and existing primitives (`Badge`, `ConfirmDialog`, `SaveHint`, `btn-*`, `inp-sm`). No new UI primitive.
- Split amounts are signed to match the parent expense's cash direction (outflow negative), per `lib/finance/payrollMatching.ts:213-231`.
- Manual split writes only ever touch `split_source='manual'` rows. Never delete or rewrite `payroll_auto` rows.
- `npm run verify` (lint + typecheck + tests) must pass before each commit.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lib/finance/bankLedger.ts` | Modify: per-line dedup in `buildBillTotals`; add pure `selectPrunableExpenseIds` | 1, 5 |
| `lib/finance/bankLedger.test.ts` | Modify: Duke Energy regression + prune-selection tests | 1, 5 |
| `supabase/migrations/20260816_expense_manual_guards.sql` | Create: exclusion columns, partial index, split memo | 2 |
| `lib/finance/expenseSplits.ts` | Create: pure manual-split validation + remainder helper | 3 |
| `lib/finance/expenseSplits.test.ts` | Create: validator tests | 3 |
| `lib/finance/financials/expenseFilters.ts` | Create: shared statement-filter helper (single source of truth) | 4 |
| `lib/finance/financials/expenseFilters.test.ts` | Create: filter-application tests | 4 |
| `lib/finance/financials/fetchSources.ts` | Modify: use the shared filter helper | 4 |
| `scripts/financials-parity.ts` | Modify: use the same helper so parity can't drift | 4 |
| `lib/finance/rampSync.ts` | Modify: call the guarded prune after sync | 5 |
| `app/api/finance/expenses/[id]/exclude/route.ts` | Create: POST exclude / DELETE restore | 6 |
| `app/api/finance/expenses/[id]/splits/route.ts` | Create: PUT replace / DELETE clear manual splits | 7 |
| `app/api/finance/expenses/route.ts` | Modify: return exclusion fields + split memo/source | 8 |
| `app/finance/transactions/expenses/ManualSplitPanel.tsx` | Create: split editor | 9 |
| `app/finance/transactions/expenses/page.tsx` | Modify: three-way drawer branch, exclude action, badge, filter | 9 |

**Locality groups (for spawn budgeting):** A = sync/lib (Tasks 1, 5) · B = schema + read path + validator (Tasks 2, 3, 4) · C = API routes (Tasks 6, 7, 8) · D = UI (Task 9).

## Task / Model Table

| Task | Title | Group | Model | Depends on |
|---|---|---|---|---|
| 1 | Fix `buildBillTotals` per-line dedup | A | Sonnet | — |
| 2 | Migration: exclusion columns + split memo | B | Haiku | — |
| 3 | Manual split validator | B | Sonnet | — |
| 4 | Exclusion read-path filter | B | Sonnet | 2 |
| 5 | Guarded prune of reclassified bank expenses | A | Sonnet | 2 |
| 6 | Exclude / restore API route | C | Sonnet | 2 |
| 7 | Manual splits API route | C | Sonnet | 2, 3 |
| 8 | Expenses list route enrichment | C | Sonnet | 2 |
| 9 | Transactions UI | D | Sonnet | 6, 7, 8 |

Final whole-branch review: **Opus**, once, after Task 9.

---

### Task 1: Fix `buildBillTotals` per-line dedup

**Files:**
- Modify: `lib/finance/bankLedger.ts:55-71`
- Test: `lib/finance/bankLedger.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `buildBillTotals(billLineItems: { source_transaction_id: string; amount_cents: number; merchant_name: string | null }[]): BillTotals` — signature unchanged. `BillTotals = Map<string, Set<number>>`.

**Context.** `rampSync.ts:37` calls `buildBillTotals([...histBillRows, ...bills.flatMap(rampBillToExpenseRecords)])`. `histBillRows` is bill lines already persisted in `expenses` (120-day lookback); `bills` is freshly fetched from the Ramp API over the caller's window. A bill present in both is currently summed twice, producing a 2× total that matches no real bank debit — so the settlement regresses into a second, double-counted expense.

- [ ] **Step 1: Write the failing test**

Append to `lib/finance/bankLedger.test.ts`. Check the file's existing imports first and extend them rather than adding a duplicate import line — `buildBillTotals` and `classifyBankLine` both come from `./bankLedger`.

```ts
describe("buildBillTotals — duplicate line suppression", () => {
  // The real Duke Energy bill (7e05e00b…): 12 line items summing to 483355 cents.
  const DUKE_CENTS = [2200, 9891, 10412, 324205, 13958, 105540, 112, 900, 4167, 5010, 5952, 1008];
  const dukeLines = DUKE_CENTS.map((c, i) => ({
    source_transaction_id: `7e05e00b-f3c1-4e65-a5bf-ec8d3b47ac6e:${i}`,
    amount_cents: -c,
    merchant_name: "Duke Energy",
  }));

  it("totals a bill supplied once", () => {
    expect(buildBillTotals(dukeLines).get("dukeenergy")).toEqual(new Set([483355]));
  });

  it("does not double-count a bill supplied by both DB history and API batch", () => {
    expect(buildBillTotals([...dukeLines, ...dukeLines]).get("dukeenergy")).toEqual(new Set([483355]));
  });

  it("still classifies the bank debit as a settlement when the bill arrives twice", () => {
    const totals = buildBillTotals([...dukeLines, ...dukeLines]);
    const line = {
      id: "38ba080d-012d-43dc-bb34-d7942a6b6d90",
      amount: 4833.55,
      currency_code: "USD",
      date: "2026-07-16",
      description: "Withdrawal",
      source_account_name: "Checking",
      destination_account_name: "DUKEENERGY",
      sync_status: null,
    };
    expect(classifyBankLine(line, new Set(["checking"]), totals).flow_type).toBe("bill_settlement");
  });

  it("keeps distinct bills from the same vendor as separate totals", () => {
    const second = [
      { source_transaction_id: "other-bill:0", amount_cents: -1000, merchant_name: "Duke Energy" },
      { source_transaction_id: "other-bill:1", amount_cents: -500, merchant_name: "Duke Energy" },
    ];
    expect(buildBillTotals([...dukeLines, ...second]).get("dukeenergy")).toEqual(new Set([483355, 1500]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/finance/bankLedger.test.ts -t "duplicate line suppression"`
Expected: FAIL — "does not double-count" and "still classifies" fail, showing `Set([966710])` instead of `Set([483355])`.

- [ ] **Step 3: Write the implementation**

Replace `buildBillTotals` in `lib/finance/bankLedger.ts:55-71` with:

```ts
/**
 * Group bill line-item expense rows by their bill id (the part before the ":N"
 * suffix) and sum, keyed by fuzzy vendor.
 *
 * Each line is summed ONCE, keyed by its own source_transaction_id, because a
 * bill routinely arrives twice in a single sync: rampSync feeds this both the
 * bill lines already persisted in `expenses` (120-day lookback) and the bills
 * freshly fetched from the Ramp API. Adding a line twice yields a 2x bill total
 * that matches no real bank debit, silently regressing an already-excluded
 * settlement back into a live, double-counted expense.
 */
export function buildBillTotals(billLineItems: { source_transaction_id: string; amount_cents: number; merchant_name: string | null }[]): BillTotals {
  const linesByBillId = new Map<string, { centsByLineId: Map<string, number>; vendorKey: string }>();
  for (const row of billLineItems) {
    const billId = row.source_transaction_id.split(":")[0];
    const vendorKey = billMatchKey(row.merchant_name);
    const entry = linesByBillId.get(billId) ?? { centsByLineId: new Map<string, number>(), vendorKey };
    entry.centsByLineId.set(row.source_transaction_id, Math.abs(row.amount_cents));
    entry.vendorKey = vendorKey;
    linesByBillId.set(billId, entry);
  }

  const result: BillTotals = new Map();
  for (const { centsByLineId, vendorKey } of linesByBillId.values()) {
    if (!vendorKey) continue;
    let total = 0;
    for (const cents of centsByLineId.values()) total += cents;
    if (!result.has(vendorKey)) result.set(vendorKey, new Set());
    result.get(vendorKey)!.add(total);
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/finance/bankLedger.test.ts`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add lib/finance/bankLedger.ts lib/finance/bankLedger.test.ts
git commit -m "fix(finance): dedup bill lines in buildBillTotals so settlements still match"
```

---

### Task 2: Migration — exclusion columns + split memo

**Files:**
- Create: `supabase/migrations/20260816_expense_manual_guards.sql`

**Interfaces:**
- Produces: `expenses.excluded_at timestamptz`, `expenses.excluded_reason text`, `expenses.excluded_by uuid`, `expense_gl_splits.memo text`. Tasks 4-9 depend on these column names exactly.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260816_expense_manual_guards.sql`:

```sql
-- Manual guards on the Expenses ledger: exclude-as-duplicate + labelled manual
-- GL splits.
--
-- excluded_* marks a row as a data artifact that must not reach ANY financial
-- statement (P&L, cash flow, balance sheet). This is deliberately stricter than
-- ramp_bank_ledger.affects_pl, which is skipped for the balance sheet so
-- cumulative cash stays correct: an excluded expense is a duplicate whose real
-- cash movement is already carried by another row.
--
-- These columns are NEVER written by the Ramp sync upsert -- they are absent
-- from ExpenseRecord in lib/finance/expenses.ts, and PostgREST's
-- merge-duplicates only SETs supplied columns -- so re-syncs leave them
-- untouched. Same guarantee as inventory_alert_dismissed / unmapped_accepted.
--
-- Human-gated (do NOT auto-apply).
alter table public.expenses
  add column if not exists excluded_at     timestamptz,
  add column if not exists excluded_reason text,
  add column if not exists excluded_by     uuid;

-- Excluded rows are a small minority, so a partial index keeps the
-- "show me what's excluded" filter cheap without bloating the common path.
create index if not exists expenses_excluded_at_idx
  on public.expenses (excluded_at)
  where excluded_at is not null;

-- Labels one component of a manual split, e.g. 'Sales Tax For Utility'.
-- Null for payroll_auto rows, which take their meaning from the pay period.
alter table public.expense_gl_splits
  add column if not exists memo text;
```

- [ ] **Step 2: Verify the SQL parses and the numbering is free**

Run: `ls supabase/migrations/ | tail -3`
Expected: `20260816_expense_manual_guards.sql` is the newest, and no other file starts with `20260816`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260816_expense_manual_guards.sql
git commit -m "feat(finance): migration for expense exclusion columns + split memo"
```

---

### Task 3: Manual split validator

**Files:**
- Create: `lib/finance/expenseSplits.ts`
- Test: `lib/finance/expenseSplits.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ManualSplitLine { chartOfAccountsId: string; amountCents: number; memo?: string | null }`
  - `type SplitValidation = { ok: true } | { ok: false; error: string }`
  - `validateManualSplit(lines: ManualSplitLine[], parentAmountCents: number): SplitValidation`
  - `splitRemainderCents(lines: { amountCents: number }[], parentAmountCents: number): number`

  Task 7 calls `validateManualSplit` server-side; Task 9 calls both in the editor.

- [ ] **Step 1: Write the failing test**

Create `lib/finance/expenseSplits.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateManualSplit, splitRemainderCents } from "./expenseSplits";

const line = (chartOfAccountsId: string, amountCents: number) => ({ chartOfAccountsId, amountCents });

describe("validateManualSplit", () => {
  it("accepts lines that sum exactly to the parent", () => {
    expect(validateManualSplit([line("a", -300000), line("b", -183355)], -483355)).toEqual({ ok: true });
  });

  it("rejects an off-by-one-cent total", () => {
    const result = validateManualSplit([line("a", -300000), line("b", -183354)], -483355);
    expect(result.ok).toBe(false);
  });

  it("rejects a single-line split", () => {
    expect(validateManualSplit([line("a", -483355)], -483355).ok).toBe(false);
  });

  it("rejects an empty split", () => {
    expect(validateManualSplit([], -483355).ok).toBe(false);
  });

  it("rejects a line whose sign opposes the parent", () => {
    expect(validateManualSplit([line("a", -600000), line("b", 116645)], -483355).ok).toBe(false);
  });

  it("rejects a zero-amount line", () => {
    expect(validateManualSplit([line("a", -483355), line("b", 0)], -483355).ok).toBe(false);
  });

  it("rejects a line with no GL account", () => {
    expect(validateManualSplit([line("", -300000), line("b", -183355)], -483355).ok).toBe(false);
  });

  it("rejects non-integer cents", () => {
    expect(validateManualSplit([line("a", -300000.5), line("b", -183354.5)], -483355).ok).toBe(false);
  });

  it("rejects splitting a zero-amount expense", () => {
    expect(validateManualSplit([line("a", 0), line("b", 0)], 0).ok).toBe(false);
  });

  it("accepts an inflow split (positive parent)", () => {
    expect(validateManualSplit([line("a", 1000), line("b", 500)], 1500)).toEqual({ ok: true });
  });
});

describe("splitRemainderCents", () => {
  it("reports what is left to allocate", () => {
    expect(splitRemainderCents([{ amountCents: -300000 }], -483355)).toBe(-183355);
  });

  it("reports zero when balanced", () => {
    expect(splitRemainderCents([{ amountCents: -300000 }, { amountCents: -183355 }], -483355)).toBe(0);
  });

  it("treats an empty set as fully unallocated", () => {
    expect(splitRemainderCents([], -483355)).toBe(-483355);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/finance/expenseSplits.test.ts`
Expected: FAIL — "Failed to resolve import ./expenseSplits".

- [ ] **Step 3: Write the implementation**

Create `lib/finance/expenseSplits.ts`:

```ts
/**
 * Pure validation for manual GL splits on an expense.
 *
 * The P&L aggregation REPLACES a split expense's own account/amount with its
 * split lines (aggregateRows.ts:305-312) rather than merging them, so an
 * unbalanced split silently changes the reported expense total. Exact-cents
 * balance is therefore a hard invariant, enforced here and re-checked
 * server-side before any write.
 *
 * Amounts are signed to match the parent's cash direction (outflow negative),
 * matching how payroll splits are stored (payrollMatching.ts:213-231).
 */

export interface ManualSplitLine {
  chartOfAccountsId: string;
  amountCents: number;
  memo?: string | null;
}

export type SplitValidation = { ok: true } | { ok: false; error: string };

/** Cents still unallocated: parent minus the sum of the supplied lines. Zero means balanced. */
export function splitRemainderCents(lines: { amountCents: number }[], parentAmountCents: number): number {
  return parentAmountCents - lines.reduce((total, l) => total + l.amountCents, 0);
}

export function validateManualSplit(lines: ManualSplitLine[], parentAmountCents: number): SplitValidation {
  if (parentAmountCents === 0) return { ok: false, error: "Cannot split a zero-amount expense" };
  if (lines.length < 2) return { ok: false, error: "A split needs at least 2 lines" };

  const parentSign = Math.sign(parentAmountCents);
  for (const l of lines) {
    if (!l.chartOfAccountsId) return { ok: false, error: "Every split line needs a GL account" };
    if (!Number.isInteger(l.amountCents)) return { ok: false, error: "Split amounts must be whole cents" };
    if (l.amountCents === 0) return { ok: false, error: "Split lines cannot be zero" };
    if (Math.sign(l.amountCents) !== parentSign) {
      return { ok: false, error: "Split lines must run the same direction as the expense" };
    }
  }

  const remainder = splitRemainderCents(lines, parentAmountCents);
  if (remainder !== 0) {
    return { ok: false, error: `Split lines are off by ${remainder} cents` };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/finance/expenseSplits.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/finance/expenseSplits.ts lib/finance/expenseSplits.test.ts
git commit -m "feat(finance): pure validator for manual GL splits"
```

---

### Task 4: Exclusion read-path filter

**Files:**
- Create: `lib/finance/financials/expenseFilters.ts`
- Test: `lib/finance/financials/expenseFilters.test.ts`
- Modify: `lib/finance/financials/fetchSources.ts:427-441`
- Modify: `scripts/financials-parity.ts:204-214`

**Interfaces:**
- Consumes: `expenses.excluded_at` (Task 2).
- Produces: `applyExpenseStatementFilters<T extends ExpenseFilterable>(q: T, cashOnly: boolean): T`

**Context.** `fetchSources.fetchExpenses` and `scripts/financials-parity.ts` independently rebuild the same expense filter chain. They have already drifted once (the parity script mirrors `.or("state.is.null,state.neq.DECLINED")` by hand). Extracting one helper both call means the exclusion filter cannot be added to one and forgotten in the other.

- [ ] **Step 1: Write the failing test**

Create `lib/finance/financials/expenseFilters.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyExpenseStatementFilters } from "./expenseFilters";

/** Records every filter call and returns itself, mimicking a PostgREST builder. */
function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const q = {
    calls,
    ilike(...args: unknown[]) { calls.push(["ilike", ...args]); return q; },
    or(...args: unknown[]) { calls.push(["or", ...args]); return q; },
    is(...args: unknown[]) { calls.push(["is", ...args]); return q; },
  };
  return q;
}

describe("applyExpenseStatementFilters", () => {
  it("excludes manually-excluded rows on the accrual path", () => {
    const q = recorder();
    applyExpenseStatementFilters(q, false);
    expect(q.calls).toContainEqual(["is", "excluded_at", null]);
  });

  it("excludes manually-excluded rows on the cash path too", () => {
    const q = recorder();
    applyExpenseStatementFilters(q, true);
    expect(q.calls).toContainEqual(["is", "excluded_at", null]);
  });

  it("keeps the accrual state filter when cashOnly is false", () => {
    const q = recorder();
    applyExpenseStatementFilters(q, false);
    expect(q.calls).toContainEqual(["or", "state.is.null,state.neq.DECLINED"]);
    expect(q.calls.some(([fn]) => fn === "ilike")).toBe(false);
  });

  it("uses the case-insensitive cleared filter when cashOnly is true", () => {
    const q = recorder();
    applyExpenseStatementFilters(q, true);
    expect(q.calls).toContainEqual(["ilike", "state", "cleared"]);
    expect(q.calls.some(([fn]) => fn === "or")).toBe(false);
  });

  it("returns the builder so it stays chainable", () => {
    const q = recorder();
    expect(applyExpenseStatementFilters(q, false)).toBe(q);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/finance/financials/expenseFilters.test.ts`
Expected: FAIL — "Failed to resolve import ./expenseFilters".

- [ ] **Step 3: Write the implementation**

Create `lib/finance/financials/expenseFilters.ts`:

```ts
/**
 * The one place that decides which `expenses` rows are eligible for a financial
 * statement. Both the app's aggregation (fetchSources.fetchExpenses) and the
 * standalone parity script build their own query against `expenses`; when they
 * disagree the parity script reports a false discrepancy, so the filter chain
 * lives here and both call it.
 */

/** The subset of a PostgREST builder these filters need. Structural so both the real client and tests satisfy it. */
export interface ExpenseFilterable {
  ilike(column: string, pattern: string): unknown;
  or(filters: string): unknown;
  is(column: string, value: null): unknown;
}

/**
 * Applies statement eligibility to an `expenses` query:
 *
 * - Cash basis = settled rows only. Card rows settle as "CLEARED" (Square,
 *   uppercase); bank rows -- every Gusto payroll withdrawal among them -- settle
 *   as "cleared" (bankLedger.ts, lowercase). A case-sensitive .eq("CLEARED")
 *   silently dropped every bank/payroll expense (and its GL splits) from the
 *   cash-flow statement, so match case-insensitively via ilike.
 * - Manually excluded rows are duplicates/data artifacts and never belong on ANY
 *   statement -- P&L, cash flow, or balance sheet. This is stricter than
 *   ramp_bank_ledger.affects_pl (which the balance sheet deliberately ignores)
 *   because an excluded expense's real cash movement is carried by another row.
 */
export function applyExpenseStatementFilters<T extends ExpenseFilterable>(q: T, cashOnly: boolean): T {
  const stated = (cashOnly ? q.ilike("state", "cleared") : q.or("state.is.null,state.neq.DECLINED")) as T;
  return stated.is("excluded_at", null) as T;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/finance/financials/expenseFilters.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire it into `fetchSources.ts`**

In `lib/finance/financials/fetchSources.ts`, add to the imports:

```ts
import { applyExpenseStatementFilters } from "./expenseFilters";
```

Then replace lines 427-441 (the `fetchAllRows` callback body inside `fetchExpenses`) so the inline comment and ternary become the helper call:

```ts
  }>(() => {
    let q = supabase
      .from("expenses")
      .select("id, chart_of_accounts_id, amount_cents, accounting_date, mapping_source, state")
      .lte("accounting_date", range.endDateStr)
      .order("id", { ascending: true });
    if (range.startDateStr) q = q.gte("accounting_date", range.startDateStr);
    return applyExpenseStatementFilters(q, cashOnly);
  });
```

- [ ] **Step 6: Wire it into the parity script**

In `scripts/financials-parity.ts`, add the import:

```ts
import { applyExpenseStatementFilters } from "../lib/finance/financials/expenseFilters";
```

Then in the expenses query (~lines 205-214), replace the hand-written `.or("state.is.null,state.neq.DECLINED")` with the helper. The parity script always reports on the accrual basis, so pass `false`:

```ts
  const expenseRows = await fetchAllRows<{ id: string; amount_cents: number | null; chart_of_accounts_id: string | null; accounting_date: string | null }>(
    supabase,
    (from, to) =>
      applyExpenseStatementFilters(
        supabase
          .from("expenses")
          .select("id, amount_cents, chart_of_accounts_id, accounting_date")
          .gte("accounting_date", startDate)
          .lte("accounting_date", endDateInclusive),
        false,
      ).range(from, to) as unknown as Promise<{ data: never[] | null; error: { message: string } | null }>,
  );
```

If TypeScript complains that the helper's return type lacks `.range`, widen the generic call site with `as unknown as { range: (from: number, to: number) => unknown }` rather than loosening `ExpenseFilterable` — the helper must not grow methods it does not use.

- [ ] **Step 7: Verify**

Run: `npm run verify`
Expected: PASS — lint, typecheck, and all tests.

- [ ] **Step 8: Commit**

```bash
git add lib/finance/financials/expenseFilters.ts lib/finance/financials/expenseFilters.test.ts lib/finance/financials/fetchSources.ts scripts/financials-parity.ts
git commit -m "feat(finance): exclude manually-excluded expenses from every statement"
```

---

### Task 5: Guarded prune of reclassified bank expenses

**Files:**
- Modify: `lib/finance/bankLedger.ts` (append `selectPrunableExpenseIds`)
- Test: `lib/finance/bankLedger.test.ts` (append)
- Modify: `lib/finance/rampSync.ts:22-50`

**Interfaces:**
- Consumes: `expenses.excluded_at` (Task 2); `chunk` from `@/lib/utils/chunk`.
- Produces:
  - `selectPrunableExpenseIds(candidates: PruneCandidate[], expenseIdsWithSplits: Set<string>): { deletable: string[]; skipped: string[] }` where `interface PruneCandidate { id: string; source_transaction_id: string; excluded_at: string | null }`
  - `pruneReclassifiedBankExpenses(supabase, ledgerSourceIds: string[]): Promise<{ deleted: number; skipped: string[] }>` in `rampSync.ts`
  - `syncAllRamp` return value gains `pruned: { deleted: number; skipped: string[] }`

**Context.** `syncExpenseRecords` only upserts the records it is handed and never prunes. A bank line that once classified as `operating_expense` and now classifies as `bill_settlement` therefore keeps its stale `expenses` row forever — the exact Duke Energy phantom. `expense_gl_splits` cascades on `expense_id` delete, so an unguarded delete would also destroy an operator's manual split.

- [ ] **Step 1: Write the failing test**

Append to `lib/finance/bankLedger.test.ts`:

```ts
describe("selectPrunableExpenseIds", () => {
  const plain = { id: "e1", source_transaction_id: "s1", excluded_at: null };
  const withSplit = { id: "e2", source_transaction_id: "s2", excluded_at: null };
  const excluded = { id: "e3", source_transaction_id: "s3", excluded_at: "2026-07-20T00:00:00Z" };

  it("deletes a reclassified row carrying no manual work", () => {
    const r = selectPrunableExpenseIds([plain], new Set());
    expect(r.deletable).toEqual(["e1"]);
    expect(r.skipped).toEqual([]);
  });

  it("keeps a row that has GL splits, so the cascade cannot destroy them", () => {
    const r = selectPrunableExpenseIds([withSplit], new Set(["e2"]));
    expect(r.deletable).toEqual([]);
    expect(r.skipped).toEqual(["s2"]);
  });

  it("keeps a manually excluded row", () => {
    const r = selectPrunableExpenseIds([excluded], new Set());
    expect(r.deletable).toEqual([]);
    expect(r.skipped).toEqual(["s3"]);
  });

  it("partitions a mixed batch", () => {
    const r = selectPrunableExpenseIds([plain, withSplit, excluded], new Set(["e2"]));
    expect(r.deletable).toEqual(["e1"]);
    expect(r.skipped).toEqual(["s2", "s3"]);
  });

  it("handles an empty batch", () => {
    expect(selectPrunableExpenseIds([], new Set())).toEqual({ deletable: [], skipped: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/finance/bankLedger.test.ts -t "selectPrunableExpenseIds"`
Expected: FAIL — `selectPrunableExpenseIds is not defined`.

- [ ] **Step 3: Write the pure selector**

Append to `lib/finance/bankLedger.ts`:

```ts
export interface PruneCandidate {
  id:                    string;
  source_transaction_id: string;
  excluded_at:           string | null;
}

/**
 * Partition reclassified bank expenses into those safe to delete and those to
 * leave alone. A row carrying manual work -- a GL split, or a manual exclusion
 * -- is never deleted: expense_gl_splits cascades on expense delete, so pruning
 * such a row would silently destroy the operator's split.
 */
export function selectPrunableExpenseIds(
  candidates: PruneCandidate[],
  expenseIdsWithSplits: Set<string>,
): { deletable: string[]; skipped: string[] } {
  const deletable: string[] = [];
  const skipped:   string[] = [];
  for (const c of candidates) {
    if (expenseIdsWithSplits.has(c.id) || c.excluded_at !== null) skipped.push(c.source_transaction_id);
    else deletable.push(c.id);
  }
  return { deletable, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/finance/bankLedger.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Add the IO wrapper and wire it into the sync**

In `lib/finance/rampSync.ts`, extend the existing `./bankLedger` import to include `selectPrunableExpenseIds`, and add `import { chunk } from "@/lib/utils/chunk";`. Then append this function to the file:

```ts
/**
 * Delete `expenses` rows for bank lines that now classify as non-expense ledger
 * flows. syncExpenseRecords only upserts what it is handed and never prunes, so
 * a line that used to be an operating_expense and is now (say) a bill_settlement
 * would otherwise persist forever as a phantom second expense -- the Duke Energy
 * double-count. Rows carrying manual work are skipped, not deleted.
 */
export async function pruneReclassifiedBankExpenses(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  ledgerSourceIds: string[],
): Promise<{ deleted: number; skipped: string[] }> {
  let deleted = 0;
  const skipped: string[] = [];

  for (const ids of chunk(ledgerSourceIds, 500)) {
    const { data: candidates, error: candErr } = await supabase
      .from("expenses")
      .select("id, source_transaction_id, excluded_at")
      .eq("source", "ramp").eq("ramp_object", "bank")
      .in("source_transaction_id", ids);
    if (candErr) throw new Error(`Load reclassified bank expenses failed: ${candErr.message}`);
    if (!candidates || candidates.length === 0) continue;

    const { data: splitRows, error: splitErr } = await supabase
      .from("expense_gl_splits")
      .select("expense_id")
      .in("expense_id", candidates.map((c) => c.id as string));
    if (splitErr) throw new Error(`Load splits for reclassified bank expenses failed: ${splitErr.message}`);

    const withSplits = new Set((splitRows ?? []).map((r) => r.expense_id as string));
    const picked = selectPrunableExpenseIds(candidates as PruneCandidate[], withSplits);
    skipped.push(...picked.skipped);
    if (picked.deletable.length === 0) continue;

    const { error: delErr } = await supabase.from("expenses").delete().in("id", picked.deletable);
    if (delErr) throw new Error(`Prune reclassified bank expenses failed: ${delErr.message}`);
    deleted += picked.deletable.length;
  }

  return { deleted, skipped };
}
```

Import the `PruneCandidate` type alongside `selectPrunableExpenseIds`.

Then in `syncAllRamp`, replace the final two lines (`rampSync.ts:47-49`):

```ts
  const expenses = await syncExpenseRecords(supabase, records);
  const bank = await syncBankLedger(supabase, [...ledgerRecords, ...transferRecords]);
  // After the upsert, not before: a line that moved from expenses to the ledger
  // is absent from `records`, so its stale expenses row can only go away here.
  const pruned = await pruneReclassifiedBankExpenses(supabase, ledgerRecords.map((r) => r.source_transaction_id));
  return { ...expenses, bank, pruned };
```

- [ ] **Step 6: Verify**

Run: `npm run verify`
Expected: PASS. If any caller destructures `syncAllRamp`'s return type, confirm the added `pruned` key does not break it — it is additive, so it should not.

- [ ] **Step 7: Commit**

```bash
git add lib/finance/bankLedger.ts lib/finance/bankLedger.test.ts lib/finance/rampSync.ts
git commit -m "fix(finance): prune stale expenses rows for reclassified bank lines"
```

---

### Task 6: Exclude / restore API route

**Files:**
- Create: `app/api/finance/expenses/[id]/exclude/route.ts`

**Interfaces:**
- Consumes: `expenses.excluded_*` (Task 2); `requireRole`, `getSessionUser` from `@/lib/auth`; `createSupabaseAdminClient` from `@/lib/supabase/admin`.
- Produces: `POST /api/finance/expenses/[id]/exclude` body `{ reason: string }` → `200 { excluded_at, excluded_reason }`. `DELETE` same path → `200 { excluded_at: null, excluded_reason: null }`. Task 9 calls both.

- [ ] **Step 1: Write the route**

Create `app/api/finance/expenses/[id]/exclude/route.ts`:

```ts
/**
 * Manual duplicate exclusion for one expense. An excluded row is dropped from
 * every financial statement (see financials/expenseFilters.ts) but stays visible
 * and reversible in the Transactions ledger. Reason is required: exclusion
 * silently removes money from reports, so the audit trail is not optional.
 *
 * Manager+ only, service-role client. The excluded_* columns are absent from
 * ExpenseRecord, so the Ramp sync upsert never clobbers them.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser, requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const { id } = await params;
  const body = (await req.json()) as { reason?: string };
  const reason = (body.reason ?? "").trim();
  if (!reason) return NextResponse.json({ error: "A reason is required to exclude a transaction" }, { status: 400 });

  const sb = createSupabaseAdminClient();

  // A split expense codes through its split lines; excluding it would strand
  // them. Make the operator clear the split first rather than silently winning.
  const { data: splits, error: splitErr } = await sb
    .from("expense_gl_splits").select("id").eq("expense_id", id).limit(1);
  if (splitErr) return NextResponse.json({ error: splitErr.message }, { status: 500 });
  if (splits && splits.length > 0) {
    return NextResponse.json({ error: "Clear this transaction's GL split before excluding it" }, { status: 409 });
  }

  // getSessionUser returns { user, role } — the id is on .user, not the root.
  const session = await getSessionUser();
  const { data, error } = await sb
    .from("expenses")
    .update({ excluded_at: new Date().toISOString(), excluded_reason: reason, excluded_by: session?.user.id ?? null })
    .eq("id", id)
    .select("id, excluded_at, excluded_reason")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const { id } = await params;
  const sb = createSupabaseAdminClient();
  const { data, error } = await sb
    .from("expenses")
    .update({ excluded_at: null, excluded_reason: null, excluded_by: null })
    .eq("id", id)
    .select("id, excluded_at, excluded_reason")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data);
}
```

- [ ] **Step 2: Verify**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "app/api/finance/expenses/[id]/exclude/route.ts"
git commit -m "feat(finance): exclude/restore API for duplicate expenses"
```

---

### Task 7: Manual splits API route

**Files:**
- Create: `app/api/finance/expenses/[id]/splits/route.ts`

**Interfaces:**
- Consumes: `validateManualSplit`, `ManualSplitLine` from `@/lib/finance/expenseSplits` (Task 3); `expense_gl_splits.memo` (Task 2); `resolveExpenseGlLines` from `@/lib/finance/expenseGlLines`.
- Produces: `PUT /api/finance/expenses/[id]/splits` body `{ lines: { chart_of_accounts_id: string; amount_cents: number; memo?: string | null }[] }` → `200 { glLines, mapping_source }`. `DELETE` same path → `200 { glLines, mapping_source }`. Task 9 calls both.

- [ ] **Step 1: Write the route**

Create `app/api/finance/expenses/[id]/splits/route.ts`:

```ts
/**
 * Manual GL splits for one expense: replace the whole manual set, or clear it.
 *
 * Only ever touches split_source='manual' rows -- payroll_auto rows belong to
 * the pay-period recompute and are never written here. Writing a manual split
 * also pins the parent's mapping_source to 'manual', which is what stops both
 * resolveExpenseMapping (rampExpenses.ts) and autoMap's bulk update from
 * re-coding a parent whose real coding now lives in its split lines.
 *
 * Manager+ only, service-role client.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { validateManualSplit } from "@/lib/finance/expenseSplits";
import { resolveExpenseGlLines } from "@/lib/finance/expenseGlLines";

export const dynamic = "force-dynamic";

interface SplitLineBody {
  chart_of_accounts_id: string;
  amount_cents:         number;
  memo?:                string | null;
}

type SbClient = ReturnType<typeof createSupabaseAdminClient>;

/** Re-read the expense's effective GL lines so the client can update the row without a reload. */
async function currentState(sb: SbClient, id: string) {
  const { data: splitRows, error: splitErr } = await sb
    .from("expense_gl_splits")
    .select("chart_of_accounts_id, amount_cents, split_source, memo")
    .eq("expense_id", id)
    .order("created_at", { ascending: true });
  if (splitErr) throw new Error(splitErr.message);

  const { data: expense, error: expErr } = await sb
    .from("expenses").select("chart_of_accounts_id, amount_cents, mapping_source").eq("id", id).single();
  if (expErr) throw new Error(expErr.message);

  const splits = (splitRows ?? []).map((r) => ({
    chartOfAccountsId: r.chart_of_accounts_id as string,
    amountCents:       r.amount_cents as number,
    splitSource:       r.split_source as "payroll_auto" | "manual",
    memo:              (r.memo as string | null) ?? null,
  }));

  return {
    glLines: resolveExpenseGlLines(splits, {
      chartOfAccountsId: (expense?.chart_of_accounts_id as string | null) ?? null,
      amountCents:       (expense?.amount_cents as number) ?? 0,
    }),
    mapping_source: expense?.mapping_source as string,
  };
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const { id } = await params;
  const body = (await req.json()) as { lines?: SplitLineBody[] };
  const lines = body.lines ?? [];

  const sb = createSupabaseAdminClient();

  const { data: expense, error: expErr } = await sb
    .from("expenses").select("id, amount_cents, excluded_at").eq("id", id).single();
  if (expErr) return NextResponse.json({ error: expErr.message }, { status: 500 });
  if (expense?.excluded_at) {
    return NextResponse.json({ error: "Restore this transaction before splitting it" }, { status: 409 });
  }

  const validation = validateManualSplit(
    lines.map((l) => ({ chartOfAccountsId: l.chart_of_accounts_id, amountCents: l.amount_cents, memo: l.memo ?? null })),
    expense?.amount_cents as number,
  );
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });

  const coaIds = Array.from(new Set(lines.map((l) => l.chart_of_accounts_id)));
  const { data: coaRows, error: coaErr } = await sb.from("chart_of_accounts").select("id").in("id", coaIds);
  if (coaErr) return NextResponse.json({ error: coaErr.message }, { status: 500 });
  if ((coaRows ?? []).length !== coaIds.length) {
    return NextResponse.json({ error: "One or more GL accounts do not exist" }, { status: 400 });
  }

  const { error: delErr } = await sb
    .from("expense_gl_splits").delete().eq("expense_id", id).eq("split_source", "manual");
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  const { error: insErr } = await sb.from("expense_gl_splits").insert(
    lines.map((l) => ({
      expense_id:           id,
      chart_of_accounts_id: l.chart_of_accounts_id,
      amount_cents:         l.amount_cents,
      split_source:         "manual" as const,
      memo:                 l.memo ?? null,
    })),
  );
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  const { error: pinErr } = await sb.from("expenses").update({ mapping_source: "manual" }).eq("id", id);
  if (pinErr) return NextResponse.json({ error: pinErr.message }, { status: 500 });

  try {
    return NextResponse.json(await currentState(sb, id));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const { id } = await params;
  const sb = createSupabaseAdminClient();

  const { error: delErr } = await sb
    .from("expense_gl_splits").delete().eq("expense_id", id).eq("split_source", "manual");
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  // Unpin so the next sync / auto-map re-resolves this expense by rule.
  // chart_of_accounts_id is left as-is; resolveExpenseMapping re-derives it.
  const { error: unpinErr } = await sb.from("expenses").update({ mapping_source: "unmapped" }).eq("id", id);
  if (unpinErr) return NextResponse.json({ error: unpinErr.message }, { status: 500 });

  try {
    return NextResponse.json(await currentState(sb, id));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Extend `resolveExpenseGlLines` to carry memo**

`ExpenseGlLine` in `lib/finance/expenseGlLines.ts:11-15` has no `memo`. Add it as optional so the split editor can round-trip labels, and widen the `splitRows` parameter to match:

```ts
export interface ExpenseGlLine {
  chartOfAccountsId: string;
  amountCents: number;
  splitSource: "payroll_auto" | "manual" | null; // null when synthesized (no split rows exist)
  memo?: string | null;
}
```

and in the `resolveExpenseGlLines` signature change the `splitRows` element type to:

```ts
  splitRows: { chartOfAccountsId: string; amountCents: number; splitSource: "payroll_auto" | "manual"; memo?: string | null }[],
```

The body needs no change — it already returns `splitRows` as-is.

- [ ] **Step 3: Verify**

Run: `npm run verify`
Expected: PASS. If `getExpenseGlLines` (same file) fails to typecheck because its `.select()` omits `memo`, add `memo` to that select list and map it through as `memo: (r.memo as string | null) ?? null`.

- [ ] **Step 4: Commit**

```bash
git add "app/api/finance/expenses/[id]/splits/route.ts" lib/finance/expenseGlLines.ts
git commit -m "feat(finance): manual GL split API for expenses"
```

---

### Task 8: Expenses list route enrichment

**Files:**
- Modify: `app/api/finance/expenses/route.ts:25-56` (select list), `:76-80` (splits select), `:108-121` (splits map)

**Interfaces:**
- Consumes: `expenses.excluded_*` and `expense_gl_splits.memo` (Task 2).
- Produces: each row in the `GET /api/finance/expenses` array gains `excluded_at: string | null` and `excluded_reason: string | null`; each `glLines[]` entry gains `memo: string | null`. Task 9 consumes both.

**Context.** Excluded rows must remain in this list — they are only filtered out of the *statement* path (`expenseFilters.ts`). The UI needs the fields to badge them and offer Restore.

- [ ] **Step 1: Add the exclusion columns to the select**

In `app/api/finance/expenses/route.ts`, inside the `.select(\`...\`)` template literal, add two lines after `unmapped_accepted,`:

```
      excluded_at,
      excluded_reason,
```

Do NOT add a filter — excluded rows stay in this list.

- [ ] **Step 2: Add memo to the splits fetch**

Change the splits query (`:76-79`) to select memo as well:

```ts
    supabase
      .from("expense_gl_splits")
      .select("expense_id, chart_of_accounts_id, amount_cents, split_source, memo")
      .in("expense_id", ids),
```

- [ ] **Step 3: Carry memo through the splits map**

Replace the `splitsByExpense` block (`:108-121`) with:

```ts
  const splitsByExpense = new Map<
    string,
    { chartOfAccountsId: string; amountCents: number; splitSource: "payroll_auto" | "manual"; memo: string | null }[]
  >();
  for (const r of splitsResult.data as {
    expense_id: string;
    chart_of_accounts_id: string;
    amount_cents: number;
    split_source: "payroll_auto" | "manual";
    memo: string | null;
  }[]) {
    const list = splitsByExpense.get(r.expense_id) ?? [];
    list.push({
      chartOfAccountsId: r.chart_of_accounts_id,
      amountCents: r.amount_cents,
      splitSource: r.split_source,
      memo: r.memo ?? null,
    });
    splitsByExpense.set(r.expense_id, list);
  }
```

- [ ] **Step 4: Widen the row cast**

The cast at `:67` narrows rows to three fields. Extend it so the new columns survive typechecking:

```ts
  const rows = (data ?? []) as {
    id: string;
    chart_of_accounts_id: string | null;
    amount_cents: number;
    excluded_at: string | null;
    excluded_reason: string | null;
  }[];
```

- [ ] **Step 5: Verify**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/api/finance/expenses/route.ts
git commit -m "feat(finance): expose exclusion state and split memos on the expenses list"
```

---

### Task 9: Transactions UI

**Files:**
- Create: `app/finance/transactions/expenses/ManualSplitPanel.tsx`
- Modify: `app/finance/transactions/expenses/page.tsx` (type at `:38-69`, controls at `:90-105`, row at `:123-263`, handlers near `:313-358`)

**Interfaces:**
- Consumes: `POST`/`DELETE /api/finance/expenses/[id]/exclude` (Task 6); `PUT`/`DELETE /api/finance/expenses/[id]/splits` (Task 7); `excluded_at`, `excluded_reason`, `glLines[].memo` (Task 8); `validateManualSplit`, `splitRemainderCents` from `@/lib/finance/expenseSplits` (Task 3).
- Produces: no downstream consumers — this is the last task.

**Context.** The drawer currently branches two ways (`page.tsx:229-256`): `PayrollSplitPanel` when `isPayrollSplit`, else the single `AccountSelect`. It becomes three-way. Row clicks toggle expansion, so any control rendered in the collapsed row must call `e.stopPropagation()` — see `AcceptUnmappedButton.tsx:22`.

- [ ] **Step 1: Build the split editor**

Create `app/finance/transactions/expenses/ManualSplitPanel.tsx`:

```tsx
"use client";

import { useState } from "react";
import AccountSelect, { type CoARef } from "../../AccountSelect";
import SaveHint from "@/app/components/ui/SaveHint";
import { formatCurrencyCents } from "@/lib/format";
import { validateManualSplit, splitRemainderCents } from "@/lib/finance/expenseSplits";
import type { GlLine } from "./PayrollSplitCell";

interface DraftLine {
  chartOfAccountsId: string;
  amountCents: number;
  memo: string;
}

/**
 * Editor for manual GL splits. The P&L replaces a split expense's own coding
 * with these lines, so Save stays disabled until they balance to the cent.
 */
export function ManualSplitPanel({
  expenseId,
  parentAmountCents,
  glLines,
  accounts,
  onUpdated,
  onCancel,
}: {
  expenseId: string;
  parentAmountCents: number;
  glLines: GlLine[];
  accounts: CoARef[];
  onUpdated: (next: { glLines: GlLine[]; mapping_source: string }) => void;
  onCancel: () => void;
}) {
  const existing = glLines.filter((l) => l.splitSource === "manual");
  const [lines, setLines] = useState<DraftLine[]>(
    existing.length > 0
      ? existing.map((l) => ({ chartOfAccountsId: l.chartOfAccountsId, amountCents: l.amountCents, memo: l.memo ?? "" }))
      : [
          { chartOfAccountsId: "", amountCents: parentAmountCents, memo: "" },
          { chartOfAccountsId: "", amountCents: 0, memo: "" },
        ],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remainder = splitRemainderCents(lines, parentAmountCents);
  const validation = validateManualSplit(lines, parentAmountCents);

  function patch(i: number, next: Partial<DraftLine>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...next } : l)));
  }

  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/finance/expenses/${expenseId}/splits`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lines: lines.map((l) => ({
          chart_of_accounts_id: l.chartOfAccountsId,
          amount_cents: l.amountCents,
          memo: l.memo.trim() || null,
        })),
      }),
    });
    setSaving(false);
    if (!res.ok) {
      setError(((await res.json()) as { error?: string }).error ?? "Could not save the split");
      return;
    }
    onUpdated((await res.json()) as { glLines: GlLine[]; mapping_source: string });
  }

  async function clear() {
    setSaving(true);
    const res = await fetch(`/api/finance/expenses/${expenseId}/splits`, { method: "DELETE" });
    setSaving(false);
    if (!res.ok) return;
    onUpdated((await res.json()) as { glLines: GlLine[]; mapping_source: string });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-2xs text-faint uppercase tracking-wider">Split across GL accounts</div>

      {lines.map((l, i) => (
        <div key={i} className="flex items-center gap-2">
          <AccountSelect
            value={l.chartOfAccountsId || null}
            onChange={(id) => patch(i, { chartOfAccountsId: id ?? "" })}
            accounts={accounts}
            placeholder="— pick an account —"
            shortLabel
            className="w-full max-w-[320px]"
          />
          <input
            className="inp-sm w-28 text-right font-mono tabular-nums"
            value={(l.amountCents / 100).toFixed(2)}
            onChange={(ev) => patch(i, { amountCents: Math.round(Number(ev.target.value || 0) * 100) })}
            inputMode="decimal"
            aria-label={`Split line ${i + 1} amount`}
          />
          <input
            className="inp-sm flex-1"
            value={l.memo}
            onChange={(ev) => patch(i, { memo: ev.target.value })}
            placeholder="Memo (optional)"
            aria-label={`Split line ${i + 1} memo`}
          />
          <button
            type="button"
            className="btn-secondary btn-xxs"
            onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}
            disabled={lines.length <= 2}
          >
            Remove
          </button>
        </div>
      ))}

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="btn-secondary btn-xxs"
          onClick={() => setLines((ls) => [...ls, { chartOfAccountsId: "", amountCents: remainder, memo: "" }])}
        >
          Add line
        </button>
        <span className={remainder === 0 ? "text-2xs text-success" : "text-2xs text-danger"}>
          {remainder === 0 ? "Balanced" : `${formatCurrencyCents(remainder)} unallocated`}
        </span>
        <div className="flex-1" />
        {existing.length > 0 && (
          <button type="button" className="btn-danger btn-xxs" onClick={clear} disabled={saving}>
            Clear split
          </button>
        )}
        <button type="button" className="btn-secondary btn-xxs" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn-primary btn-xxs" onClick={save} disabled={!validation.ok || saving}>
          Save split
        </button>
        <SaveHint saving={saving} />
      </div>

      {!validation.ok && <div className="text-2xs text-danger">{validation.error}</div>}
      {error && <div className="text-2xs text-danger">{error}</div>}
    </div>
  );
}
```

The import paths and default-vs-named forms above are verified against `page.tsx:3-8` — `AccountSelect` and `SaveHint` are **default** exports, `formatCurrencyCents` lives in `@/lib/format` (not `@/lib/utils/format`). Do not "correct" them.

- [ ] **Step 2: Extend the row type and controls in `page.tsx`**

In the `ExpenseRow` interface (`:38-69`), add after `unmapped_accepted: boolean;`:

```ts
  excluded_at: string | null;
  excluded_reason: string | null;
```

In `EXPENSE_CONTROLS.filters` (`:92-95`), add a third filter so excluded rows are findable:

```ts
    { param: "excluded", accessor: (e) => (e.excluded_at ? "excluded" : "active") },
```

In `GlLine` (`PayrollSplitCell.tsx:8`), add `memo?: string | null;` so the editor can round-trip labels.

- [ ] **Step 3: Add the handlers**

In the page component, next to `handleToggleAccept` (`:350-358`), add:

```tsx
  // Exclude / restore a duplicate. Reason is required by the API; the dialog collects it.
  async function handleExclude(id: string, reason: string) {
    const res = await fetch(`/api/finance/expenses/${id}/exclude`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) return;
    const updated = (await res.json()) as { excluded_at: string | null; excluded_reason: string | null };
    setExpenses((es) => es.map((e) => (e.id === id ? { ...e, ...updated } : e)));
  }

  async function handleRestore(id: string) {
    const res = await fetch(`/api/finance/expenses/${id}/exclude`, { method: "DELETE" });
    if (!res.ok) return;
    setExpenses((es) => es.map((e) => (e.id === id ? { ...e, excluded_at: null, excluded_reason: null } : e)));
  }

  // Patch one expense's split state in place after a manual-split mutation.
  function handleSplitUpdated(id: string, next: { glLines: GlLine[]; mapping_source: string }) {
    setExpenses((es) => es.map((e) => (e.id === id
      ? { ...e, glLines: next.glLines, mapping_source: next.mapping_source as ExpenseRow["mapping_source"] }
      : e)));
  }
```

Thread `onExclude`, `onRestore`, and `onSplitUpdated` down to `ExpenseRowView` alongside the existing `onSetExpense` / `onToggleAccept` / `onPayrollUpdated` props, following the same prop-drilling pattern already in the file.

- [ ] **Step 4: Render the excluded badge and the three-way drawer**

In `ExpenseRowView`, add local state for the editor:

```tsx
  const [editingSplit, setEditingSplit] = useState(false);
  const hasManualSplit = e.glLines.some((l) => l.splitSource === "manual");
```

In the GL Account cell of the collapsed row, show the excluded state (place it alongside the existing GL name rendering). `Badge` is a **default** export and accepts only `children`/`tone`/`className` — it has no `title` prop, so the tooltip goes on a wrapping `<span>`:

```tsx
  {e.excluded_at && (
    <span title={e.excluded_reason ?? undefined}>
      <Badge tone="danger">Excluded</Badge>
    </span>
  )}
```

Add `import Badge from "@/app/components/ui/Badge";` to `page.tsx`.

Replace the drawer's two-way branch (`:229-256`) with a three-way one. Keep the existing `PayrollSplitPanel` and `AccountSelect` blocks byte-for-byte; only the surrounding conditional changes:

```tsx
              {isPayrollSplit ? (
                <PayrollSplitPanel /* …unchanged props… */ />
              ) : editingSplit || hasManualSplit ? (
                <ManualSplitPanel
                  expenseId={e.id}
                  parentAmountCents={e.amount_cents}
                  glLines={e.glLines}
                  accounts={accounts}
                  onUpdated={(next) => { onSplitUpdated(e.id, next); setEditingSplit(false); }}
                  onCancel={() => setEditingSplit(false)}
                />
              ) : (
                <div className="flex items-center gap-2">
                  {/* …unchanged AccountSelect block… */}
                </div>
              )}
```

Then add the row-level actions at the bottom of the drawer, after that conditional:

```tsx
              <div className="flex items-center gap-2">
                {!isPayrollSplit && !hasManualSplit && !e.excluded_at && (
                  <button type="button" className="btn-secondary btn-xxs" onClick={() => setEditingSplit(true)}>
                    Split across accounts
                  </button>
                )}
                {e.excluded_at ? (
                  <button type="button" className="btn-secondary btn-xxs" onClick={() => onRestore(e.id)}>
                    Restore
                  </button>
                ) : (
                  <button type="button" className="btn-danger btn-xxs" onClick={() => setConfirmExclude(true)}>
                    Exclude as duplicate
                  </button>
                )}
              </div>
```

Finally, add the reason dialog. `ConfirmDialog` is a **default** export whose `message` prop is a `ReactNode`, so the reason input goes there — no `Modal` needed. Add `import ConfirmDialog from "@/app/components/ui/ConfirmDialog";` and this state:

```tsx
  const [confirmExclude, setConfirmExclude] = useState(false);
  const [excludeReason, setExcludeReason] = useState("");
```

then render it at the end of the drawer `<div>`:

```tsx
              {confirmExclude && (
                <ConfirmDialog
                  title="Exclude as duplicate"
                  confirmLabel="Exclude"
                  tone="danger"
                  message={
                    <div className="flex flex-col gap-2">
                      <p>This removes the transaction from the P&amp;L, cash flow, and balance sheet. It stays visible here and can be restored.</p>
                      <input
                        className="inp-sm w-full"
                        value={excludeReason}
                        onChange={(ev) => setExcludeReason(ev.target.value)}
                        placeholder="Reason (required)"
                        aria-label="Exclusion reason"
                      />
                    </div>
                  }
                  onConfirm={() => {
                    if (!excludeReason.trim()) return;
                    void onExclude(e.id, excludeReason.trim());
                    setConfirmExclude(false);
                    setExcludeReason("");
                  }}
                  onCancel={() => { setConfirmExclude(false); setExcludeReason(""); }}
                />
              )}
```

`ConfirmDialog` has no way to disable its confirm button from a blank field, so the `onConfirm` guard above is what enforces the required reason on the client; the API enforces it again server-side.

- [ ] **Step 5: Verify**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 6: Browser-verify the flow**

Start the dev server via the preview tooling (never `npm run dev` in a shell), open Finance > Transactions > Expenses, and confirm:
1. Expanding a normal expense shows "Split across accounts" and "Exclude as duplicate".
2. Splitting shows the unallocated remainder in `text-danger`, flips to "Balanced" in `text-success`, and only then enables Save.
3. After saving, the row's Mapping pill still reads mapped and the drawer shows the split editor on re-expand.
4. Excluding requires a reason, then shows the `Excluded` badge with the reason on hover; Restore clears it.
5. `read_console_messages` reports no errors.

- [ ] **Step 7: Commit**

```bash
git add app/finance/transactions/expenses/ManualSplitPanel.tsx app/finance/transactions/expenses/page.tsx app/finance/transactions/expenses/PayrollSplitCell.tsx
git commit -m "feat(finance): exclude-as-duplicate and manual GL split UI on Transactions"
```

---

## Definition of Done

- [ ] `npm run verify` passes on the branch.
- [ ] `lib/` coverage stays at or above the `vitest.config.ts` threshold floor.
- [ ] Final whole-branch review by an **Opus** agent (once, per CLAUDE.md).
- [ ] PR body states that `20260816_expense_manual_guards.sql` is a **hard deploy gate**: `fetchSources` queries `excluded_at`, so deploying before the migration is applied 500s the entire Financials view. Note that `20260814` and `20260815` are also unapplied.
- [ ] PR body notes the stranded Duke Energy row (`38ba080d-012d-43dc-bb34-d7942a6b6d90`) clears itself on the first post-deploy sync via Task 5 — no data migration.
