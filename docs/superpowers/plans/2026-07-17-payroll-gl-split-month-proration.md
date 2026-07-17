# Payroll GL-Split Month Proration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prorate a payroll expense's GL split-line amounts across the calendar months its matched pay period spans (by day count), instead of dumping the whole amount into the month of the transaction's posting date.

**Architecture:** A new pure function (`prorateAcrossMonths`) day-buckets an amount across a `[periodStart, periodEnd]` range with largest-remainder rounding. `fetchExpenses` gains a batched join to attach each matched expense's pay-period date range. `aggregateRows` calls the pure function per split line when a pay-period match exists, emitting one resolved row per month instead of one per line — which composes for free with the existing month-bucketing/grouping logic (no schema change). The Transactions UI shows the same breakdown using the identical pure function, no new API call.

**Tech Stack:** TypeScript, Vitest, Next.js App Router (React Server/Client Components), Supabase (read-only queries, no schema change).

## Global Constraints

- Payroll-matched expenses only (an expense with a `payroll_period_expense_matches` row). Non-payroll manual splits are untouched.
- Proration applies regardless of `split_source` (`payroll_auto` or `manual`) — `split_source` governs GL account, not month.
- Once matched, pay-period dates are ALWAYS the attribution basis — even for a period sitting entirely within one month whose expense posts in a different month.
- No schema changes, no new tables, no migration, no backfill script — this is a pure read-time computation off `pay_periods.start_date`/`end_date`, which already exist.
- No raw colors or hand-rolled primitives in the UI change — reuse existing token classes (`text-2xs`, `text-faint`, etc.) already used in the touched file.
- Full spec: `docs/superpowers/specs/2026-07-17-payroll-gl-split-month-proration-design.md`.

## Execution Budget

- **Execution mode:** Inline execution (`superpowers:executing-plans`) — 3 file-locality groups, tightly coupled, within the 4-6 file tier.
- **Spawn cap:** 3 + 2 = 5 (only relevant if executed subagent-driven instead).
- **Token target:** ~200k.

---

### Task 1: `prorateAcrossMonths` — the day-count proration algorithm

**Files:**
- Create: `lib/finance/payrollPeriodProration.ts`
- Test: `lib/finance/payrollPeriodProration.test.ts`

**Interfaces:**
- Produces: `export interface MonthAllocation { monthKey: string; amountCents: number }` and `export function prorateAcrossMonths(amountCents: number, periodStart: string, periodEnd: string): MonthAllocation[]`. `periodStart`/`periodEnd` are inclusive `"YYYY-MM-DD"` strings. `monthKey` is `"YYYY-MM"`. No DB/React imports — safe to import from both server and client code.

- [ ] **Step 1: Write the failing tests**

Create `lib/finance/payrollPeriodProration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { prorateAcrossMonths } from "./payrollPeriodProration";

describe("prorateAcrossMonths", () => {
  it("splits an exact 50/50 across a 7+7 day period spanning May/June", () => {
    const result = prorateAcrossMonths(-42000, "2026-05-25", "2026-06-07");
    expect(result).toEqual([
      { monthKey: "2026-05", amountCents: -21000 },
      { monthKey: "2026-06", amountCents: -21000 },
    ]);
  });

  it("prorates an uneven 10+4 day split with largest-remainder rounding, summing exactly to the original amount", () => {
    const result = prorateAcrossMonths(-100000, "2026-05-22", "2026-06-04"); // May 22-31 = 10 days, Jun 1-4 = 4 days
    expect(result).toEqual([
      { monthKey: "2026-05", amountCents: -71429 },
      { monthKey: "2026-06", amountCents: -28571 },
    ]);
    const sum = result.reduce((s, r) => s + r.amountCents, 0);
    expect(sum).toBe(-100000);
  });

  it("returns a single entry for a period entirely within one month", () => {
    const result = prorateAcrossMonths(-5000, "2026-06-01", "2026-06-14");
    expect(result).toEqual([{ monthKey: "2026-06", amountCents: -5000 }]);
  });

  it("handles a period spanning 3 calendar months", () => {
    const result = prorateAcrossMonths(-3400, "2026-05-30", "2026-07-02"); // May 30-31 = 2 days, Jun 1-30 = 30 days, Jul 1-2 = 2 days (34 total)
    expect(result).toEqual([
      { monthKey: "2026-05", amountCents: -200 },
      { monthKey: "2026-06", amountCents: -3000 },
      { monthKey: "2026-07", amountCents: -200 },
    ]);
    const sum = result.reduce((s, r) => s + r.amountCents, 0);
    expect(sum).toBe(-3400);
  });

  it("breaks an exact tie by keeping the earlier month first (stable order), summing exactly to the original odd-cent amount", () => {
    const result = prorateAcrossMonths(-100001, "2026-05-25", "2026-06-07"); // 7+7 days, -50000.5 each before rounding
    expect(result).toEqual([
      { monthKey: "2026-05", amountCents: -50001 },
      { monthKey: "2026-06", amountCents: -50000 },
    ]);
    const sum = result.reduce((s, r) => s + r.amountCents, 0);
    expect(sum).toBe(-100001);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/finance/payrollPeriodProration.test.ts`
