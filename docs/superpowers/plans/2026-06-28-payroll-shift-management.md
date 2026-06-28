# Payroll & Shift Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bartender shift tracking and payroll calculation to the app, pulling hours and tips from Square, computing per-employee Gusto payroll figures, and presenting them in role-gated views.

**Architecture:** Square Labor and Payments APIs supply hours and tip totals on demand; pure functions in `lib/payroll/calculations.ts` compute per-employee figures; API routes serve a unified `/preview` endpoint consumed by a shared `<PayrollPeriodView>` component rendered in both Taproom (manager read-only) and Finance (admin full control) tabs. Payroll periods are stored in Supabase; admin locks a period to snapshot final values.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, Supabase Postgres, Square REST API (raw fetch via `lib/square/client.ts`), React Query v5, Vitest (added for pure-function tests only).

## Global Constraints

- All API route handlers must use `requireRole` from `lib/auth.ts` — never roll custom role checks.
- Business logic lives in `lib/`, not in `app/api/` route handlers.
- Use `createSupabaseServerClient` in route handlers; `createSupabaseBrowserClient` in client components only.
- Wrap route errors with `apiError()` from `lib/utils/api.ts`.
- All money values stored and computed in cents (integer). Display formatting uses existing `lib/utils/formatting.ts`.
- All new query keys registered in `lib/query-keys.ts`.
- Square API calls use `squareGet`, `squarePost`, `squareGetAll`, `squarePostAll` from `lib/square/client.ts`.
- Schema changes go in a new migration file; never edit existing migrations.
- `export const dynamic = "force-dynamic"` on every API route.
- Spec: `docs/superpowers/specs/2026-06-28-payroll-shift-management-design.md`

---

## File Map

**New files:**
- `supabase/migrations/20260628_payroll_schema.sql` — 4 new tables
- `lib/square/labor.ts` — Square Labor API: shifts → hours per team member
- `lib/square/payroll.ts` — Square Payments API: total pooled tips + cash take
- `lib/payroll/types.ts` — shared TypeScript types for all payroll domain objects
- `lib/payroll/calculations.ts` — pure payroll computation functions (Vitest-tested)
- `lib/payroll/periodUtils.ts` — biweekly period boundary helpers
- `lib/payroll/previewService.ts` — assembles Square data + calculations + adjustments for the /preview route
- `app/api/payroll/config/route.ts` — GET/PATCH payroll config
- `app/api/payroll/employees/route.ts` — GET/POST employees
- `app/api/payroll/employees/[id]/route.ts` — PATCH employee
- `app/api/payroll/periods/route.ts` — GET/POST pay periods
- `app/api/payroll/periods/[id]/route.ts` — GET single period
- `app/api/payroll/periods/[id]/preview/route.ts` — GET live preview (Square + calculations)
- `app/api/payroll/periods/[id]/entries/[employeeId]/route.ts` — PATCH admin adjustments
- `app/api/payroll/periods/[id]/lock/route.ts` — POST lock period
- `lib/hooks/usePayrollPeriod.ts` — React Query hook for preview data
- `app/components/payroll/PayrollPeriodView.tsx` — shared period view component
- `app/components/payroll/PayrollEntryRow.tsx` — single employee row (read-only or editable)
- `app/components/payroll/GustoSummaryPanel.tsx` — Gusto-formatted summary (Finance only)
- `app/components/payroll/SalariedConfirmationList.tsx` — salaried employee checklist (Finance only)
- `app/components/payroll/PeriodSelector.tsx` — period navigation dropdown
- `app/taproom/payroll/layout.tsx` — manager+ role guard
- `app/taproom/payroll/page.tsx` — redirect to current open period
- `app/taproom/payroll/[periodId]/page.tsx` — taproom period view page
- `app/finance/payroll/PayrollNav.tsx` — Finance Payroll sub-nav
- `app/finance/payroll/page.tsx` — period list
- `app/finance/payroll/[periodId]/page.tsx` — Finance period view page
- `app/finance/payroll/settings/page.tsx` — payroll config + employee management

**Modified files:**
- `lib/query-keys.ts` — add `payroll` domain
- `app/taproom/nav-config.ts` — add Payroll entry with `managerOnly: true`
- `app/components/NavBar.tsx` — add `managerOnly` filter logic to `NavEntry` type and render

---

## Task 1: Database Schema

**Files:**
- Create: `supabase/migrations/20260628_payroll_schema.sql`

**Interfaces:**
- Produces: `payroll_config`, `employees`, `pay_periods`, `payroll_entries` tables used by all subsequent tasks.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260628_payroll_schema.sql

-- ── Enums ────────────────────────────────────────────────────────────────────

create type job_title_enum as enum ('Bartender', 'Brewer', 'Taproom Manager');
create type employment_type_enum as enum ('salary_no_overtime', 'salary_overtime_eligible', 'hourly');

-- ── payroll_config ───────────────────────────────────────────────────────────
-- Versioned: insert a new row when rates change; active row = highest
-- effective_from <= today. first_pay_period_start_date is the anchor for
-- computing period boundaries when no periods exist yet.

create table payroll_config (
  id                          uuid primary key default gen_random_uuid(),
  effective_from              date not null unique,
  base_rate_cents             integer not null check (base_rate_cents > 0),
  guaranteed_rate_cents       integer not null check (guaranteed_rate_cents >= base_rate_cents),
  cash_tips_rate              numeric(5,4) not null default 0.0100
                                check (cash_tips_rate >= 0 and cash_tips_rate <= 1),
  tip_distribution_model      text not null default 'proportional_hours'
                                check (tip_distribution_model in ('proportional_hours')),
  first_pay_period_start_date date not null,
  created_at                  timestamptz not null default now()
);

-- ── employees ────────────────────────────────────────────────────────────────

create table employees (
  id                    uuid primary key default gen_random_uuid(),
  first_name            text not null,
  last_name             text not null,
  email                 text not null,
  phone_number          text,
  job_title             job_title_enum not null,
  employment_type       employment_type_enum not null,
  receives_tips         boolean not null default false,
  square_team_member_id text unique,
  gusto_employee_id     text,
  active                boolean not null default true,
  created_at            timestamptz not null default now()
);

-- ── pay_periods ───────────────────────────────────────────────────────────────

create table pay_periods (
  id          uuid primary key default gen_random_uuid(),
  start_date  date not null unique,
  end_date    date not null,
  status      text not null default 'open' check (status in ('open', 'locked')),
  locked_at   timestamptz,
  locked_by   uuid references profiles(id),
  created_at  timestamptz not null default now(),
  constraint valid_date_range check (end_date > start_date),
  constraint lock_consistency check (
    (status = 'locked' and locked_at is not null and locked_by is not null) or
    (status = 'open'   and locked_at is null     and locked_by is null)
  )
);

-- ── payroll_entries ───────────────────────────────────────────────────────────
-- Rows are written lazily: when admin saves an adjustment (PATCH /entries/[id])
-- or when a period is locked (POST /lock upserts all eligible employees).
-- computed_* fields are the Square-derived values snapshotted at lock time.
-- adj_* fields are admin overrides; null = use computed value (COALESCE logic).

create table payroll_entries (
  id                        uuid primary key default gen_random_uuid(),
  pay_period_id             uuid not null references pay_periods(id) on delete cascade,
  employee_id               uuid not null references employees(id),
  hours_worked              numeric(8,4),
  paycheck_tips_cents       integer,
  cash_tips_cents           integer,
  bonus_cents               integer,
  adj_hours_worked          numeric(8,4),
  adj_paycheck_tips_cents   integer,
  adj_cash_tips_cents       integer,
  adj_bonus_cents           integer,
  admin_notes               text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (pay_period_id, employee_id)
);

create or replace function set_payroll_entries_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger payroll_entries_updated_at
  before update on payroll_entries
  for each row execute procedure set_payroll_entries_updated_at();
```

- [ ] **Step 2: Apply migration**

```bash
npx supabase db push
```

Expected: migration applies without errors. Verify in Supabase dashboard that all 4 tables exist.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260628_payroll_schema.sql
git commit -m "feat(payroll): add payroll schema (config, employees, pay_periods, entries)"
```

---

## Task 2: Square Labor & Payments Modules

**Files:**
- Create: `lib/square/labor.ts`
- Create: `lib/square/payroll.ts`

**Interfaces:**
- Consumes: `squareGetAll` from `lib/square/client.ts`
- Produces:
  - `fetchShiftHours(startDate: string, endDate: string): Promise<Map<string, number>>` — team_member_id → decimal hours
  - `fetchTipsAndCashTake(startDate: string, endDate: string): Promise<{ totalPooledTipsCents: number; totalCashTakeCents: number }>`

- [ ] **Step 1: Write `lib/square/labor.ts`**

