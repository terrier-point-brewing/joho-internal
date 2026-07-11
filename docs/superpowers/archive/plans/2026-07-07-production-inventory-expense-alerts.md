# Production-inventory expense alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a banner in Finance → Transactions → Expenses listing expenses coded to accounts 5110/5120 (production ingredients/packaging) that still need an inventory update, each with a Dismiss checkbox backed by a persisted boolean.

**Architecture:** A pure lib module owns the alert-account constants and the selection filter. A single nullable-default boolean column on `public.expenses` records dismissal. The existing expenses GET/PATCH route is extended (select the column; a new dismiss branch). A new client banner component renders off already-loaded page state — no new fetch, no new query key.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, Supabase Postgres, Vitest.

**Design spec:** `docs/superpowers/specs/2026-07-07-production-inventory-expense-alerts-design.md`

## Global Constraints

- Account codes live only in `lib/finance/inventoryAlerts.ts` as `PRODUCTION_INVENTORY_ACCOUNT_NUMBERS = ["5110", "5120"]` — never hard-code `"5110"`/`"5120"` elsewhere.
- No raw color utilities — use token utilities / the `<Banner tone>` primitive per `docs/UI_STANDARD.md`. No hand-rolled banner div; use `<Banner>`.
- New/modified `lib/` modules ship co-located `*.test.ts`; `npm run test` must stay green and not drop below the `vitest.config.ts` coverage floor.
- New migration file only — never edit an existing migration. Column is additive, `not null default false` (historical rows read as not-dismissed).
- **Migration application to the live Supabase project (`drlsazatrcrdwaihjmex`) is a user-authorized step** — do not apply it autonomously. Tasks 3–5 can only be verified end-to-end after the column exists in that project.

---

### Task 1: Alert-account constants + selection logic (pure lib)

**Files:**
- Create: `lib/finance/inventoryAlerts.ts`
- Test: `lib/finance/inventoryAlerts.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `PRODUCTION_INVENTORY_ACCOUNT_NUMBERS: readonly ["5110", "5120"]`
  - `isProductionInventoryAccount(accountNumber: string | null | undefined): boolean`
  - `interface InventoryAlertExpense { id: string; inventory_alert_dismissed: boolean; accounting_date: string | null; chart_of_accounts: { account_number: string | null } | null }`
  - `selectInventoryAlerts<T extends InventoryAlertExpense>(expenses: T[]): T[]` — un-dismissed expenses on an alert account, sorted by `accounting_date` desc (nulls last).

- [ ] **Step 1: Write the failing test**

Create `lib/finance/inventoryAlerts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  PRODUCTION_INVENTORY_ACCOUNT_NUMBERS,
  isProductionInventoryAccount,
  selectInventoryAlerts,
  type InventoryAlertExpense,
} from "./inventoryAlerts";

describe("PRODUCTION_INVENTORY_ACCOUNT_NUMBERS", () => {
  it("is exactly 5110 and 5120", () => {
    expect([...PRODUCTION_INVENTORY_ACCOUNT_NUMBERS]).toEqual(["5110", "5120"]);
  });
});

describe("isProductionInventoryAccount", () => {
  it("matches alert accounts, trimming whitespace", () => {
    expect(isProductionInventoryAccount("5110")).toBe(true);
    expect(isProductionInventoryAccount(" 5120 ")).toBe(true);
  });
  it("rejects non-alert / missing accounts", () => {
    expect(isProductionInventoryAccount("6000")).toBe(false);
    expect(isProductionInventoryAccount(null)).toBe(false);
    expect(isProductionInventoryAccount(undefined)).toBe(false);
  });
});