Expected: FAIL — `Cannot find module './payrollPeriodProration'` (or similar; the module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `lib/finance/payrollPeriodProration.ts`:

```ts
/**
 * Payroll pay-period month proration.
 *
 * A matched expense's GL split-line amounts are attributed to the calendar
 * month(s) its pay period actually covers -- not the month the Gusto
 * withdrawal happened to post in. Pure day-count proration with
 * largest-remainder rounding (same technique as computeProportionalSplits
 * in ./payrollMatching.ts), so the parts always sum exactly to the input.
 * No DB/React imports -- shared by aggregateRows.ts (server) and
 * PayrollSplitCell.tsx (client).
 *
 * See docs/superpowers/specs/2026-07-17-payroll-gl-split-month-proration-design.md.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseDateUTC(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function monthKeyOfUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface MonthAllocation {
  monthKey: string; // "YYYY-MM"
  amountCents: number;
}

/**
 * Splits amountCents across every calendar month the inclusive
 * [periodStart, periodEnd] range touches, proportional to each month's day
 * count within the range. amountCents may be negative (outflow, the usual
 * case for expenses) or positive; the sign is preserved and parts always
 * sum exactly to amountCents via largest-remainder rounding. A single-month
 * period returns a one-element array.
 */
export function prorateAcrossMonths(amountCents: number, periodStart: string, periodEnd: string): MonthAllocation[] {
  const start = parseDateUTC(periodStart);
  const end = parseDateUTC(periodEnd);

  const dayCountByMonth = new Map<string, number>();
  let totalDays = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += MS_PER_DAY) {
    const key = monthKeyOfUTC(new Date(t));
    dayCountByMonth.set(key, (dayCountByMonth.get(key) ?? 0) + 1);
    totalDays += 1;
  }

  const months = [...dayCountByMonth.keys()];
  const lines = months.map((monthKey) => {
    const days = dayCountByMonth.get(monthKey)!;
    const raw = (amountCents * days) / totalDays;
    const truncated = Math.trunc(raw); // amountCents is often negative; truncate toward zero, not floor toward -Infinity
    return { monthKey, amountCents: truncated, remainder: Math.abs(raw - truncated) };
  });

  const truncatedSum = lines.reduce((s, l) => s + l.amountCents, 0);
  const toDistributeTotal = amountCents - truncatedSum;
  const direction = toDistributeTotal > 0 ? 1 : toDistributeTotal < 0 ? -1 : 0;

  // Largest remainder first; ties keep the original (chronological) order (stable sort).
  const order = [...lines.keys()].sort((a, b) => lines[b].remainder - lines[a].remainder);
  let remaining = Math.abs(toDistributeTotal);
  for (const idx of order) {
    if (remaining === 0) break;
    lines[idx].amountCents += direction;
    remaining -= 1;
  }

  return lines.map((l) => ({ monthKey: l.monthKey, amountCents: l.amountCents }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/finance/payrollPeriodProration.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/finance/payrollPeriodProration.ts lib/finance/payrollPeriodProration.test.ts
git commit -m "$(cat <<'EOF'
feat(finance): add pay-period month proration algorithm

Pure day-count proration for splitting a payroll GL split-line amount
across the calendar months its matched pay period spans, with
largest-remainder rounding so parts always sum exactly to the input.
EOF
)"
```

---

### Task 2: Fetch each payroll-matched expense's pay-period date range

**Files:**
- Modify: `lib/finance/financials/aggregateRows.ts:69-78` (the `ExpenseRecord` interface)
- Modify: `lib/finance/financials/fetchSources.ts:337-399` (new fetch function + wire into `fetchExpenses`)
- Test: `lib/finance/financials/fetchSources.test.ts`

**Interfaces:**
- Consumes: nothing new (existing `fetchAllRows` from `lib/supabase/paginate`, already imported in `fetchSources.ts:14,80`).
- Produces: `ExpenseRecord.payrollPeriod?: { start: string; end: string } | null` (start/end are `"YYYY-MM-DD"`). `fetchExpenses` now populates this field. Task 3 consumes it.

- [ ] **Step 1: Add `payrollPeriod` to the `ExpenseRecord` interface**

In `lib/finance/financials/aggregateRows.ts`, in the `ExpenseRecord` interface (currently lines 69-78):

```ts
/** expenses row — chart_of_accounts_id already resolved upstream (sync-time rule match or manual pin). */
export interface ExpenseRecord {
  id: string;
  chartOfAccountsId: string | null;
  /** Signed by cash direction: outflow negative, inflow positive. */
  amountCents: number;
  accountingDate: string | null;
  mappingSource: MappingSource;
  /** Populated by fetchExpenses via a join to expense_gl_splits; undefined/[] when the expense has no split. */
  splitLines?: { chartOfAccountsId: string; amountCents: number; splitSource: "payroll_auto" | "manual" }[];
  /**
   * Matched pay period's date range (payroll_period_expense_matches ->
   * pay_periods.start_date/end_date), populated by fetchExpenses. When
   * present, this — not accountingDate — is the month-attribution basis for
   * splitLines; see prorateAcrossMonths in ../payrollPeriodProration.ts.
   * null/undefined when the expense has no payroll match.
   */
  payrollPeriod?: { start: string; end: string } | null;
}
```

- [ ] **Step 2: Write the failing tests**

In `lib/finance/financials/fetchSources.test.ts`, extend the fake client's `opts` and `from()` handler to also serve `payroll_period_expense_matches` and `pay_periods`, and add two new tests. Replace the whole file with:

```ts
// Covers fetchExpenses's expense_gl_splits + payroll-period batch-joins in
// isolation (the rest of fetchFinancialsSources's per-source fetches are
// exercised indirectly via buildFinancials.test.ts, which mocks
// fetchFinancialsSources wholesale).
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchExpenses } from "./fetchSources";

interface ExpensesRow {
  id: string;
  chart_of_accounts_id: string | null;
  amount_cents: number | null;
  accounting_date: string;
  mapping_source: string | null;
  state: string | null;
}

interface SplitRow {
  expense_id: string;
  chart_of_accounts_id: string;
  amount_cents: number;
  split_source: string;
}

interface MatchRow {
  expense_id: string;
  pay_period_id: string;
}

interface PeriodRow {
  id: string;
  start_date: string;
  end_date: string;
}

/**
 * Fake Supabase client for `expenses` + `expense_gl_splits` +
 * `payroll_period_expense_matches` + `pay_periods`. Query-builder chain
 * methods are no-ops that return `this`; `.range()` on the `expenses` table
 * paginates via fetchAllRows the same way lib/supabase/paginate.test.ts
 * does; `.in()` on the joined tables records its call count/args so tests
 * can assert each join is a single batched query, not one per expense.
 */
function fakeClient(opts: { expenses: ExpensesRow[]; splits: SplitRow[]; matches?: MatchRow[]; periods?: PeriodRow[] }) {
  const splitsQueryCalls: { table: string; inArgs?: [string, unknown[]] }[] = [];
  const matchesQueryCalls: { table: string; inArgs?: [string, unknown[]] }[] = [];
  const periodsQueryCalls: { table: string; inArgs?: [string, unknown[]] }[] = [];

  const client = {
    from(table: string) {
      if (table === "expenses") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          lte: () => chain,
          gte: () => chain,
          eq: () => chain,
          or: () => chain,
          order: () => chain,
          range: async (from: number, to: number) => ({ data: opts.expenses.slice(from, to + 1), error: null }),
        };
        return chain;
      }
      if (table === "expense_gl_splits") {
        const call: { table: string; inArgs?: [string, unknown[]] } = { table };
        splitsQueryCalls.push(call);
        const chain: Record<string, unknown> = {
          select: () => chain,
          in: (col: string, vals: unknown[]) => {
            call.inArgs = [col, vals];
            return chain;
          },
          order: () => chain,
          range: async (from: number, to: number) => {
            const ids = new Set(call.inArgs?.[1] ?? []);
            const filtered = opts.splits.filter((s) => ids.has(s.expense_id));
            return { data: filtered.slice(from, to + 1), error: null };
          },
        };
        return chain;
      }
      if (table === "payroll_period_expense_matches") {
        const call: { table: string; inArgs?: [string, unknown[]] } = { table };
        matchesQueryCalls.push(call);
        const chain: Record<string, unknown> = {
          select: () => chain,
          in: (col: string, vals: unknown[]) => {
            call.inArgs = [col, vals];
            return chain;
          },
          order: () => chain,
          range: async (from: number, to: number) => {
            const ids = new Set(call.inArgs?.[1] ?? []);
            const filtered = (opts.matches ?? []).filter((m) => ids.has(m.expense_id));
            return { data: filtered.slice(from, to + 1), error: null };
          },
        };
        return chain;
      }
      if (table === "pay_periods") {
        const call: { table: string; inArgs?: [string, unknown[]] } = { table };
        periodsQueryCalls.push(call);
        const chain: Record<string, unknown> = {
          select: () => chain,
          in: (col: string, vals: unknown[]) => {
            call.inArgs = [col, vals];
            return chain;
          },
          order: () => chain,
          range: async (from: number, to: number) => {
            const ids = new Set(call.inArgs?.[1] ?? []);
            const filtered = (opts.periods ?? []).filter((p) => ids.has(p.id));
            return { data: filtered.slice(from, to + 1), error: null };
          },
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return { client: client as unknown as SupabaseClient, splitsQueryCalls, matchesQueryCalls, periodsQueryCalls };
}

const RANGE = { startDateStr: "2026-01-01", start: "2026-01-01T00:00:00Z", endDateStr: "2026-01-31", end: "2026-02-01T00:00:00Z" };

describe("fetchExpenses", () => {
  it("attaches splitLines only to expenses that have expense_gl_splits rows, in one batched query", async () => {
    const { client, splitsQueryCalls } = fakeClient({
      expenses: [
        { id: "exp-1", chart_of_accounts_id: "coa-a", amount_cents: -1000, accounting_date: "2026-01-05", mapping_source: "rule", state: null },
        { id: "exp-2", chart_of_accounts_id: null, amount_cents: -2000, accounting_date: "2026-01-10", mapping_source: "unmapped", state: null },
        { id: "exp-3", chart_of_accounts_id: "coa-b", amount_cents: -500, accounting_date: "2026-01-12", mapping_source: "rule", state: null },
      ],
      splits: [
        { expense_id: "exp-1", chart_of_accounts_id: "coa-x", amount_cents: -700, split_source: "payroll_auto" },
        { expense_id: "exp-1", chart_of_accounts_id: "coa-y", amount_cents: -300, split_source: "payroll_auto" },
      ],
    });

    const result = await fetchExpenses(client, RANGE, false);

    expect(result).toHaveLength(3);
    const exp1 = result.find((r) => r.id === "exp-1")!;
    const exp2 = result.find((r) => r.id === "exp-2")!;
    const exp3 = result.find((r) => r.id === "exp-3")!;

    expect(exp1.splitLines).toEqual([
      { chartOfAccountsId: "coa-x", amountCents: -700, splitSource: "payroll_auto" },
      { chartOfAccountsId: "coa-y", amountCents: -300, splitSource: "payroll_auto" },
    ]);
    expect(exp2.splitLines ?? []).toEqual([]);
    expect(exp3.splitLines ?? []).toEqual([]);

    // Exactly one expense_gl_splits query (batched .in(), not one per expense).
    expect(splitsQueryCalls).toHaveLength(1);
    expect(splitsQueryCalls[0].inArgs?.[0]).toBe("expense_id");
    expect(splitsQueryCalls[0].inArgs?.[1]).toEqual(["exp-1", "exp-2", "exp-3"]);
  });

  it("does not query expense_gl_splits, payroll_period_expense_matches, or pay_periods at all when there are no expenses in range", async () => {
    const { client, splitsQueryCalls, matchesQueryCalls, periodsQueryCalls } = fakeClient({ expenses: [], splits: [] });
    const result = await fetchExpenses(client, RANGE, false);
    expect(result).toEqual([]);
    expect(splitsQueryCalls).toHaveLength(0);
    expect(matchesQueryCalls).toHaveLength(0);
    expect(periodsQueryCalls).toHaveLength(0);
  });

  it("attaches payrollPeriod (start/end) only to expenses matched to a pay period, via two batched joins", async () => {
    const { client, matchesQueryCalls, periodsQueryCalls } = fakeClient({
      expenses: [
        { id: "exp-1", chart_of_accounts_id: "coa-a", amount_cents: -42000, accounting_date: "2026-01-05", mapping_source: "rule", state: null },
        { id: "exp-2", chart_of_accounts_id: "coa-b", amount_cents: -1000, accounting_date: "2026-01-10", mapping_source: "rule", state: null },
      ],
      splits: [],
      matches: [{ expense_id: "exp-1", pay_period_id: "period-1" }],
      periods: [{ id: "period-1", start_date: "2026-05-25", end_date: "2026-06-07" }],
    });

    const result = await fetchExpenses(client, RANGE, false);

    const exp1 = result.find((r) => r.id === "exp-1")!;
    const exp2 = result.find((r) => r.id === "exp-2")!;
    expect(exp1.payrollPeriod).toEqual({ start: "2026-05-25", end: "2026-06-07" });
    expect(exp2.payrollPeriod ?? null).toBeNull();

    // One batched query per join, not one per expense.
    expect(matchesQueryCalls).toHaveLength(1);
    expect(matchesQueryCalls[0].inArgs?.[1]).toEqual(["exp-1", "exp-2"]);
    expect(periodsQueryCalls).toHaveLength(1);
    expect(periodsQueryCalls[0].inArgs?.[1]).toEqual(["period-1"]);
  });

  it("does not query pay_periods when no expense in range has a payroll match", async () => {
    const { client, matchesQueryCalls, periodsQueryCalls } = fakeClient({
      expenses: [{ id: "exp-1", chart_of_accounts_id: "coa-a", amount_cents: -1000, accounting_date: "2026-01-05", mapping_source: "rule", state: null }],
      splits: [],
      matches: [],
      periods: [],
    });

    const result = await fetchExpenses(client, RANGE, false);
    expect(result[0].payrollPeriod ?? null).toBeNull();
    expect(matchesQueryCalls).toHaveLength(1);
    expect(periodsQueryCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify the new ones fail**

Run: `npx vitest run lib/finance/financials/fetchSources.test.ts`
Expected: the pre-existing 2 tests still PASS; the 2 new payrollPeriod tests FAIL (`payrollPeriod` is `undefined`, and/or `unexpected table payroll_period_expense_matches` if `fetchExpenses` doesn't query it yet).

- [ ] **Step 4: Implement `fetchPayrollPeriodsByExpenseId` and wire it into `fetchExpenses`**

In `lib/finance/financials/fetchSources.ts`, add this function right after `fetchExpenseGlSplitsByExpenseId` (after line 363, before `export async function fetchExpenses`):

```ts
/**
 * Batch-fetches each expense's matched pay period date range (via
 * payroll_period_expense_matches -> pay_periods), for attachment onto
 * ExpenseRecord.payrollPeriod. Two flat batched .in() queries joined in JS
 * (not a nested embed -- this codebase has been bitten before by FK-embed
 * joins breaking on non-canonical constraint names). Empty map when
 * expenseIds is empty or no expense in the set has a match.
 */
async function fetchPayrollPeriodsByExpenseId(
  supabase: SupabaseClient,
  expenseIds: string[],
): Promise<Map<string, { start: string; end: string }>> {
  const byExpenseId = new Map<string, { start: string; end: string }>();
  if (expenseIds.length === 0) return byExpenseId;

  const matchRows = await fetchAllRows<{ expense_id: string; pay_period_id: string }>(() =>
    supabase
      .from("payroll_period_expense_matches")
      .select("expense_id, pay_period_id")
      .in("expense_id", expenseIds)
      .order("expense_id", { ascending: true }),
  );
  if (matchRows.length === 0) return byExpenseId;

  const payPeriodIds = Array.from(new Set(matchRows.map((r) => r.pay_period_id)));
  const periodRows = await fetchAllRows<{ id: string; start_date: string; end_date: string }>(() =>
    supabase
      .from("pay_periods")
      .select("id, start_date, end_date")
      .in("id", payPeriodIds)
      .order("id", { ascending: true }),
  );
  const periodById = new Map(periodRows.map((p) => [p.id, { start: p.start_date, end: p.end_date }]));

  for (const m of matchRows) {
    const period = periodById.get(m.pay_period_id);
    if (period) byExpenseId.set(m.expense_id, period);
  }
  return byExpenseId;
}
```

Then modify `fetchExpenses` (currently lines 365-399) to fetch both joins concurrently and attach `payrollPeriod`:

```ts
export async function fetchExpenses(supabase: SupabaseClient, range: DateRange, cashOnly: boolean): Promise<ExpenseRecord[]> {
  const data = await fetchAllRows<{
    id: string;
    chart_of_accounts_id: string | null;
    amount_cents: number | null;
    accounting_date: string;
    mapping_source: string | null;
    state: string | null;
  }>(() => {
    let q = supabase
      .from("expenses")
      .select("id, chart_of_accounts_id, amount_cents, accounting_date, mapping_source, state")
      .lte("accounting_date", range.endDateStr)
      .order("id", { ascending: true });
    if (range.startDateStr) q = q.gte("accounting_date", range.startDateStr);
    // Cash basis = settled rows only. Card rows settle as "CLEARED" (Square,
    // uppercase); bank rows — every Gusto payroll withdrawal among them — settle
    // as "cleared" (bankLedger.ts, lowercase). A case-sensitive .eq("CLEARED")
    // silently dropped every bank/payroll expense (and its GL splits) from the
    // cash-flow statement, so match case-insensitively via ilike.
    q = cashOnly ? q.ilike("state", "cleared") : q.or("state.is.null,state.neq.DECLINED");
    return q;
  });

  const expenseIds = data.map((r) => r.id);
  const [splitsByExpenseId, payrollPeriodByExpenseId] = await Promise.all([
    fetchExpenseGlSplitsByExpenseId(supabase, expenseIds),
    fetchPayrollPeriodsByExpenseId(supabase, expenseIds),
  ]);

  return data.map((r) => ({
    id: r.id,
    chartOfAccountsId: r.chart_of_accounts_id,
    amountCents: r.amount_cents ?? 0,
    accountingDate: r.accounting_date,
    mappingSource: (r.mapping_source ?? "unmapped") as ExpenseRecord["mappingSource"],
    splitLines: splitsByExpenseId.get(r.id),
    payrollPeriod: payrollPeriodByExpenseId.get(r.id) ?? null,
  }));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/finance/financials/fetchSources.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no new errors (the `ExpenseRecord.payrollPeriod` field is optional, so every existing call site that builds an `ExpenseRecord` without it — e.g. test fixtures — still type-checks).

- [ ] **Step 7: Commit**

```bash
git add lib/finance/financials/aggregateRows.ts lib/finance/financials/fetchSources.ts lib/finance/financials/fetchSources.test.ts
git commit -m "$(cat <<'EOF'
feat(finance): fetch matched pay-period dates for payroll expenses

fetchExpenses now attaches each payroll-matched expense's pay_periods
start/end date range (batched joins, no embed), so aggregateRows can
attribute split-line amounts to the period's own months instead of the
transaction's posting date.
EOF
)"
```

---

### Task 3: Prorate payroll split lines across months in `aggregateRows`

**Files:**
- Modify: `lib/finance/financials/aggregateRows.ts:296-308`
- Test: `lib/finance/financials/aggregateRows.test.ts`

**Interfaces:**
- Consumes: `prorateAcrossMonths(amountCents, periodStart, periodEnd): MonthAllocation[]` from `../payrollPeriodProration` (Task 1). `ExpenseRecord.payrollPeriod` (Task 2).
- Produces: no new exports — behavior change only, inside `aggregateRows()`.

- [ ] **Step 1: Write the failing tests**

In `lib/finance/financials/aggregateRows.test.ts`, add these three `it()` blocks inside the existing `describe("aggregateRows", ...)` block, after the existing `"a split expense with 3 lines..."` test (currently ending around line 489):

```ts
  it("a payroll-matched expense's split line prorates across the months its pay period spans (50/50 for a 7+7 day period), regardless of when the transaction posted", () => {
    const rows = aggregateRows(
      emptyInput({
        months: ["2026-05", "2026-06"],
        expenses: [
          {
            id: "exp-payroll",
            chartOfAccountsId: null,
            amountCents: -42000,
            accountingDate: "2026-06-03", // posts in June -- attribution should still split May/June by pay period days
            mappingSource: "unmapped",
            payrollPeriod: { start: "2026-05-25", end: "2026-06-07" }, // 7 days May + 7 days June = 14
            splitLines: [{ chartOfAccountsId: "coa-expense", amountCents: -42000, splitSource: "payroll_auto" }],
          },
        ],
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].amountCentsByMonth["2026-05"]).toBe(-21000);
    expect(rows[0].amountCentsByMonth["2026-06"]).toBe(-21000);
  });

  it("a payroll-matched expense whose pay period sits entirely within one month attributes to that month even when accountingDate posts in a later month", () => {
    const rows = aggregateRows(
      emptyInput({
        months: ["2026-05", "2026-06"],
        expenses: [
          {
            id: "exp-payroll-delay",
            chartOfAccountsId: "coa-expense",
            amountCents: -10000,
            accountingDate: "2026-06-02", // posted days after the period ended
            mappingSource: "rule",
            payrollPeriod: { start: "2026-05-01", end: "2026-05-14" }, // entirely May
          },
        ],
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].amountCentsByMonth["2026-05"]).toBe(-10000);
    expect(rows[0].amountCentsByMonth["2026-06"] ?? 0).toBe(0);
  });

  it("multiple split lines on the same matched expense are each prorated independently, per-month sums equal each line's own amount", () => {
    const rows = aggregateRows(
      emptyInput({
        months: ["2026-05", "2026-06"],
        expenses: [
          {
            id: "exp-payroll-multi",
            chartOfAccountsId: null,
            amountCents: -68000,
            accountingDate: "2026-06-01",
            mappingSource: "unmapped",
            payrollPeriod: { start: "2026-05-25", end: "2026-06-07" }, // 7+7 days
            splitLines: [
              { chartOfAccountsId: "coa-beer", amountCents: -60000, splitSource: "payroll_auto" },
              { chartOfAccountsId: "coa-expense", amountCents: -8000, splitSource: "manual" },
            ],
          },
        ],
      }),
    );

    expect(rows).toHaveLength(2);
    const autoRow = rows.find((r) => r.coaId === "coa-beer")!;
    const manualRow = rows.find((r) => r.coaId === "coa-expense")!;

    expect(autoRow.amountCentsByMonth["2026-05"]).toBe(-30000);
    expect(autoRow.amountCentsByMonth["2026-06"]).toBe(-30000);
    expect(manualRow.amountCentsByMonth["2026-05"]).toBe(-4000);
    expect(manualRow.amountCentsByMonth["2026-06"]).toBe(-4000);
  });
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run lib/finance/financials/aggregateRows.test.ts`
Expected: the pre-existing tests PASS; the 3 new tests FAIL (all amount ends up in `"2026-06"` only, since `payrollPeriod` is not yet consumed).

- [ ] **Step 3: Implement the proration in `aggregateRows`**

In `lib/finance/financials/aggregateRows.ts`, add the import at the top (after the existing imports, e.g. after line 16):

```ts
import { prorateAcrossMonths } from "../payrollPeriodProration";
```

Then replace the `input.expenses` loop (currently lines 296-308):

```ts
  for (const row of input.expenses) {
    const lines = row.splitLines?.length
      ? row.splitLines.map((l) => ({
          coaId: l.chartOfAccountsId,
          amountCents: l.amountCents,
          mappingSource: (l.splitSource === "manual" ? "manual" : "rule") as MappingSource,
        }))
      : [{ coaId: row.chartOfAccountsId, amountCents: row.amountCents, mappingSource: row.mappingSource }];
    for (const line of lines) {
      const r = resolveExpenseLike("expenses", row.id, line.coaId, line.mappingSource, line.amountCents, row.accountingDate, coaMap, "expense");
      if (r && monthSet.has(r.monthKey)) resolved.push(r);
    }
  }
```

with:

```ts
  for (const row of input.expenses) {
    const lines = row.splitLines?.length
      ? row.splitLines.map((l) => ({
          coaId: l.chartOfAccountsId,
          amountCents: l.amountCents,
          mappingSource: (l.splitSource === "manual" ? "manual" : "rule") as MappingSource,
        }))
      : [{ coaId: row.chartOfAccountsId, amountCents: row.amountCents, mappingSource: row.mappingSource }];
    for (const line of lines) {
      if (row.payrollPeriod) {
        // Once matched, the pay period's own day range is the attribution
        // basis -- not accountingDate (when the withdrawal happened to
        // post) -- so a period spanning a month boundary splits correctly.
        // See docs/superpowers/specs/2026-07-17-payroll-gl-split-month-proration-design.md.
        const allocations = prorateAcrossMonths(line.amountCents, row.payrollPeriod.start, row.payrollPeriod.end);
        for (const alloc of allocations) {
          const r = resolveExpenseLike("expenses", row.id, line.coaId, line.mappingSource, alloc.amountCents, `${alloc.monthKey}-01`, coaMap, "expense");
          if (r && monthSet.has(r.monthKey)) resolved.push(r);
        }
      } else {
        const r = resolveExpenseLike("expenses", row.id, line.coaId, line.mappingSource, line.amountCents, row.accountingDate, coaMap, "expense");
        if (r && monthSet.has(r.monthKey)) resolved.push(r);
      }
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/finance/financials/aggregateRows.test.ts`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Run the full test suite + typecheck**

Run: `npm run test && npm run typecheck`
Expected: PASS. (Also double-check `lib/finance/payrollMatching.test.ts`, which imports `aggregateRows` directly, still passes unaffected — it doesn't set `payrollPeriod` on its fixtures, so it exercises the unchanged `else` branch.)

- [ ] **Step 6: Commit**

```bash
git add lib/finance/financials/aggregateRows.ts lib/finance/financials/aggregateRows.test.ts
git commit -m "$(cat <<'EOF'
fix(finance): attribute payroll GL splits by pay-period month, not posting date

A pay period spanning a month boundary (e.g. last week of May + first
week of June) previously dumped its entire split-line amount into
whichever month the Gusto withdrawal happened to post in. Matched
expenses now prorate by the period's own day range via
prorateAcrossMonths, composing with the existing month-bucketing in
aggregateRows with no schema change.
EOF
)"
```

---

### Task 4: Show the per-month breakdown in the Transactions UI

**Files:**
- Modify: `app/finance/transactions/expenses/PayrollSplitCell.tsx`

**Interfaces:**
- Consumes: `prorateAcrossMonths(amountCents, periodStart, periodEnd): MonthAllocation[]` from `@/lib/finance/payrollPeriodProration` (Task 1). `PayrollMatchInfo.periodStart`/`periodEnd` (already exists in this file, lines 13-18, and is already populated by the existing GET /api/finance/expenses route — no API change needed).
- Produces: no new exports — visual change only inside `PayrollSplitPanel`.

- [ ] **Step 1: Add the import and a formatting helper**

In `app/finance/transactions/expenses/PayrollSplitCell.tsx`, add to the imports (after line 5):

```ts
import { prorateAcrossMonths } from "@/lib/finance/payrollPeriodProration";
```

Add this helper after `fmtCents` (after line 34):

```ts
/** "May $210.00 · Jun $210.00" breakdown when a line's pay period spans multiple months; null for a single-month period. */
function fmtMonthBreakdown(amountCents: number, periodStart: string, periodEnd: string): string | null {
  const allocations = prorateAcrossMonths(amountCents, periodStart, periodEnd);
  if (allocations.length <= 1) return null;
  return allocations
    .map(({ monthKey, amountCents: cents }) => {
      const [y, m] = monthKey.split("-").map(Number);
      const label = new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short" });
      return `${label} ${fmtCents(Math.abs(cents))}`;
    })
    .join(" · ");
}
```

- [ ] **Step 2: Render the breakdown under each split line**

In `PayrollSplitPanel`, replace the `glLines.map` block (currently lines 189-201):

```tsx
              {glLines.map((l, i) => (
                <li key={i} className="flex items-center justify-between gap-3">
                  <span className="truncate">
                    {accountLabel(accounts, l.chartOfAccountsId)}
                    {l.splitSource === "manual" && (
                      <span title="Manually overridden">
                        <Badge tone="info" className="ml-1">manual</Badge>
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-body shrink-0">{fmtCents(Math.abs(l.amountCents))}</span>
                </li>
              ))}
```

with:

```tsx
              {glLines.map((l, i) => {
                const breakdown = payrollMatch ? fmtMonthBreakdown(l.amountCents, payrollMatch.periodStart, payrollMatch.periodEnd) : null;
                return (
                  <li key={i} className="flex flex-col gap-0.5">
                    <span className="flex items-center justify-between gap-3">
                      <span className="truncate">
                        {accountLabel(accounts, l.chartOfAccountsId)}
                        {l.splitSource === "manual" && (
                          <span title="Manually overridden">
                            <Badge tone="info" className="ml-1">manual</Badge>
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-body shrink-0">{fmtCents(Math.abs(l.amountCents))}</span>
                    </span>
                    {breakdown && <span className="text-2xs text-faint">→ {breakdown}</span>}
                  </li>
                );
              })}
```

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no new errors.

- [ ] **Step 4: Manual browser verification**

This codebase has no component-test convention for `app/` (`vitest.config.ts`'s `include` only picks up `*.test.ts`, and there are zero `*.test.tsx` files anywhere under `app/`), so this step is a manual check, not an automated test:

1. Start the dev server (`npm run dev`).
2. Navigate to Finance → Transactions → Expenses.
3. Find (or temporarily set up in a local/dev DB) a payroll expense matched to a pay period whose `start_date`/`end_date` cross a month boundary, with an active Gusto GL split.
4. Open its row dropdown (`PayrollSplitPanel`) and confirm each split line shows a `→ Mon $X.XX · Mon $Y.YY` breakdown under the amount, and that a single-month-matched expense's panel is visually unchanged (no breakdown line).

- [ ] **Step 5: Commit**

```bash
git add app/finance/transactions/expenses/PayrollSplitCell.tsx
git commit -m "$(cat <<'EOF'
feat(finance): show per-month breakdown for cross-month payroll splits

PayrollSplitPanel now displays each split line's month-by-month
attribution (e.g. "May $210.00 · Jun $210.00") when its matched pay
period spans more than one calendar month, using the same
prorateAcrossMonths function the P&L now uses -- no new API call.
EOF
)"
```

---

## Definition of Done

- [ ] All four tasks committed.
- [ ] `npm run verify` (lint + typecheck + test) passes clean.
- [ ] Manual browser check from Task 4 Step 4 completed and confirmed.
- [ ] No schema/migration changes made (per Global Constraints) — confirm `git diff main --stat` touches only the 5 files listed across Tasks 1-4 (plus the two doc files already committed during brainstorming).