```typescript
import { squareGetAll, squareLocationId } from "./client";

interface SquareShift {
  id: string;
  team_member_id: string;
  location_id: string;
  start_at: string;
  end_at: string | null;
  status: "OPEN" | "CLOSED";
}

/**
 * Fetches all CLOSED shifts for the location within [startDate, endDate]
 * (inclusive, YYYY-MM-DD). Returns a map of team_member_id → total decimal hours.
 * Shifts without an end_at are skipped (still clocked in).
 */
export async function fetchShiftHours(
  startDate: string,
  endDate: string
): Promise<Map<string, number>> {
  const shifts = await squareGetAll<SquareShift>("/labor/shifts", "shifts", {
    location_id: squareLocationId(),
    start_at: `${startDate}T00:00:00Z`,
    end_at: `${endDate}T23:59:59Z`,
    status: "CLOSED",
  });

  const hoursMap = new Map<string, number>();
  for (const shift of shifts) {
    if (!shift.end_at) continue;
    const ms =
      new Date(shift.end_at).getTime() - new Date(shift.start_at).getTime();
    const hours = ms / (1000 * 60 * 60);
    hoursMap.set(
      shift.team_member_id,
      (hoursMap.get(shift.team_member_id) ?? 0) + hours
    );
  }
  return hoursMap;
}
```

- [ ] **Step 2: Write `lib/square/payroll.ts`**

```typescript
import { squareGetAll, squareLocationId } from "./client";

interface SquarePayment {
  id: string;
  status: string;
  source_type: string;
  amount_money: { amount: number; currency: string };
  tip_money?: { amount: number; currency: string };
  total_money: { amount: number; currency: string };
}

/**
 * Fetches all COMPLETED payments for the location within [startDate, endDate].
 * Returns:
 *   totalPooledTipsCents — sum of tip_money across all payments (card + cash)
 *   totalCashTakeCents   — sum of total_money where source_type = "CASH"
 */
export async function fetchTipsAndCashTake(
  startDate: string,
  endDate: string
): Promise<{ totalPooledTipsCents: number; totalCashTakeCents: number }> {
  const payments = await squareGetAll<SquarePayment>("/payments", "payments", {
    location_id: squareLocationId(),
    begin_time: `${startDate}T00:00:00Z`,
    end_time: `${endDate}T23:59:59Z`,
    sort_order: "ASC",
  });

  const completed = payments.filter((p) => p.status === "COMPLETED");

  const totalPooledTipsCents = completed.reduce(
    (sum, p) => sum + (p.tip_money?.amount ?? 0),
    0
  );
  const totalCashTakeCents = completed
    .filter((p) => p.source_type === "CASH")
    .reduce((sum, p) => sum + p.total_money.amount, 0);

  return { totalPooledTipsCents, totalCashTakeCents };
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npm run build 2>&1 | grep -E "error|Error" | head -20
```

Expected: no new errors related to `lib/square/labor.ts` or `lib/square/payroll.ts`.

- [ ] **Step 4: Commit**

```bash
git add lib/square/labor.ts lib/square/payroll.ts
git commit -m "feat(payroll): add Square labor and payments modules"
```

---

## Task 3: Payroll Types, Calculations & Period Utils

**Files:**
- Create: `lib/payroll/types.ts`
- Create: `lib/payroll/calculations.ts`
- Create: `lib/payroll/periodUtils.ts`
- Create: `lib/payroll/__tests__/calculations.test.ts`
- Create: `lib/payroll/__tests__/periodUtils.test.ts`
- Create: `vitest.config.ts`

**Interfaces:**
- Produces:
  - `PayrollConfig`, `Employee`, `PayPeriod`, `PayrollEntry`, `PayrollEntryComputed`, `PayrollEntryMerged` types
  - `computePayrollEntries(employees, shifts, totalPooledTipsCents, totalCashTakeCents, config): PayrollEntryComputed[]`
  - `mergeAdjustments(computed, adjustments): PayrollEntryMerged`
  - `computeNextPeriodDates(firstPeriodStartDate, lastEndDate): { start_date: string; end_date: string }`

- [ ] **Step 1: Add Vitest**

```bash
npm install -D vitest @vitest/coverage-v8
```

- [ ] **Step 2: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
```

- [ ] **Step 3: Add test script to `package.json`**

In `package.json`, add to `"scripts"`:
```json
"test": "vitest run"
```

- [ ] **Step 4: Write `lib/payroll/types.ts`**

```typescript
export type JobTitle = "Bartender" | "Brewer" | "Taproom Manager";
export type EmploymentType =
  | "salary_no_overtime"
  | "salary_overtime_eligible"
  | "hourly";
export type TipDistributionModel = "proportional_hours";
export type PayPeriodStatus = "open" | "locked";

export interface PayrollConfig {
  id: string;
  effective_from: string;
  base_rate_cents: number;
  guaranteed_rate_cents: number;
  cash_tips_rate: number;
  tip_distribution_model: TipDistributionModel;
  first_pay_period_start_date: string;
  created_at: string;
}

export interface Employee {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_number: string | null;
  job_title: JobTitle;
  employment_type: EmploymentType;
  receives_tips: boolean;
  square_team_member_id: string | null;
  gusto_employee_id: string | null;
  active: boolean;
  created_at: string;
}

export interface PayPeriod {
  id: string;
  start_date: string;
  end_date: string;
  status: PayPeriodStatus;
  locked_at: string | null;
  locked_by: string | null;
  created_at: string;
}