describe("selectInventoryAlerts", () => {
  const row = (over: Partial<InventoryAlertExpense>): InventoryAlertExpense => ({
    id: "x",
    inventory_alert_dismissed: false,
    accounting_date: "2026-07-01",
    chart_of_accounts: { account_number: "5110" },
    ...over,
  });

  it("keeps un-dismissed expenses on alert accounts", () => {
    const out = selectInventoryAlerts([row({ id: "a" })]);
    expect(out.map((e) => e.id)).toEqual(["a"]);
  });

  it("drops dismissed expenses", () => {
    expect(selectInventoryAlerts([row({ id: "a", inventory_alert_dismissed: true })])).toEqual([]);
  });

  it("drops expenses on non-alert accounts", () => {
    expect(selectInventoryAlerts([row({ chart_of_accounts: { account_number: "6000" } })])).toEqual([]);
  });

  it("drops expenses with no chart_of_accounts", () => {
    expect(selectInventoryAlerts([row({ chart_of_accounts: null })])).toEqual([]);
  });

  it("sorts by accounting_date descending, nulls last", () => {
    const out = selectInventoryAlerts([
      row({ id: "old", accounting_date: "2026-01-01" }),
      row({ id: "nul", accounting_date: null }),
      row({ id: "new", accounting_date: "2026-07-01" }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["new", "old", "nul"]);
  });

  it("returns empty for empty input", () => {
    expect(selectInventoryAlerts([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- inventoryAlerts`
Expected: FAIL — cannot find module `./inventoryAlerts`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/finance/inventoryAlerts.ts`:

```ts
/**
 * Production-inventory expense alerts.
 *
 * Expenses coded to these chart-of-accounts numbers are purchases of production
 * ingredients/packaging, which require a matching production-inventory update. The
 * Expenses tab surfaces un-dismissed ones in a banner. This module is the single
 * source of truth for which accounts trigger the alert — add a third by appending
 * to the array below.
 */

export const PRODUCTION_INVENTORY_ACCOUNT_NUMBERS = ["5110", "5120"] as const;

const ACCOUNT_SET = new Set<string>(PRODUCTION_INVENTORY_ACCOUNT_NUMBERS);

export function isProductionInventoryAccount(
  accountNumber: string | null | undefined,
): boolean {
  return accountNumber != null && ACCOUNT_SET.has(accountNumber.trim());
}

/** Minimal shape the selector needs — a subset of the expenses GET row. */
export interface InventoryAlertExpense {
  id: string;
  inventory_alert_dismissed: boolean;
  accounting_date: string | null;
  chart_of_accounts: { account_number: string | null } | null;
}

/**
 * Un-dismissed expenses coded to a production-inventory account, newest first
 * (by accounting_date; nulls last). Pure — safe to call on every render.
 */
export function selectInventoryAlerts<T extends InventoryAlertExpense>(
  expenses: T[],
): T[] {
  return expenses
    .filter(
      (e) =>
        !e.inventory_alert_dismissed &&
        isProductionInventoryAccount(e.chart_of_accounts?.account_number),
    )
    .sort((a, b) => (b.accounting_date ?? "").localeCompare(a.accounting_date ?? ""));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- inventoryAlerts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add lib/finance/inventoryAlerts.ts lib/finance/inventoryAlerts.test.ts
git commit -m "feat(finance): production-inventory alert accounts + selection logic"
```

---

### Task 2: Migration — `inventory_alert_dismissed` column

**Files:**
- Create: `supabase/migrations/20260717_expenses_inventory_alert_dismissed.sql`

**Interfaces:**
- Consumes: existing `public.expenses` table.
- Produces: column `public.expenses.inventory_alert_dismissed boolean not null default false`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260717_expenses_inventory_alert_dismissed.sql`:

```sql
-- Production-inventory alert dismissal flag on expenses.
--
-- Expenses coded to chart-of-accounts 5110/5120 (production ingredients/packaging)
-- require a matching production-inventory update. The Expenses tab shows an alert
-- banner for these; ticking its Dismiss checkbox sets this flag so the row leaves
-- the banner. It is purely a UI acknowledgement — no bearing on P&L / mapping.
--
-- Additive and default-false — historical rows read as not-dismissed. The Ramp sync
-- upsert never includes this column, so re-syncs leave dismissals untouched. Safe to
-- re-run.

alter table public.expenses
  add column if not exists inventory_alert_dismissed boolean not null default false;
```

- [ ] **Step 2: Verify SQL parses (syntax sanity)**

Run: `grep -c "inventory_alert_dismissed" supabase/migrations/20260717_expenses_inventory_alert_dismissed.sql`
Expected: `1`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260717_expenses_inventory_alert_dismissed.sql
git commit -m "feat(finance): migration for expenses.inventory_alert_dismissed"
```

- [ ] **Step 4: Apply to Supabase (USER-AUTHORIZED — do not do autonomously)**

Applying this migration to the live project `drlsazatrcrdwaihjmex` is required before Tasks 3–5 can be verified (the GET select references the new column). This is a gated step: stop and get explicit user approval, then apply via the Supabase MCP `apply_migration` (name `expenses_inventory_alert_dismissed`, the SQL above) or the user's normal migration path. Do not proceed to verifying Task 3+ end-to-end until confirmed applied.

---

### Task 3: Extend the expenses API route (GET select + PATCH dismiss branch)

**Files:**
- Modify: `app/api/finance/expenses/route.ts`

**Interfaces:**
- Consumes: `public.expenses.inventory_alert_dismissed` (Task 2).
- Produces:
  - GET rows now include `inventory_alert_dismissed: boolean`.
  - PATCH accepts optional `inventory_alert_dismissed: boolean`; when present, updates only that column and returns `{ id, inventory_alert_dismissed }`.

- [ ] **Step 1: Add the column to the GET select**

In `app/api/finance/expenses/route.ts`, in the GET `.select(...)` string, add `inventory_alert_dismissed,` immediately after the `mapping_source,` line:

```ts
      chart_of_accounts_id,
      mapping_source,
      inventory_alert_dismissed,
      chart_of_accounts!expenses_chart_of_accounts_id_fkey ( account_name, account_number, account_type )
```

- [ ] **Step 2: Extend the PATCH body type and add the dismiss branch**

Replace the current PATCH body parsing + `const supabase = ...` (the block from `const body = await req.json()` down to the first `const supabase = createSupabaseAdminClient();`) so the client is created right after the id check and a dismiss branch runs first:

```ts
  const body = await req.json() as {
    id: string;
    chart_of_accounts_id?: string | null;
    inventory_alert_dismissed?: boolean;
  };

  if (!body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  // Dismiss / un-dismiss the production-inventory alert for this expense. A single
  // boolean toggle, independent of CoA mapping — return early so the two don't tangle.
  if (typeof body.inventory_alert_dismissed === "boolean") {
    const { data, error } = await supabase
      .from("expenses")
      .update({ inventory_alert_dismissed: body.inventory_alert_dismissed })
      .eq("id", body.id)
      .select("id, inventory_alert_dismissed")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }
```

Then delete the now-duplicate `const supabase = createSupabaseAdminClient();` that previously sat above `let coaId: ...` (the CoA logic below reuses the `supabase` created above). Leave the rest of the CoA-pin logic unchanged.

- [ ] **Step 3: Verify it compiles/lints**

Run: `npm run lint`
Expected: no new errors in `app/api/finance/expenses/route.ts`.

- [ ] **Step 4: Verify the dismiss round-trip (requires Task 2 applied)**

With the dev server running and the migration applied, exercise the branch against a real expense id:

```bash
# Replace <ID> with a real expenses.id from account 5110/5120.
curl -s -X PATCH http://localhost:3000/api/finance/expenses \
  -H 'Content-Type: application/json' \
  -d '{"id":"<ID>","inventory_alert_dismissed":true}'
```
Expected: JSON `{"id":"<ID>","inventory_alert_dismissed":true}` (or a 401/redirect if unauthenticated — in that case verify via the UI in Task 5 instead).

- [ ] **Step 5: Commit**

```bash
git add app/api/finance/expenses/route.ts
git commit -m "feat(finance): expenses API — return + toggle inventory_alert_dismissed"
```

---

### Task 4: `InventoryAlertBanner` component

**Files:**
- Create: `app/finance/transactions/expenses/InventoryAlertBanner.tsx`

**Interfaces:**
- Consumes: `PRODUCTION_INVENTORY_ACCOUNT_NUMBERS` (Task 1), `<Banner>` (`app/components/ui/Banner.tsx`), `formatCurrencyCents` (`@/lib/format`).
- Produces:
  - `interface InventoryAlertRow { id: string; accounting_date: string | null; merchant_name: string | null; amount_cents: number; chart_of_accounts: { account_name: string; account_number: string | null } | null }`
  - Default export `InventoryAlertBanner({ expenses: InventoryAlertRow[]; onDismiss: (id: string) => void })`.

- [ ] **Step 1: Write the component**

Create `app/finance/transactions/expenses/InventoryAlertBanner.tsx`:

```tsx
"use client";
import { useState } from "react";
import Banner from "@/app/components/ui/Banner";
import { formatCurrencyCents } from "@/lib/format";
import { PRODUCTION_INVENTORY_ACCOUNT_NUMBERS } from "@/lib/finance/inventoryAlerts";

export interface InventoryAlertRow {
  id: string;
  accounting_date: string | null;
  merchant_name: string | null;
  amount_cents: number;
  chart_of_accounts: { account_name: string; account_number: string | null } | null;
}

/**
 * Alerts on expenses coded to production-inventory accounts (5110/5120) that still
 * need a matching inventory update. Each row has a Dismiss checkbox; dismissing every
 * row hides the banner. Renders nothing when there is nothing to flag.
 */
export default function InventoryAlertBanner({
  expenses,
  onDismiss,
}: {
  expenses: InventoryAlertRow[];
  onDismiss: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (expenses.length === 0) return null;
  const n = expenses.length;

  return (
    <Banner tone="info" className="mx-4 sm:mx-6 my-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="font-semibold">{n}</span> expense{n === 1 ? "" : "s"} on account
          {PRODUCTION_INVENTORY_ACCOUNT_NUMBERS.length === 1 ? "" : "s"}{" "}
          {PRODUCTION_INVENTORY_ACCOUNT_NUMBERS.join(" / ")} need a production inventory update.
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => expenses.forEach((e) => onDismiss(e.id))}
            className="px-2 py-1 text-xs rounded border border-info-border hover:bg-info-surface/40 transition-colors"
          >
            Dismiss all
          </button>
          <button
            onClick={() => setOpen((o) => !o)}
            className="px-2 py-1 text-xs rounded border border-info-border hover:bg-info-surface/40 transition-colors"
          >
            {open ? "Hide" : "Details"}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3 border-t border-info-border/50 pt-2 overflow-x-auto">
          <table className="w-full text-xs text-body">
            <thead>
              <tr className="text-muted text-left">
                <th className="py-1 pr-3 font-medium w-8" scope="col"><span className="sr-only">Dismiss</span></th>
                <th className="py-1 pr-3 font-medium" scope="col">Date</th>
                <th className="py-1 pr-3 font-medium" scope="col">Merchant</th>
                <th className="py-1 pr-3 font-medium" scope="col">Account</th>
                <th className="py-1 pl-3 font-medium text-right" scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id} className="border-t border-info-border/30">
                  <td className="py-1 pr-3">
                    <input
                      type="checkbox"
                      aria-label={`Dismiss inventory alert for ${e.merchant_name ?? "expense"}`}
                      onChange={() => onDismiss(e.id)}
                    />
                  </td>
                  <td className="py-1 pr-3 whitespace-nowrap text-muted">{e.accounting_date ?? "—"}</td>
                  <td className="py-1 pr-3 max-w-[280px] truncate">{e.merchant_name ?? "—"}</td>
                  <td className="py-1 pr-3 text-muted whitespace-nowrap">
                    {e.chart_of_accounts?.account_number ?? "—"}
                    {e.chart_of_accounts?.account_name ? ` · ${e.chart_of_accounts.account_name}` : ""}
                  </td>
                  <td className="py-1 pl-3 text-right tabular-nums">{formatCurrencyCents(e.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Banner>
  );
}
```

- [ ] **Step 2: Verify it compiles/lints**

Run: `npm run lint`
Expected: no errors in `InventoryAlertBanner.tsx` (no raw-color utilities; uses `info-*` tokens + `<Banner>`).

- [ ] **Step 3: Commit**

```bash
git add app/finance/transactions/expenses/InventoryAlertBanner.tsx
git commit -m "feat(finance): InventoryAlertBanner for 5110/5120 expenses"
```

---

### Task 5: Wire the banner into the Expenses page

**Files:**
- Modify: `app/finance/transactions/expenses/page.tsx`

**Interfaces:**
- Consumes: `selectInventoryAlerts` (Task 1), `InventoryAlertBanner` (Task 4), extended GET rows (Task 3).
- Produces: the rendered banner + `handleDismissInventoryAlert` local handler.

- [ ] **Step 1: Add imports**

At the top of `app/finance/transactions/expenses/page.tsx`, after the existing `Banner` import (line 4), add:

```ts
import InventoryAlertBanner from "./InventoryAlertBanner";
import { selectInventoryAlerts } from "@/lib/finance/inventoryAlerts";
```

- [ ] **Step 2: Add the field to `ExpenseRow`**

In the `ExpenseRow` interface, add after `mapping_source: "unmapped" | "rule" | "manual";`:

```ts
  inventory_alert_dismissed: boolean;
```

- [ ] **Step 3: Add the dismiss handler**

After `handleSetExpense` (ends around line 145), add:

```ts
  // Dismiss the production-inventory alert for one expense (optimistic local update).
  async function handleDismissInventoryAlert(id: string) {
    const res = await fetch("/api/finance/expenses", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, inventory_alert_dismissed: true }),
    });
    if (!res.ok) return;
    setExpenses((es) => es.map((e) => (e.id === id ? { ...e, inventory_alert_dismissed: true } : e)));
  }
```

- [ ] **Step 4: Render the banner**

Directly below the existing error banner line
`{error && <Banner className="mx-4 sm:mx-6 my-2">{error}</Banner>}` (line 209), add:

```tsx
      <InventoryAlertBanner
        expenses={selectInventoryAlerts(expenses)}
        onDismiss={handleDismissInventoryAlert}
      />
```

`selectInventoryAlerts` returns `ExpenseRow[]`, which structurally satisfies `InventoryAlertRow[]` (id, accounting_date, merchant_name, amount_cents, chart_of_accounts with account_name/account_number are all present). No mapping needed.

- [ ] **Step 5: Verify build + lint + tests**

Run: `npm run lint && npm run test`
Expected: lint clean; all tests (incl. `inventoryAlerts`) pass.

- [ ] **Step 6: Verify in the running app (requires Task 2 applied)**

Start the dev server and open Finance → Transactions → Expenses for a year that has an expense mapped to 5110 or 5120:
- The blue info banner shows "N expense(s) on accounts 5110 / 5120 need a production inventory update."
- Click **Details** → the row(s) list date · merchant · account · amount with a checkbox.
- Tick a checkbox → that row disappears and the count drops; when the last is dismissed the banner vanishes.
- Reload the page → dismissed expenses stay gone (persisted).
- Confirm an expense on a non-5110/5120 account never appears in the banner.

Capture a screenshot of the banner (expanded) as proof.

- [ ] **Step 7: Commit**

```bash
git add app/finance/transactions/expenses/page.tsx
git commit -m "feat(finance): surface production-inventory alert banner in Expenses tab"
```

---

## Self-Review

**Spec coverage:**
- Banner in Finance → Transactions → Expenses → Task 5. ✅
- Alert on un-dismissed 5110/5120 expenses → Tasks 1 (selection) + 5 (render). ✅
- Aggregate banner + expandable details + per-row Dismiss + Dismiss all → Task 4. ✅
- Persisted boolean, no timestamp/`_by`, no new table → Task 2. ✅
- GET returns column; PATCH toggles it → Task 3. ✅
- Applies to any source; keyed on CoA account → Task 1 (`isProductionInventoryAccount`). ✅
- Includes credits/refunds (no amount-sign filter) → Task 1 filter has no amount check. ✅
- lib tests co-located → Task 1. ✅
- Reuse existing route, no new endpoint/query key, no new fetch → Tasks 3 + 5. ✅

**Placeholder scan:** No TBD/TODO; all code blocks complete. `<ID>` in Task 3 Step 4 is an explicit runtime substitution, not a plan placeholder.

**Type consistency:** `inventory_alert_dismissed: boolean`, `PRODUCTION_INVENTORY_ACCOUNT_NUMBERS`, `selectInventoryAlerts`, `InventoryAlertRow`, `handleDismissInventoryAlert` are used identically across tasks. `selectInventoryAlerts` return type (`ExpenseRow[]`) → `InventoryAlertRow[]` is structurally checked in Task 5 Step 4.
