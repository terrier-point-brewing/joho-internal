# Production-inventory expense alerts

**Date:** 2026-07-07
**Area:** Finance → Transactions → Expenses

## Problem

Expenses coded to accounting accounts **5110** and **5120** represent purchases of
production ingredients/packaging. Whenever one is recorded, someone has to go update
the corresponding production inventory. Today there is no signal that this needs to
happen — the expense just lands in the list. We want an in-app alert so these don't
get missed.

## Goal

Show a banner inside **Finance → Transactions → Expenses** listing expenses on
account 5110/5120 that still need a production-inventory update, with a per-expense
**dismiss checkbox** to clear the alert once handled. The dismissed state is a simple
boolean persisted on the expense, so it is shared across users/devices and survives
reload.

Non-goals: external/push notifications, auto-updating inventory, tracking who handled
each expense or when (no timestamp, no `_by`).

## Behaviour

- The banner lists every expense whose resolved chart-of-accounts `account_number` is
  in the alert set (`5110`, `5120`) **and** whose `inventory_alert_dismissed` is false.
- It is a single aggregate banner: a summary line
  (*"N expense(s) on accounts 5110/5120 need a production inventory update"*) with an
  expandable details table (date · merchant · account · amount), each row carrying a
  **Dismiss** checkbox, plus a **Dismiss all** control.
- Checking an expense sets `inventory_alert_dismissed = true`, which drops it from the
  banner. When no un-dismissed expenses remain, the banner renders nothing.
- Applies to any expense `source` (ramp / square / manual) — detection keys off the
  chart-of-accounts account, not the source. Today only Ramp writes rows; Square and
  manual are future-ready with no extra work.
- Applies to credits/refunds on those accounts too (a reversal is still an inventory
  event); no amount-sign filtering.

## Components

### 1. `lib/finance/inventoryAlerts.ts` (new — pure logic + constants)

Single source of truth for the alert accounts and the selection rule.

```ts
export const PRODUCTION_INVENTORY_ACCOUNT_NUMBERS = ["5110", "5120"] as const;

// Minimal shape the selector needs — a subset of the expense row the GET route returns.
export interface InventoryAlertExpense {
  id: string;
  inventory_alert_dismissed: boolean;
  chart_of_accounts: { account_number: string | null } | null;
  // ...plus display fields carried through (merchant_name, amount_cents, accounting_date, account_name)
}

export function isProductionInventoryAccount(accountNumber: string | null | undefined): boolean;

// Filter to un-dismissed expenses on the alert accounts, newest first (by accounting_date).
export function selectInventoryAlerts<T extends InventoryAlertExpense>(expenses: T[]): T[];
```

Adding a third alert account is one array entry. Co-located `inventoryAlerts.test.ts`
covers: account in/out of the set, `inventory_alert_dismissed` true vs false, null
`chart_of_accounts`, ordering, and empty input.

### 2. Migration — `supabase/migrations/<timestamp>_expenses_inventory_alert_dismissed.sql`

Add one boolean column to `public.expenses`:

```sql
alter table public.expenses
  add column inventory_alert_dismissed boolean not null default false;
```

`true` = dismissed/handled. No timestamp, no `_by`, no new table. Safe under the
existing Ramp upsert: `syncRampExpenses` never includes this column in its payload, so
re-syncs leave it untouched (and new rows get the `false` default).

New migration file only — do not edit existing migrations.

### 3. API — `app/api/finance/expenses/route.ts` (extend existing route)

- **GET**: add `inventory_alert_dismissed` to the explicit `.select(...)` column list so
  the client receives it. (The route lists columns explicitly, so this is required — it
  does not flow through automatically.)
- **PATCH**: accept an optional `inventory_alert_dismissed: boolean` on the request body.
  When present, branch early and perform only that update (set the column to the given
  value; `false` undoes a dismissal), returning `{ id, inventory_alert_dismissed }`. This
  branch is independent of the existing CoA-pin logic so the two concerns don't tangle.
  Auth is unchanged (`requireRole([])`, any authenticated user — at least as permissive as
  the viewer-gated Expenses tab).

Reuses the existing per-expense PATCH route rather than adding a new endpoint.

### 4. UI — `app/finance/transactions/expenses/InventoryAlertBanner.tsx` (new)

- `"use client"` component. Props: the flagged expenses (from `selectInventoryAlerts`)
  and an `onDismiss(id: string)` callback.
- Returns `null` when the list is empty.
- Container is the shared `<Banner>` primitive with an informational tone (not a
  hand-rolled div), following the UI standard. Inside: the summary line, a collapsible
  **Details** toggle (as in `UnrecognizedBanner`), and a table of rows
  (checkbox · date · merchant · account · amount) — each row's checkbox dismisses that
  expense — plus a **Dismiss all** control.
- Amount/date formatting reuses existing finance helpers; no raw colors, no one-off
  primitives.

### 5. Wiring — `app/finance/transactions/expenses/page.tsx`

- Extend the local `ExpenseRow` type with `inventory_alert_dismissed: boolean`.
- Compute `selectInventoryAlerts(expenses)` from the already-loaded `expenses` state —
  no new fetch.
- Render `<InventoryAlertBanner>` near the existing error `Banner` (around the
  `SummaryStatBar` / error banner block).
- `onDismiss(id)`: `PATCH /api/finance/expenses` with
  `{ id, inventory_alert_dismissed: true }`, then set that row's
  `inventory_alert_dismissed` in local `expenses` state so it drops out of the banner (no
  full reload needed).

## Data flow

```
syncRampExpenses (existing) ──▶ public.expenses (+ inventory_alert_dismissed=false)
                                          │
            GET /api/finance/expenses (now selects inventory_alert_dismissed)
                                          │
                       page.tsx `expenses` state
                                          │
                    selectInventoryAlerts(expenses)  ── pure ──
                                          │
                         <InventoryAlertBanner>
                                          │  Dismiss checkbox
                PATCH { id, inventory_alert_dismissed:true }
                                          │
          expenses.inventory_alert_dismissed = true  ──▶ row leaves banner
```

## Testing

- `lib/finance/inventoryAlerts.test.ts` — unit tests for `selectInventoryAlerts` /
  `isProductionInventoryAccount` (the lib-coverage rule).
- Manual verification in the running app: an expense on 5110/5120 shows in the banner;
  checking its **Dismiss** box removes it; reload keeps it removed; an expense on another
  account never appears.

## Files touched

| File | Change |
|------|--------|
| `lib/finance/inventoryAlerts.ts` | new — accounts constant + `selectInventoryAlerts` |
| `lib/finance/inventoryAlerts.test.ts` | new — unit tests |
| `supabase/migrations/<ts>_expenses_inventory_alert_dismissed.sql` | new — add column |
| `app/api/finance/expenses/route.ts` | GET select + PATCH branch |
| `app/finance/transactions/expenses/InventoryAlertBanner.tsx` | new — banner UI |
| `app/finance/transactions/expenses/page.tsx` | type + wiring + render |