export interface PayrollEntry {
  id: string;
  pay_period_id: string;
  employee_id: string;
  hours_worked: number | null;
  paycheck_tips_cents: number | null;
  cash_tips_cents: number | null;
  bonus_cents: number | null;
  adj_hours_worked: number | null;
  adj_paycheck_tips_cents: number | null;
  adj_cash_tips_cents: number | null;
  adj_bonus_cents: number | null;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Values computed fresh from Square data each preview request. */
export interface PayrollEntryComputed {
  employee_id: string;
  hours_worked: number;
  paycheck_tips_cents: number;
  cash_tips_cents: number;
  bonus_cents: number;
  base_pay_cents: number;
  total_compensation_cents: number;
}

/** Computed values merged with any admin adjustments. Effective_* are final. */
export interface PayrollEntryMerged extends PayrollEntryComputed {
  adj_hours_worked: number | null;
  adj_paycheck_tips_cents: number | null;
  adj_cash_tips_cents: number | null;
  adj_bonus_cents: number | null;
  admin_notes: string | null;
  effective_hours: number;
  effective_paycheck_tips_cents: number;
  effective_cash_tips_cents: number;
  effective_bonus_cents: number;
  effective_total_compensation_cents: number;
}

/** Full preview response from /api/payroll/periods/[id]/preview */
export interface PayrollPreview {
  period: PayPeriod;
  config: PayrollConfig;
  entries: PayrollEntryMerged[];
  salaried_employees: Employee[];
  total_pooled_tips_cents: number;
  total_cash_take_cents: number;
}
```

- [ ] **Step 5: Write failing tests for `calculations.ts`**

```typescript
// lib/payroll/__tests__/calculations.test.ts
import { describe, it, expect } from "vitest";
import { computePayrollEntries, mergeAdjustments } from "../calculations";
import type { Employee, PayrollConfig } from "../types";

const config: PayrollConfig = {
  id: "c1",
  effective_from: "2026-01-01",
  base_rate_cents: 1000,       // $10/hr
  guaranteed_rate_cents: 1500, // $15/hr guaranteed
  cash_tips_rate: 0.01,
  tip_distribution_model: "proportional_hours",
  first_pay_period_start_date: "2026-01-05",
  created_at: "2026-01-01T00:00:00Z",
};

const mkEmployee = (id: string, sqId: string): Employee => ({
  id,
  first_name: "A",
  last_name: "B",
  email: "a@b.com",
  phone_number: null,
  job_title: "Bartender",
  employment_type: "hourly",
  receives_tips: true,
  square_team_member_id: sqId,
  gusto_employee_id: null,
  active: true,
  created_at: "2026-01-01T00:00:00Z",
});

describe("computePayrollEntries", () => {
  it("distributes tips proportionally by hours", () => {
    const employees = [mkEmployee("e1", "sq1"), mkEmployee("e2", "sq2")];
    const shifts = new Map([["sq1", 30], ["sq2", 10]]); // 75% / 25%
    const results = computePayrollEntries(employees, shifts, 10000, 50000, config);
    const e1 = results.find((r) => r.employee_id === "e1")!;
    const e2 = results.find((r) => r.employee_id === "e2")!;
    expect(e1.paycheck_tips_cents).toBe(7500);
    expect(e2.paycheck_tips_cents).toBe(2500);
  });

  it("computes cash tips as rate × cash_take × hour_share", () => {
    const employees = [mkEmployee("e1", "sq1")];
    const shifts = new Map([["sq1", 10]]);
    const results = computePayrollEntries(employees, shifts, 0, 100000, config);
    // 1% of 100000 = 1000, all to e1
    expect(results[0].cash_tips_cents).toBe(1000);
  });

  it("computes bonus when tips don't meet guaranteed rate", () => {
    const employees = [mkEmployee("e1", "sq1")];
    const shifts = new Map([["sq1", 10]]);
    // base_pay = 10 * 1000 = 10000
    // guaranteed = 10 * 1500 = 15000
    // paycheck_tips = 0, cash_tips = 0
    // bonus = 15000 - 10000 - 0 - 0 = 5000
    const results = computePayrollEntries(employees, shifts, 0, 0, config);
    expect(results[0].bonus_cents).toBe(5000);
  });

  it("bonus is zero when tips exceed guaranteed rate", () => {
    const employees = [mkEmployee("e1", "sq1")];
    const shifts = new Map([["sq1", 10]]);
    // paycheck_tips = 10000, base_pay = 10000, guaranteed = 15000
    // 10000 + 10000 = 20000 > 15000, so bonus = 0
    const results = computePayrollEntries(employees, shifts, 10000, 0, config);
    expect(results[0].bonus_cents).toBe(0);
  });

  it("excludes employees without square_team_member_id", () => {
    const emp: Employee = { ...mkEmployee("e1", ""), square_team_member_id: null };
    const results = computePayrollEntries([emp], new Map(), 0, 0, config);
    expect(results).toHaveLength(0);
  });

  it("returns zero hours for employees not in shifts map", () => {
    const employees = [mkEmployee("e1", "sq1")];
    const results = computePayrollEntries(employees, new Map(), 0, 0, config);
    expect(results[0].hours_worked).toBe(0);
  });
});

describe("mergeAdjustments", () => {
  const computed = {
    employee_id: "e1",
    hours_worked: 10,
    paycheck_tips_cents: 500,
    cash_tips_cents: 100,
    bonus_cents: 200,
    base_pay_cents: 1000,
    total_compensation_cents: 1800,
  };

  it("uses computed values when no adjustments", () => {
    const entry = { adj_hours_worked: null, adj_paycheck_tips_cents: null, adj_cash_tips_cents: null, adj_bonus_cents: null, admin_notes: null };
    const merged = mergeAdjustments(computed, entry);
    expect(merged.effective_hours).toBe(10);
    expect(merged.effective_paycheck_tips_cents).toBe(500);
  });

  it("uses adjusted value when set", () => {
    const entry = { adj_hours_worked: 12, adj_paycheck_tips_cents: null, adj_cash_tips_cents: null, adj_bonus_cents: null, admin_notes: null };
    const merged = mergeAdjustments(computed, entry);
    expect(merged.effective_hours).toBe(12);
  });

  it("recomputes total with effective values", () => {
    const entry = { adj_hours_worked: null, adj_paycheck_tips_cents: 1000, adj_cash_tips_cents: null, adj_bonus_cents: null, admin_notes: null };
    const merged = mergeAdjustments(computed, entry);
    // base_pay + effective_paycheck + effective_cash + effective_bonus
    expect(merged.effective_total_compensation_cents).toBe(1000 + 1000 + 100 + 200);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../calculations'`

- [ ] **Step 7: Write `lib/payroll/calculations.ts`**

```typescript
import type { Employee, PayrollConfig, PayrollEntryComputed, PayrollEntryMerged } from "./types";

export function computePayrollEntries(
  employees: Employee[],
  shifts: Map<string, number>,
  totalPooledTipsCents: number,
  totalCashTakeCents: number,
  config: PayrollConfig
): PayrollEntryComputed[] {
  const tippedEmployees = employees.filter(
    (e) => e.employment_type === "hourly" && e.receives_tips && e.square_team_member_id
  );

  const totalHours = tippedEmployees.reduce(
    (sum, e) => sum + (shifts.get(e.square_team_member_id!) ?? 0),
    0
  );

  return tippedEmployees.map((employee) => {
    const hours = shifts.get(employee.square_team_member_id!) ?? 0;
    const hourShare = totalHours > 0 ? hours / totalHours : 0;

    const paycheckTipsCents = Math.round(hourShare * totalPooledTipsCents);
    const cashTipsCents = Math.round(hourShare * config.cash_tips_rate * totalCashTakeCents);
    const basePayCents = Math.round(hours * config.base_rate_cents);
    const guaranteedMinCents = Math.round(hours * config.guaranteed_rate_cents);
    const bonusCents = Math.max(0, guaranteedMinCents - basePayCents - paycheckTipsCents - cashTipsCents);
    const totalCompensationCents = basePayCents + paycheckTipsCents + cashTipsCents + bonusCents;

    return {
      employee_id: employee.id,
      hours_worked: hours,
      paycheck_tips_cents: paycheckTipsCents,
      cash_tips_cents: cashTipsCents,
      bonus_cents: bonusCents,
      base_pay_cents: basePayCents,
      total_compensation_cents: totalCompensationCents,
    };
  });
}

type AdjustmentSource = {
  adj_hours_worked: number | null;
  adj_paycheck_tips_cents: number | null;
  adj_cash_tips_cents: number | null;
  adj_bonus_cents: number | null;
  admin_notes: string | null;
};

export function mergeAdjustments(
  computed: PayrollEntryComputed,
  adjustments: AdjustmentSource
): PayrollEntryMerged {
  const effectiveHours = adjustments.adj_hours_worked ?? computed.hours_worked;
  const effectivePaycheckTips = adjustments.adj_paycheck_tips_cents ?? computed.paycheck_tips_cents;
  const effectiveCashTips = adjustments.adj_cash_tips_cents ?? computed.cash_tips_cents;
  const effectiveBonus = adjustments.adj_bonus_cents ?? computed.bonus_cents;
  const effectiveTotal = computed.base_pay_cents + effectivePaycheckTips + effectiveCashTips + effectiveBonus;

  return {
    ...computed,
    ...adjustments,
    effective_hours: effectiveHours,
    effective_paycheck_tips_cents: effectivePaycheckTips,
    effective_cash_tips_cents: effectiveCashTips,
    effective_bonus_cents: effectiveBonus,
    effective_total_compensation_cents: effectiveTotal,
  };
}
```

- [ ] **Step 8: Write failing tests for `periodUtils.ts`**

```typescript
// lib/payroll/__tests__/periodUtils.test.ts
import { describe, it, expect } from "vitest";
import { computeNextPeriodDates } from "../periodUtils";

describe("computeNextPeriodDates", () => {
  it("uses anchor date when no prior periods", () => {
    const result = computeNextPeriodDates("2026-01-05", null);
    expect(result.start_date).toBe("2026-01-05");
    expect(result.end_date).toBe("2026-01-18");
  });

  it("starts the day after the last period's end", () => {
    const result = computeNextPeriodDates("2026-01-05", "2026-01-18");
    expect(result.start_date).toBe("2026-01-19");
    expect(result.end_date).toBe("2026-02-01");
  });
});
```

- [ ] **Step 9: Write `lib/payroll/periodUtils.ts`**

```typescript
/**
 * Computes start/end dates for the next biweekly pay period.
 * If no prior periods exist, uses firstPeriodStartDate as the start.
 * Otherwise, starts the day after lastEndDate.
 */
export function computeNextPeriodDates(
  firstPeriodStartDate: string,
  lastEndDate: string | null
): { start_date: string; end_date: string } {
  let start: Date;
  if (!lastEndDate) {
    start = new Date(firstPeriodStartDate);
  } else {
    start = new Date(lastEndDate);
    start.setUTCDate(start.getUTCDate() + 1);
  }

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 13); // 14-day period inclusive

  return {
    start_date: start.toISOString().slice(0, 10),
    end_date: end.toISOString().slice(0, 10),
  };
}
```

- [ ] **Step 10: Run tests — all should pass**

```bash
npm test
```

Expected: 11 tests pass.

- [ ] **Step 11: Commit**

```bash
git add vitest.config.ts lib/payroll/
npm pkg set scripts.test="vitest run"
git add package.json
git commit -m "feat(payroll): add types, calculations, periodUtils with Vitest tests"
```

---

## Task 4: Preview Service

**Files:**
- Create: `lib/payroll/previewService.ts`

**Interfaces:**
- Consumes: `fetchShiftHours` (labor.ts), `fetchTipsAndCashTake` (payroll.ts), `computePayrollEntries`, `mergeAdjustments` (calculations.ts), `PayrollConfig`, `Employee`, `PayPeriod`, `PayrollPreview` (types.ts)
- Produces: `buildPayrollPreview(period, employees, config, entries): Promise<PayrollPreview>` — used by the `/preview` route

- [ ] **Step 1: Write `lib/payroll/previewService.ts`**

```typescript
import { fetchShiftHours } from "@/lib/square/labor";
import { fetchTipsAndCashTake } from "@/lib/square/payroll";
import { computePayrollEntries, mergeAdjustments } from "./calculations";
import type { Employee, PayPeriod, PayrollConfig, PayrollEntry, PayrollPreview } from "./types";

/**
 * Fetches live Square data and builds the full payroll preview.
 * Merges any stored admin adjustments from payroll_entries rows.
 * Called only by the /preview API route — never cached.
 */
export async function buildPayrollPreview(
  period: PayPeriod,
  allEmployees: Employee[],
  config: PayrollConfig,
  storedEntries: PayrollEntry[]
): Promise<PayrollPreview> {
  const hourlyTipped = allEmployees.filter(
    (e) => e.employment_type === "hourly" && e.receives_tips && e.active
  );
  const salariedEmployees = allEmployees.filter(
    (e) => e.employment_type !== "hourly" && e.active
  );

  const [shifts, { totalPooledTipsCents, totalCashTakeCents }] = await Promise.all([
    fetchShiftHours(period.start_date, period.end_date),
    fetchTipsAndCashTake(period.start_date, period.end_date),
  ]);

  const computed = computePayrollEntries(
    hourlyTipped,
    shifts,
    totalPooledTipsCents,
    totalCashTakeCents,
    config
  );

  const entryMap = new Map(storedEntries.map((e) => [e.employee_id, e]));

  const entries = computed.map((c) => {
    const stored = entryMap.get(c.employee_id);
    return mergeAdjustments(c, {
      adj_hours_worked: stored?.adj_hours_worked ?? null,
      adj_paycheck_tips_cents: stored?.adj_paycheck_tips_cents ?? null,
      adj_cash_tips_cents: stored?.adj_cash_tips_cents ?? null,
      adj_bonus_cents: stored?.adj_bonus_cents ?? null,
      admin_notes: stored?.admin_notes ?? null,
    });
  });

  return {
    period,
    config,
    entries,
    salaried_employees: salariedEmployees,
    total_pooled_tips_cents: totalPooledTipsCents,
    total_cash_take_cents: totalCashTakeCents,
  };
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build 2>&1 | grep -E "^.*error" | head -20
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add lib/payroll/previewService.ts
git commit -m "feat(payroll): add preview service assembling Square data + calculations"
```

---

## Task 5: Config & Employee API Routes

**Files:**
- Create: `app/api/payroll/config/route.ts`
- Create: `app/api/payroll/employees/route.ts`
- Create: `app/api/payroll/employees/[id]/route.ts`

**Interfaces:**
- Consumes: `requireRole` (lib/auth.ts), `apiError` (lib/utils/api.ts), `createSupabaseServerClient` (lib/supabase/server.ts)
- Produces:
  - `GET /api/payroll/config` → `PayrollConfig`
  - `PATCH /api/payroll/config` → `PayrollConfig` (inserts new versioned row)
  - `GET /api/payroll/employees` → `Employee[]`
  - `POST /api/payroll/employees` → `Employee`
  - `PATCH /api/payroll/employees/[id]` → `Employee`

- [ ] **Step 1: Write `app/api/payroll/config/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("payroll_config")
    .select("*")
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();

  if (error) return apiError(error.message, 404);
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body = await req.json();
  const {
    effective_from,
    base_rate_cents,
    guaranteed_rate_cents,
    cash_tips_rate,
    tip_distribution_model,
    first_pay_period_start_date,
  } = body;

  if (!effective_from || !base_rate_cents || !guaranteed_rate_cents || !first_pay_period_start_date) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("payroll_config")
    .insert({
      effective_from,
      base_rate_cents,
      guaranteed_rate_cents,
      cash_tips_rate: cash_tips_rate ?? 0.01,
      tip_distribution_model: tip_distribution_model ?? "proportional_hours",
      first_pay_period_start_date,
    })
    .select()
    .single();

  if (error) return apiError(error.message);
  return NextResponse.json(data);
}
```

- [ ] **Step 2: Write `app/api/payroll/employees/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("employees")
    .select("*")
    .order("last_name");

  if (error) return apiError(error.message);
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body = await req.json();

  const { data, error } = await supabase
    .from("employees")
    .insert(body)
    .select()
    .single();

  if (error) return apiError(error.message);
  return NextResponse.json(data, { status: 201 });
}
```

- [ ] **Step 3: Write `app/api/payroll/employees/[id]/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;
  const body = await req.json();

  const { data, error } = await supabase
    .from("employees")
    .update(body)
    .eq("id", id)
    .select()
    .single();

  if (error) return apiError(error.message);
  return NextResponse.json(data);
}
```

- [ ] **Step 4: Verify with curl (replace TOKEN with a valid admin session cookie or Bearer token)**

```bash
# Should return 401 without auth — verify role guard works
curl -s http://localhost:3000/api/payroll/config | jq .
# Expected: {"error":"Unauthorized"} or redirect

# After seeding one payroll_config row via Supabase dashboard, GET should return it
```

- [ ] **Step 5: Commit**

```bash
git add app/api/payroll/config/ app/api/payroll/employees/
git commit -m "feat(payroll): add config and employee API routes"
```

---

## Task 6: Pay Period Routes (CRUD + Lock + Preview + Entries)

**Files:**
- Create: `app/api/payroll/periods/route.ts`
- Create: `app/api/payroll/periods/[id]/route.ts`
- Create: `app/api/payroll/periods/[id]/preview/route.ts`
- Create: `app/api/payroll/periods/[id]/entries/[employeeId]/route.ts`
- Create: `app/api/payroll/periods/[id]/lock/route.ts`

**Interfaces:**
- Consumes: `computeNextPeriodDates` (periodUtils.ts), `buildPayrollPreview` (previewService.ts), `mergeAdjustments` (calculations.ts), Supabase server client, `requireRole`, `apiError`
- Produces: All period, preview, entry, and lock endpoints listed in the spec.

- [ ] **Step 1: Write `app/api/payroll/periods/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { computeNextPeriodDates } from "@/lib/payroll/periodUtils";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("pay_periods")
    .select("*")
    .order("start_date", { ascending: false });

  if (error) return apiError(error.message);
  return NextResponse.json(data);
}

export async function POST(_req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  // Get the active config for first_pay_period_start_date
  const { data: config, error: configErr } = await supabase
    .from("payroll_config")
    .select("first_pay_period_start_date")
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();

  if (configErr) return apiError("No payroll config found — seed one first", 422);

  // Get the most recent period end date
  const { data: lastPeriod } = await supabase
    .from("pay_periods")
    .select("end_date")
    .order("end_date", { ascending: false })
    .limit(1)
    .single();

  const dates = computeNextPeriodDates(
    config.first_pay_period_start_date,
    lastPeriod?.end_date ?? null
  );

  const { data, error } = await supabase
    .from("pay_periods")
    .insert({ ...dates, status: "open" })
    .select()
    .single();

  if (error) return apiError(error.message);
  return NextResponse.json(data, { status: 201 });
}
```

- [ ] **Step 2: Write `app/api/payroll/periods/[id]/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;

  const { data, error } = await supabase
    .from("pay_periods")
    .select("*")
    .eq("id", id)
    .single();

  if (error) return apiError(error.message, 404);
  return NextResponse.json(data);
}
```

- [ ] **Step 3: Write `app/api/payroll/periods/[id]/preview/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { buildPayrollPreview } from "@/lib/payroll/previewService";
import type { PayPeriod, PayrollConfig, Employee, PayrollEntry } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;

  const [{ data: period, error: pErr }, { data: employees, error: eErr }, { data: config, error: cErr }] =
    await Promise.all([
      supabase.from("pay_periods").select("*").eq("id", id).single(),
      supabase.from("employees").select("*").eq("active", true).order("last_name"),
      supabase.from("payroll_config").select("*").order("effective_from", { ascending: false }).limit(1).single(),
    ]);

  if (pErr) return apiError(pErr.message, 404);
  if (eErr) return apiError(eErr.message);
  if (cErr) return apiError("No payroll config found", 422);

  // Fetch the config version active at the period start date
  const { data: periodConfig } = await supabase
    .from("payroll_config")
    .select("*")
    .lte("effective_from", (period as PayPeriod).start_date)
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();

  const activeConfig = (periodConfig ?? config) as PayrollConfig;

  const { data: storedEntries } = await supabase
    .from("payroll_entries")
    .select("*")
    .eq("pay_period_id", id);

  const preview = await buildPayrollPreview(
    period as PayPeriod,
    employees as Employee[],
    activeConfig,
    (storedEntries ?? []) as PayrollEntry[]
  );

  return NextResponse.json(preview);
}
```

- [ ] **Step 4: Write `app/api/payroll/periods/[id]/entries/[employeeId]/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; employeeId: string }> }
) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id: pay_period_id, employeeId: employee_id } = await params;

  // Verify period is still open
  const { data: period } = await supabase
    .from("pay_periods")
    .select("status")
    .eq("id", pay_period_id)
    .single();

  if (!period || period.status !== "open") {
    return NextResponse.json({ error: "Period is locked" }, { status: 409 });
  }

  const body = await req.json();
  const allowed = ["adj_hours_worked", "adj_paycheck_tips_cents", "adj_cash_tips_cents", "adj_bonus_cents", "admin_notes"];
  const update = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));

  const { data, error } = await supabase
    .from("payroll_entries")
    .upsert({ pay_period_id, employee_id, ...update }, { onConflict: "pay_period_id,employee_id" })
    .select()
    .single();

  if (error) return apiError(error.message);
  return NextResponse.json(data);
}
```

- [ ] **Step 5: Write `app/api/payroll/periods/[id]/lock/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireRole, getSessionUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { buildPayrollPreview } from "@/lib/payroll/previewService";
import type { PayPeriod, PayrollConfig, Employee, PayrollEntry } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const session = await getSessionUser();
  const supabase = await createSupabaseServerClient();
  const { id } = await params;

  const { data: period, error: pErr } = await supabase
    .from("pay_periods")
    .select("*")
    .eq("id", id)
    .single();

  if (pErr || !period) return apiError("Period not found", 404);
  if (period.status === "locked") return NextResponse.json({ error: "Already locked" }, { status: 409 });

  // Build final preview to snapshot
  const [{ data: employees }, { data: storedEntries }] = await Promise.all([
    supabase.from("employees").select("*").eq("active", true),
    supabase.from("payroll_entries").select("*").eq("pay_period_id", id),
  ]);

  const { data: configRow } = await supabase
    .from("payroll_config")
    .select("*")
    .lte("effective_from", (period as PayPeriod).start_date)
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();

  const preview = await buildPayrollPreview(
    period as PayPeriod,
    (employees ?? []) as Employee[],
    configRow as PayrollConfig,
    (storedEntries ?? []) as PayrollEntry[]
  );

  // Upsert final snapshotted values for all hourly tipped employees
  const upserts = preview.entries.map((entry) => ({
    pay_period_id: id,
    employee_id: entry.employee_id,
    hours_worked: entry.effective_hours,
    paycheck_tips_cents: entry.effective_paycheck_tips_cents,
    cash_tips_cents: entry.effective_cash_tips_cents,
    bonus_cents: entry.effective_bonus_cents,
    adj_hours_worked: entry.adj_hours_worked,
    adj_paycheck_tips_cents: entry.adj_paycheck_tips_cents,
    adj_cash_tips_cents: entry.adj_cash_tips_cents,
    adj_bonus_cents: entry.adj_bonus_cents,
    admin_notes: entry.admin_notes,
  }));

  if (upserts.length > 0) {
    const { error: uErr } = await supabase
      .from("payroll_entries")
      .upsert(upserts, { onConflict: "pay_period_id,employee_id" });
    if (uErr) return apiError(uErr.message);
  }

  // Lock the period
  const { data: locked, error: lErr } = await supabase
    .from("pay_periods")
    .update({ status: "locked", locked_at: new Date().toISOString(), locked_by: session!.user.id })
    .eq("id", id)
    .select()
    .single();

  if (lErr) return apiError(lErr.message);
  return NextResponse.json(locked);
}
```

- [ ] **Step 6: Verify build**

```bash
npm run build 2>&1 | grep -E "^.*error TS" | head -20
```

Expected: no type errors in the new routes.

- [ ] **Step 7: Commit**

```bash
git add app/api/payroll/
git commit -m "feat(payroll): add pay period, preview, entries, and lock API routes"
```

---

## Task 7: Query Keys & Data Hook

**Files:**
- Modify: `lib/query-keys.ts`
- Create: `lib/hooks/usePayrollPeriod.ts`

**Interfaces:**
- Produces:
  - `queryKeys.payroll.all()`, `queryKeys.payroll.periods()`, `queryKeys.payroll.period(id)`, `queryKeys.payroll.preview(id)`, `queryKeys.payroll.employees()`, `queryKeys.payroll.config()`
  - `usePayrollPeriod(periodId: string): { data: PayrollPreview | undefined; isLoading: boolean; error: Error | null }`

- [ ] **Step 1: Add payroll keys to `lib/query-keys.ts`**

Add the following block inside the `queryKeys` object, after the `taproom` section:

```typescript
  // ─── Payroll ──────────────────────────────────────────────────────────────
  payroll: {
    all:       () => ["payroll"] as const,
    config:    () => ["payroll", "config"] as const,
    employees: () => ["payroll", "employees"] as const,
    periods:   () => ["payroll", "periods"] as const,
    period:    (id: string) => ["payroll", "periods", id] as const,
    preview:   (id: string) => ["payroll", "preview", id] as const,
  },
```

- [ ] **Step 2: Write `lib/hooks/usePayrollPeriod.ts`**

```typescript
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { PayrollPreview } from "@/lib/payroll/types";

async function fetchPreview(periodId: string): Promise<PayrollPreview> {
  const res = await fetch(`/api/payroll/periods/${periodId}/preview`);
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(error ?? "Failed to load payroll preview");
  }
  return res.json();
}

export function usePayrollPeriod(periodId: string) {
  return useQuery({
    queryKey: queryKeys.payroll.preview(periodId),
    queryFn: () => fetchPreview(periodId),
    enabled: !!periodId,
    staleTime: 30_000, // re-fetch after 30s since Square data changes
  });
}
```

- [ ] **Step 3: Verify build**

```bash
npm run build 2>&1 | grep -E "error TS" | head -10
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/query-keys.ts lib/hooks/usePayrollPeriod.ts
git commit -m "feat(payroll): add query keys and usePayrollPeriod hook"
```

---

## Task 8: Shared UI Components

**Files:**
- Create: `app/components/payroll/PeriodSelector.tsx`
- Create: `app/components/payroll/PayrollEntryRow.tsx`
- Create: `app/components/payroll/GustoSummaryPanel.tsx`
- Create: `app/components/payroll/SalariedConfirmationList.tsx`
- Create: `app/components/payroll/PayrollPeriodView.tsx`

**Interfaces:**
- Consumes: `usePayrollPeriod` hook, `PayrollPreview`, `PayrollEntryMerged`, `Employee` types
- Produces: `<PayrollPeriodView periodId editable showSalaried showGustoSummary />` — consumed by Taproom and Finance pages

- [ ] **Step 1: Write `app/components/payroll/PeriodSelector.tsx`**

```tsx
"use client";

import { useRouter } from "next/navigation";
import type { PayPeriod } from "@/lib/payroll/types";

interface Props {
  periods: PayPeriod[];
  currentId: string;
  basePath: string; // "/taproom/payroll" or "/finance/payroll"
}

export function PeriodSelector({ periods, currentId, basePath }: Props) {
  const router = useRouter();

  return (
    <select
      value={currentId}
      onChange={(e) => router.push(`${basePath}/${e.target.value}`)}
      className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-sm rounded px-2 py-1"
    >
      {periods.map((p) => (
        <option key={p.id} value={p.id}>
          {p.start_date} – {p.end_date}{p.status === "locked" ? " (Locked)" : " (Open)"}
        </option>
      ))}
    </select>
  );
}
```

- [ ] **Step 2: Write `app/components/payroll/PayrollEntryRow.tsx`**

```tsx
"use client";

import { useState } from "react";
import type { Employee, PayrollEntryMerged } from "@/lib/payroll/types";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";

interface Props {
  entry: PayrollEntryMerged;
  employee: Employee;
  periodId: string;
  editable: boolean;
}

function formatMoney(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function PayrollEntryRow({ entry, employee, periodId, editable }: Props) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [adjNotes, setAdjNotes] = useState(entry.admin_notes ?? "");
  const [adjBonus, setAdjBonus] = useState<string>(
    entry.adj_bonus_cents != null ? String(entry.adj_bonus_cents / 100) : ""
  );

  async function save() {
    setSaving(true);
    const body: Record<string, unknown> = { admin_notes: adjNotes || null };
    if (adjBonus !== "") body.adj_bonus_cents = Math.round(parseFloat(adjBonus) * 100);
    await fetch(`/api/payroll/periods/${periodId}/entries/${entry.employee_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.payroll.preview(periodId) });
    setSaving(false);
  }

  return (
    <tr className="border-b border-zinc-800">
      <td className="py-2 px-3 text-zinc-200 text-sm">
        {employee.first_name} {employee.last_name}
      </td>
      <td className="py-2 px-3 text-zinc-300 text-sm text-right">
        {entry.effective_hours.toFixed(2)}h
      </td>
      <td className="py-2 px-3 text-zinc-300 text-sm text-right">
        {formatMoney(entry.effective_paycheck_tips_cents)}
      </td>
      <td className="py-2 px-3 text-zinc-300 text-sm text-right">
        {formatMoney(entry.effective_cash_tips_cents)}
      </td>
      <td className="py-2 px-3 text-sm text-right">
        {editable ? (
          <input
            type="number"
            step="0.01"
            min="0"
            value={adjBonus}
            placeholder={formatMoney(entry.bonus_cents)}
            onChange={(e) => setAdjBonus(e.target.value)}
            className="w-24 bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-zinc-200 text-right text-sm"
          />
        ) : (
          <span className="text-zinc-300">{formatMoney(entry.effective_bonus_cents)}</span>
        )}
      </td>
      <td className="py-2 px-3 text-amber-400 text-sm text-right font-medium">
        {formatMoney(entry.effective_total_compensation_cents)}
      </td>
      {editable && (
        <td className="py-2 px-3">
          <div className="flex gap-2 items-center">
            <input
              type="text"
              value={adjNotes}
              onChange={(e) => setAdjNotes(e.target.value)}
              placeholder="Notes…"
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-zinc-300 text-xs"
            />
            <button
              onClick={save}
              disabled={saving}
              className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40 px-2"
            >
              {saving ? "…" : "Save"}
            </button>
          </div>
        </td>
      )}
    </tr>
  );
}
```

- [ ] **Step 3: Write `app/components/payroll/GustoSummaryPanel.tsx`**

```tsx
import type { PayrollEntryMerged, Employee } from "@/lib/payroll/types";

interface Props {
  entries: PayrollEntryMerged[];
  employees: Employee[];
  salariedEmployees: Employee[];
}

function formatMoney(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function GustoSummaryPanel({ entries, employees, salariedEmployees }: Props) {
  const empMap = new Map(employees.map((e) => [e.id, e]));

  return (
    <div className="mt-8">
      <h3 className="text-sm font-semibold text-zinc-300 mb-3">Gusto Summary</h3>
      <p className="text-xs text-zinc-500 mb-4">
        Copy these values into Gusto when running payroll. Salaried employees require no manual entry.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-700">
            <th className="text-left py-2 px-3 text-zinc-500 font-medium">Employee</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Hours</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Paycheck Tips</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Cash Tips</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Bonus</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Commissions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const emp = empMap.get(entry.employee_id);
            return (
              <tr key={entry.employee_id} className="border-b border-zinc-800">
                <td className="py-2 px-3 text-zinc-200">
                  {emp ? `${emp.first_name} ${emp.last_name}` : entry.employee_id}
                </td>
                <td className="py-2 px-3 text-right text-zinc-300">
                  {entry.effective_hours.toFixed(2)}
                </td>
                <td className="py-2 px-3 text-right text-zinc-300">
                  {formatMoney(entry.effective_paycheck_tips_cents)}
                </td>
                <td className="py-2 px-3 text-right text-zinc-300">
                  {formatMoney(entry.effective_cash_tips_cents)}
                </td>
                <td className="py-2 px-3 text-right text-zinc-300">
                  {formatMoney(entry.effective_bonus_cents)}
                </td>
                <td className="py-2 px-3 text-right text-zinc-400">$0.00</td>
              </tr>
            );
          })}
          {salariedEmployees.map((emp) => (
            <tr key={emp.id} className="border-b border-zinc-800 opacity-50">
              <td className="py-2 px-3 text-zinc-400">
                {emp.first_name} {emp.last_name}{" "}
                <span className="text-zinc-600 text-xs">({emp.job_title})</span>
              </td>
              <td colSpan={5} className="py-2 px-3 text-center text-zinc-600 text-xs">
                Salaried — no entry required
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Write `app/components/payroll/SalariedConfirmationList.tsx`**

```tsx
import type { Employee } from "@/lib/payroll/types";

export function SalariedConfirmationList({ employees }: { employees: Employee[] }) {
  if (employees.length === 0) return null;
  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold text-zinc-400 mb-2">Salaried Employees</h3>
      <ul className="space-y-1">
        {employees.map((emp) => (
          <li key={emp.id} className="flex items-center gap-3 text-sm text-zinc-400">
            <span className="w-4 h-4 rounded border border-zinc-600 flex-shrink-0" />
            <span>{emp.first_name} {emp.last_name}</span>
            <span className="text-zinc-600">{emp.job_title} · {emp.employment_type.replace(/_/g, " ")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 5: Write `app/components/payroll/PayrollPeriodView.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePayrollPeriod } from "@/lib/hooks/usePayrollPeriod";
import { PayrollEntryRow } from "./PayrollEntryRow";
import { GustoSummaryPanel } from "./GustoSummaryPanel";
import { SalariedConfirmationList } from "./SalariedConfirmationList";
import { queryKeys } from "@/lib/query-keys";

interface Props {
  periodId: string;
  editable: boolean;
  showSalaried: boolean;
  showGustoSummary: boolean;
}

export function PayrollPeriodView({ periodId, editable, showSalaried, showGustoSummary }: Props) {
  const { data: preview, isLoading, error } = usePayrollPeriod(periodId);
  const qc = useQueryClient();
  const [locking, setLocking] = useState(false);
  const [showLockConfirm, setShowLockConfirm] = useState(false);

  if (isLoading) return <p className="text-zinc-500 text-sm p-6">Loading payroll data…</p>;
  if (error) return <p className="text-red-400 text-sm p-6">{error.message}</p>;
  if (!preview) return null;

  const { period, entries, salaried_employees } = preview;
  const allEmployees = [...entries.map(e => ({ id: e.employee_id, first_name: "", last_name: "" }))];

  // Build employee lookup from preview — we need the full Employee objects
  // The preview returns entries; we fetch employees separately in the page component
  // and pass them down. For now PayrollPeriodView uses entry.employee_id;
  // PayrollEntryRow receives the full Employee from the page.

  async function handleLock() {
    setLocking(true);
    const res = await fetch(`/api/payroll/periods/${periodId}/lock`, { method: "POST" });
    if (!res.ok) {
      const { error: e } = await res.json();
      alert(`Lock failed: ${e}`);
      setLocking(false);
      return;
    }
    await qc.invalidateQueries({ queryKey: queryKeys.payroll.all() });
    setLocking(false);
    setShowLockConfirm(false);
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <span className="text-zinc-300 text-sm font-medium">
            {period.start_date} – {period.end_date}
          </span>
          <span className={`ml-3 text-xs px-2 py-0.5 rounded-full ${
            period.status === "locked"
              ? "bg-zinc-700 text-zinc-400"
              : "bg-amber-900/30 text-amber-400"
          }`}>
            {period.status === "locked" ? "Locked" : "Open"}
          </span>
        </div>
        {editable && period.status === "open" && (
          <button
            onClick={() => setShowLockConfirm(true)}
            className="text-sm px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors"
          >
            Lock Period
          </button>
        )}
      </div>

      {/* Lock confirmation modal */}
      {showLockConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-zinc-100 font-semibold mb-2">Lock this pay period?</h2>
            <p className="text-zinc-400 text-sm mb-4">
              Final values will be snapshotted and the period cannot be edited after locking.
            </p>
            <table className="w-full text-xs text-zinc-300 mb-4">
              <thead>
                <tr className="border-b border-zinc-700">
                  <th className="text-left py-1">Employee</th>
                  <th className="text-right py-1">Hours</th>
                  <th className="text-right py-1">Tips</th>
                  <th className="text-right py-1">Bonus</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.employee_id}>
                    <td className="py-1">{e.employee_id.slice(0, 8)}…</td>
                    <td className="text-right py-1">{e.effective_hours.toFixed(1)}h</td>
                    <td className="text-right py-1">${((e.effective_paycheck_tips_cents + e.effective_cash_tips_cents) / 100).toFixed(2)}</td>
                    <td className="text-right py-1">${(e.effective_bonus_cents / 100).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowLockConfirm(false)} className="text-sm text-zinc-400 hover:text-zinc-200">
                Cancel
              </button>
              <button
                onClick={handleLock}
                disabled={locking}
                className="text-sm px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded disabled:opacity-40"
              >
                {locking ? "Locking…" : "Confirm Lock"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bartender table */}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-700">
            <th className="text-left py-2 px-3 text-zinc-500 font-medium">Bartender</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Hours</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Paycheck Tips</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Cash Tips</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Bonus</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Total</th>
            {editable && <th className="py-2 px-3 text-zinc-500 font-medium">Adjustment</th>}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <PayrollEntryRow
              key={entry.employee_id}
              entry={entry}
              employee={{ id: entry.employee_id } as never}
              periodId={periodId}
              editable={editable && period.status === "open"}
            />
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={6} className="py-6 text-center text-zinc-600 text-sm">
                No hourly tip-eligible employees found for this period.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {showSalaried && <SalariedConfirmationList employees={salaried_employees} />}
      {showGustoSummary && (
        <GustoSummaryPanel
          entries={entries}
          employees={[]}
          salariedEmployees={salaried_employees}
        />
      )}
    </div>
  );
}
```

> **Note:** `PayrollEntryRow` receives a stripped employee object here because the full `Employee[]` is available in `preview.entries` only by ID. In Task 9 and 10, the page components will pass the full employee map. Wire this properly by adding an `employees: Employee[]` prop to `PayrollPeriodView` and passing it down to `PayrollEntryRow` and `GustoSummaryPanel`. Update the `PayrollPreview` response to include the full employee list in `entries` or as a separate map.

- [ ] **Step 6: Fix employee data wiring — update `PayrollPeriodView` to accept employees**

Add `employees: Employee[]` prop and thread it through. Update the lock modal to show employee names. Update `PayrollEntryRow` and `GustoSummaryPanel` calls to pass the correct employee objects using `employees.find(e => e.id === entry.employee_id)`.

The `buildPayrollPreview` already returns the full employee list. Update the API response to include `employees` (the hourly tipped ones) alongside `entries`:

In `lib/payroll/previewService.ts`, add `employees: hourlyTipped` to the returned `PayrollPreview` object, and add `employees: Employee[]` to the `PayrollPreview` type in `lib/payroll/types.ts`.

- [ ] **Step 7: Verify build**

```bash
npm run build 2>&1 | grep "error TS" | head -20
```

Expected: no type errors.

- [ ] **Step 8: Commit**

```bash
git add app/components/payroll/ lib/payroll/types.ts lib/payroll/previewService.ts
git commit -m "feat(payroll): add shared PayrollPeriodView and sub-components"
```

---

## Task 9: Taproom Payroll UI & Navigation

**Files:**
- Modify: `app/taproom/nav-config.ts`
- Modify: `app/components/NavBar.tsx`
- Create: `app/taproom/payroll/layout.tsx`
- Create: `app/taproom/payroll/page.tsx`
- Create: `app/taproom/payroll/[periodId]/page.tsx`

**Interfaces:**
- Consumes: `PayrollPeriodView`, `PeriodSelector`, `usePayrollPeriod` hook, `useUserRole` hook

- [ ] **Step 1: Update `app/taproom/nav-config.ts`**

Add `managerOnly` to the `NavEntry` type and add the Payroll entry:

```typescript
export type NavEntry = { href: string; match?: string; label: string; adminOnly?: boolean; managerOnly?: boolean };

export const TAPROOM_NAV: NavEntry[] = [
  { href: "/taproom/performance", label: "Performance" },
  { href: "/taproom/targets",     label: "Targets"     },
  { href: "/taproom/payroll",     label: "Payroll",     managerOnly: true },
  { href: "/taproom/reports",     label: "Reports",     adminOnly: true },
];

// ... PERFORMANCE_NAV and TARGETS_NAV unchanged
```

- [ ] **Step 2: Update `app/components/NavBar.tsx` to handle `managerOnly`**

Find the line:
```tsx
{TAPROOM_NAV.filter((e) => !e.adminOnly || isAdmin).map(({ href, label }) => (
```

Replace with:
```tsx
{TAPROOM_NAV.filter((e) => {
  if (e.adminOnly && !isAdmin) return false;
  if (e.managerOnly && role !== "manager" && !isAdmin) return false;
  return true;
}).map(({ href, label }) => (
```

- [ ] **Step 3: Write `app/taproom/payroll/layout.tsx`**

```tsx
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";

export default async function TaproomPayrollLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session || (session.role !== "manager" && session.role !== "admin")) {
    redirect("/taproom/performance");
  }
  return <>{children}</>;
}
```

- [ ] **Step 4: Write `app/taproom/payroll/page.tsx`**

```tsx
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function TaproomPayrollRoot() {
  const supabase = await createSupabaseServerClient();

  // Find the current open period, or most recent period
  const { data } = await supabase
    .from("pay_periods")
    .select("id, status")
    .order("start_date", { ascending: false })
    .limit(5);

  const openPeriod = data?.find((p) => p.status === "open");
  const target = openPeriod ?? data?.[0];

  if (target) redirect(`/taproom/payroll/${target.id}`);

  // No periods yet
  return (
    <main className="px-4 sm:px-6 py-8">
      <p className="text-zinc-500 text-sm">No pay periods found. An admin needs to create the first period.</p>
    </main>
  );
}
```

- [ ] **Step 5: Write `app/taproom/payroll/[periodId]/page.tsx`**

```tsx
"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import SubNav from "@/app/components/SubNav";
import { TAPROOM_NAV } from "@/app/taproom/nav-config";
import { PayrollPeriodView } from "@/app/components/payroll/PayrollPeriodView";
import { PeriodSelector } from "@/app/components/payroll/PeriodSelector";
import { useUserRole } from "@/lib/hooks/useUserRole";
import { queryKeys } from "@/lib/query-keys";
import type { PayPeriod } from "@/lib/payroll/types";

export default function TaproomPayrollPage() {
  const { periodId } = useParams<{ periodId: string }>();
  const { role } = useUserRole();
  const isAdmin = role === "admin";

  const { data: periods } = useQuery<PayPeriod[]>({
    queryKey: queryKeys.payroll.periods(),
    queryFn: () => fetch("/api/payroll/periods").then((r) => r.json()),
  });

  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={TAPROOM_NAV} mobile />
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-zinc-100 font-semibold text-lg">Payroll</h1>
        {periods && (
          <PeriodSelector
            periods={periods}
            currentId={periodId}
            basePath="/taproom/payroll"
          />
        )}
      </div>
      <PayrollPeriodView
        periodId={periodId}
        editable={isAdmin}
        showSalaried={false}
        showGustoSummary={false}
      />
    </main>
  );
}
```

- [ ] **Step 6: Verify navigation renders Payroll for manager role**

Start dev server (`npm run dev`), log in as a manager, confirm "Payroll" appears in Taproom sub-nav. Confirm it does NOT appear for brewer or viewer roles.

- [ ] **Step 7: Commit**

```bash
git add app/taproom/nav-config.ts app/components/NavBar.tsx app/taproom/payroll/
git commit -m "feat(payroll): add Taproom payroll UI and manager-gated nav entry"
```

---

## Task 10: Finance Payroll UI & Settings

**Files:**
- Create: `app/finance/payroll/PayrollNav.tsx`
- Create: `app/finance/payroll/page.tsx`
- Create: `app/finance/payroll/[periodId]/page.tsx`
- Create: `app/finance/payroll/settings/page.tsx`

**Interfaces:**
- Consumes: `PayrollPeriodView`, `PeriodSelector`, Finance layout (existing admin guard), `useUserRole`, React Query

- [ ] **Step 1: Write `app/finance/payroll/PayrollNav.tsx`**

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const PAYROLL_NAV = [
  { href: "/finance/payroll",          label: "Periods"  },
  { href: "/finance/payroll/settings", label: "Settings" },
];

export function PayrollNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 mb-6">
      {PAYROLL_NAV.map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
            pathname.startsWith(href) && (href !== "/finance/payroll" || pathname === "/finance/payroll" || pathname.startsWith("/finance/payroll/") && !pathname.startsWith("/finance/payroll/settings"))
              ? "text-amber-400 bg-amber-900/20"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40"
          }`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: Write `app/finance/payroll/page.tsx`**

```tsx
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { PayrollNav } from "./PayrollNav";
import { queryKeys } from "@/lib/query-keys";
import type { PayPeriod } from "@/lib/payroll/types";

export default function FinancePayrollPage() {
  const qc = useQueryClient();
  const { data: periods, isLoading } = useQuery<PayPeriod[]>({
    queryKey: queryKeys.payroll.periods(),
    queryFn: () => fetch("/api/payroll/periods").then((r) => r.json()),
  });

  const createPeriod = useMutation({
    mutationFn: () =>
      fetch("/api/payroll/periods", { method: "POST" }).then((r) => {
        if (!r.ok) return r.json().then((d) => Promise.reject(d.error));
        return r.json();
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.payroll.periods() }),
  });

  return (
    <main className="px-4 sm:px-6 py-8">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-zinc-100 font-semibold text-lg">Payroll</h1>
        <button
          onClick={() => createPeriod.mutate()}
          disabled={createPeriod.isPending}
          className="text-sm px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors disabled:opacity-40"
        >
          {createPeriod.isPending ? "Creating…" : "+ New Period"}
        </button>
      </div>
      <PayrollNav />
      {createPeriod.isError && (
        <p className="text-red-400 text-sm mb-4">{String(createPeriod.error)}</p>
      )}
      {isLoading ? (
        <p className="text-zinc-500 text-sm">Loading…</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-700">
              <th className="text-left py-2 px-3 text-zinc-500">Period</th>
              <th className="text-left py-2 px-3 text-zinc-500">Status</th>
            </tr>
          </thead>
          <tbody>
            {(periods ?? []).map((p) => (
              <tr key={p.id} className="border-b border-zinc-800 hover:bg-zinc-800/30">
                <td className="py-2 px-3">
                  <Link href={`/finance/payroll/${p.id}`} className="text-zinc-200 hover:text-amber-400">
                    {p.start_date} – {p.end_date}
                  </Link>
                </td>
                <td className="py-2 px-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    p.status === "locked"
                      ? "bg-zinc-700 text-zinc-400"
                      : "bg-amber-900/30 text-amber-400"
                  }`}>
                    {p.status === "locked" ? "Locked" : "Open"}
                  </span>
                </td>
              </tr>
            ))}
            {(periods ?? []).length === 0 && (
              <tr>
                <td colSpan={2} className="py-6 text-center text-zinc-600">
                  No pay periods yet. Click "+ New Period" to create the first one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </main>
  );
}
```

- [ ] **Step 3: Write `app/finance/payroll/[periodId]/page.tsx`**

```tsx
"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { PayrollNav } from "../PayrollNav";
import { PayrollPeriodView } from "@/app/components/payroll/PayrollPeriodView";
import { PeriodSelector } from "@/app/components/payroll/PeriodSelector";
import { queryKeys } from "@/lib/query-keys";
import type { PayPeriod } from "@/lib/payroll/types";

export default function FinancePayrollPeriodPage() {
  const { periodId } = useParams<{ periodId: string }>();

  const { data: periods } = useQuery<PayPeriod[]>({
    queryKey: queryKeys.payroll.periods(),
    queryFn: () => fetch("/api/payroll/periods").then((r) => r.json()),
  });

  return (
    <main className="px-4 sm:px-6 py-8">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-zinc-100 font-semibold text-lg">Payroll</h1>
        {periods && (
          <PeriodSelector
            periods={periods}
            currentId={periodId}
            basePath="/finance/payroll"
          />
        )}
      </div>
      <PayrollNav />
      <PayrollPeriodView
        periodId={periodId}
        editable={true}
        showSalaried={true}
        showGustoSummary={true}
      />
    </main>
  );
}
```

- [ ] **Step 4: Write `app/finance/payroll/settings/page.tsx`**

```tsx
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { PayrollNav } from "../PayrollNav";
import { queryKeys } from "@/lib/query-keys";
import type { Employee, PayrollConfig } from "@/lib/payroll/types";

function formatDollars(cents: number) {
  return (cents / 100).toFixed(2);
}

export default function PayrollSettingsPage() {
  const qc = useQueryClient();

  const { data: config } = useQuery<PayrollConfig>({
    queryKey: queryKeys.payroll.config(),
    queryFn: () => fetch("/api/payroll/config").then((r) => r.json()),
  });

  const { data: employees } = useQuery<Employee[]>({
    queryKey: queryKeys.payroll.employees(),
    queryFn: () => fetch("/api/payroll/employees").then((r) => r.json()),
  });

  const [baseRate, setBaseRate] = useState("");
  const [guaranteedRate, setGuaranteedRate] = useState("");
  const [cashTipsRate, setCashTipsRate] = useState("");

  useEffect(() => {
    if (config) {
      setBaseRate(formatDollars(config.base_rate_cents));
      setGuaranteedRate(formatDollars(config.guaranteed_rate_cents));
      setCashTipsRate(String(config.cash_tips_rate));
    }
  }, [config]);

  const saveConfig = useMutation({
    mutationFn: () =>
      fetch("/api/payroll/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          effective_from: new Date().toISOString().slice(0, 10),
          base_rate_cents: Math.round(parseFloat(baseRate) * 100),
          guaranteed_rate_cents: Math.round(parseFloat(guaranteedRate) * 100),
          cash_tips_rate: parseFloat(cashTipsRate),
          first_pay_period_start_date: config?.first_pay_period_start_date ?? new Date().toISOString().slice(0, 10),
        }),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.payroll.config() }),
  });

  const toggleEmployee = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      fetch(`/api/payroll/employees/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.payroll.employees() }),
  });

  const baseRateCents = Math.round(parseFloat(baseRate || "0") * 100);
  const guaranteedRateCents = Math.round(parseFloat(guaranteedRate || "0") * 100);
  const cashRate = parseFloat(cashTipsRate || "0");

  return (
    <main className="px-4 sm:px-6 py-8 max-w-3xl">
      <h1 className="text-zinc-100 font-semibold text-lg mb-4">Payroll</h1>
      <PayrollNav />

      {/* Rate Configuration */}
      <section className="mb-10">
        <h2 className="text-zinc-300 font-medium text-sm mb-4">Rate Configuration</h2>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <label className="block">
            <span className="text-zinc-500 text-xs">Base Rate ($/hr)</span>
            <input
              type="number" step="0.01" min="0"
              value={baseRate}
              onChange={(e) => setBaseRate(e.target.value)}
              className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-zinc-200 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-zinc-500 text-xs">Guaranteed Rate ($/hr)</span>
            <input
              type="number" step="0.01" min="0"
              value={guaranteedRate}
              onChange={(e) => setGuaranteedRate(e.target.value)}
              className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-zinc-200 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-zinc-500 text-xs">Cash Tips Rate (e.g. 0.01)</span>
            <input
              type="number" step="0.001" min="0" max="1"
              value={cashTipsRate}
              onChange={(e) => setCashTipsRate(e.target.value)}
              className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-zinc-200 text-sm"
            />
          </label>
        </div>
        <button
          onClick={() => saveConfig.mutate()}
          disabled={saveConfig.isPending}
          className="text-sm px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded disabled:opacity-40"
        >
          {saveConfig.isPending ? "Saving…" : "Save New Config Version"}
        </button>
      </section>

      {/* Calculation Reference */}
      <section className="mb-10">
        <h2 className="text-zinc-300 font-medium text-sm mb-3">Calculation Reference</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 text-xs text-zinc-400 space-y-2 font-mono">
          <p><span className="text-zinc-200">hour_share</span> = employee_hours / total_tipped_hours</p>
          <p><span className="text-zinc-200">paycheck_tips</span> = hour_share × total_pooled_tips <span className="text-zinc-600">(from Square)</span></p>
          <p><span className="text-zinc-200">cash_tips</span> = hour_share × <span className="text-amber-400">{cashTipsRate || "0.01"}</span> × total_cash_take</p>
          <p><span className="text-zinc-200">base_pay</span> = hours × <span className="text-amber-400">${baseRate || "?"}/hr</span></p>
          <p><span className="text-zinc-200">guaranteed_min</span> = hours × <span className="text-amber-400">${guaranteedRate || "?"}/hr</span></p>
          <p><span className="text-zinc-200">bonus</span> = max(0, guaranteed_min − base_pay − paycheck_tips − cash_tips)</p>
        </div>
        <p className="text-xs text-zinc-600 mt-2">
          Tip distribution model: <span className="text-zinc-400">Proportional Hours</span> — tips are split pro-rata by hours worked, matching Square&apos;s native pooling behaviour.
        </p>
      </section>

      {/* Employee Management */}
      <section>
        <h2 className="text-zinc-300 font-medium text-sm mb-3">Employees</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-700">
              <th className="text-left py-2 px-3 text-zinc-500">Name</th>
              <th className="text-left py-2 px-3 text-zinc-500">Title</th>
              <th className="text-left py-2 px-3 text-zinc-500">Type</th>
              <th className="text-left py-2 px-3 text-zinc-500">Tips</th>
              <th className="text-left py-2 px-3 text-zinc-500">Square ID</th>
              <th className="py-2 px-3 text-zinc-500">Active</th>
            </tr>
          </thead>
          <tbody>
            {(employees ?? []).map((emp) => (
              <tr key={emp.id} className="border-b border-zinc-800">
                <td className="py-2 px-3 text-zinc-200">{emp.first_name} {emp.last_name}</td>
                <td className="py-2 px-3 text-zinc-400 text-xs">{emp.job_title}</td>
                <td className="py-2 px-3 text-zinc-400 text-xs">{emp.employment_type.replace(/_/g, " ")}</td>
                <td className="py-2 px-3 text-zinc-400 text-xs">{emp.receives_tips ? "Yes" : "No"}</td>
                <td className="py-2 px-3 text-zinc-600 text-xs font-mono">
                  {emp.square_team_member_id?.slice(0, 12) ?? "—"}
                </td>
                <td className="py-2 px-3 text-center">
                  <button
                    onClick={() => toggleEmployee.mutate({ id: emp.id, active: !emp.active })}
                    className={`text-xs px-2 py-0.5 rounded ${
                      emp.active
                        ? "bg-green-900/30 text-green-400 hover:bg-red-900/30 hover:text-red-400"
                        : "bg-zinc-800 text-zinc-500 hover:bg-green-900/30 hover:text-green-400"
                    }`}
                  >
                    {emp.active ? "Active" : "Inactive"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
```

- [ ] **Step 5: Add Payroll to Finance nav**

In `app/finance/nav-config.ts`, add the payroll entry (inspect this file and add `/finance/payroll` with label "Payroll" in the appropriate position).

- [ ] **Step 6: End-to-end verification**

```
1. Seed payroll_config via Supabase dashboard (or use PATCH /api/payroll/config)
2. Seed 2-3 employees (at least 1 hourly+receives_tips with a valid square_team_member_id)
3. Create a pay period via POST /api/payroll/periods or the Finance UI
4. Navigate to /finance/payroll/[id] — should show the payroll table
5. As admin: adjust a bonus field, save, verify it persists on refresh
6. Lock the period — verify status badge changes to "Locked" and fields become read-only
7. Navigate to /taproom/payroll as manager — verify same period is read-only, no lock button
8. Verify viewer/brewer cannot see the Payroll nav item in Taproom
```

- [ ] **Step 7: Commit**

```bash
git add app/finance/payroll/ app/finance/nav-config.ts
git commit -m "feat(payroll): add Finance payroll UI, period list, and settings page"
```

---

## Self-Review Checklist

| Spec requirement | Task(s) |
|---|---|
| DB: 4 tables (payroll_config, employees, pay_periods, payroll_entries) | Task 1 |
| Square Labor API → hours per team member | Task 2 |
| Square Payments API → tips + cash take | Task 2 |
| Pure calculation: proportional tips, cash tips, bonus | Task 3 |
| Period boundary computation | Task 3 |
| Config CRUD (admin) | Task 5 |
| Employee CRUD (admin) | Task 5 |
| Pay period list + create (admin) | Task 6 |
| Preview route — live Square + calculations + adjustments merged | Task 6 |
| Admin adjustments (PATCH entries) | Task 6 |
| Lock route — snapshot + immutability | Task 6 |
| React Query keys registered | Task 7 |
| Shared usePayrollPeriod hook | Task 7 |
| PayrollPeriodView component — props: editable, showSalaried, showGustoSummary | Task 8 |
| GustoSummaryPanel — Gusto-ready format | Task 8 |
| SalariedConfirmationList | Task 8 |
| PayrollEntryRow — inline adjustment fields for admin | Task 8 |
| Taproom Payroll — manager read-only, admin editable | Task 9 |
| Taproom nav: Payroll entry hidden from viewer/brewer | Task 9 |
| Finance Payroll — period list, period view, settings | Task 10 |
| Settings: rate config, formula reference, employee management | Task 10 |
| Config versioning: effective_from, locked periods use period-start config version | Tasks 5, 6 |
| Cash tips rate configurable | Tasks 1, 3, 10 |
| tip_distribution_model stored + shown in settings | Tasks 1, 10 |
