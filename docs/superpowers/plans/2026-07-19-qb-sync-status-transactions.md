# QuickBooks Sync Status on Transactions — Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Ramp's per-object QuickBooks sync state during ingest, persist it on `expenses` + `ramp_bank_ledger`, and surface it (badge + summary stat + filter) in the Transactions Expenses and Bank Ledger tabs.

**Execution Budget:** Mode = **inline (executing-plans)** — the work is one coupled thread (three `qb_*` fields end-to-end), so inline avoids repeated cold-context rebuilds. Spawn cap = 7 (5 locality groups + 2); inline execution expects **0** spawns. Token target ≈ 150k.

**Architecture:** Ramp `sync_status` (raw, per-object-type enum) is read in `lib/ramp.ts`, threaded through `ExpenseRecord`/`BankLedgerRecord` into two tables via existing `...rec` upserts, exposed by the two GET routes, and rendered by a shared `QbSyncBadge` + a pure normalizer that maps the divergent enums to one display/filter state.

**Tech Stack:** Next.js 16 (App Router, TS), Supabase Postgres, Tailwind v4 token utilities, Vitest.

## Global Constraints

- **No raw colors in feature code** — badge classes live only in `app/finance/lib/categoryColors.ts`; use design tokens (success/info/neutral/faint). Violet is the existing "QuickBooks" category color there.
- **No hand-rolled primitives** — reuse `Badge`, `FilterSelect`, `SummaryStatBar`, `LedgerTable`/`Th`, `useTableControls`.
- **New/modified `lib/` modules ship co-located `*.test.ts`**; keep coverage above the `vitest.config.ts` floor. DoD command: `npm run verify`.
- **Naming:** the new columns are `qb_sync_status`, `qb_synced_at`, `qb_remote_id` — never reuse `synced_at` (which already means "when our app last pulled from Ramp").
- **Migrations:** new file only, `add column if not exists`, no destructive ops; don't hand-edit existing migrations.
- Spec: `docs/superpowers/specs/2026-07-19-qb-sync-status-transactions-design.md`.

---

### Task 1: Migration — `qb_*` columns

**Model:** Haiku

**Files:**
- Create: `supabase/migrations/20260805_expenses_qb_sync_status.sql`

**Interfaces:**
- Produces: columns `qb_sync_status text`, `qb_synced_at timestamptz`, `qb_remote_id text` (all nullable) on both `public.expenses` and `public.ramp_bank_ledger`; index `idx_expenses_qb_sync_status`.

**Details:**
- `alter table ... add column if not exists` ×3 for each of the two tables (6 statements).
- `create index if not exists idx_expenses_qb_sync_status on public.expenses (qb_sync_status);`
- Header comment: raw Ramp `sync_status` (enums differ per `ramp_object`); `qb_synced_at` from txn `synced_at` (null for bill/bank); `qb_remote_id` = QB object id from bills. NULL on existing rows until the next Ramp sync re-upserts them. No backfill.
- `comment on column` for each of the three `expenses` columns.

**Acceptance:** File parses as valid PL/pgSQL; idempotent (re-runnable); no `update`/`drop`/`delete`.

- [ ] Write migration file per Details.
- [ ] Commit: `feat(finance): add qb_sync_status columns to expenses + bank ledger`.

---

### Task 2: Pure normalizer + centralized badge colors

**Model:** Sonnet

**Files:**
- Create: `lib/finance/qbSyncStatus.ts`
- Create: `lib/finance/qbSyncStatus.test.ts`
- Modify: `app/finance/lib/categoryColors.ts` (append a `QB_SYNC_CLS` map)

**Interfaces:**
- Produces:
  ```ts
  export type QbSyncState = "synced" | "partial" | "ready" | "not_ready" | "unknown";
  export type RampObject = "card" | "bill" | "bank";
  export function normalizeQbSyncStatus(raw: string | null | undefined): QbSyncState;
  export function qbSyncLabel(raw: string | null | undefined, rampObject: RampObject): string;
  ```
- Consumes (Task 5): `QB_SYNC_CLS: Record<QbSyncState, string>` from `categoryColors.ts`.

**Mapping (authoritative):**
- `normalizeQbSyncStatus`: `SYNCED`|`BILL_AND_PAYMENT_SYNCED` → `"synced"`; `BILL_SYNCED` → `"partial"`; `SYNC_READY` → `"ready"`; `NOT_SYNC_READY`|`NOT_SYNCED` → `"not_ready"`; null/unrecognized → `"unknown"`. Case-sensitive match on the raw Ramp value.
- `qbSyncLabel`: `"synced"` → `"Synced"`; `BILL_SYNCED` (bill) → `"Bill only"`; `"ready"` → `"Ready"`; `"not_ready"` → `"Not synced"`; `"unknown"` → `"—"`. (Implement by normalizing, with the one bill-specific override for `BILL_SYNCED`.)
- `QB_SYNC_CLS`: `synced` → success tone (mirror `INVOICE_STATUS_CLS.paid` shape, `bg-success-surface/40 text-success`); `partial` → `bg-info-surface/40 text-info`; `ready` → `bg-surface-mid text-info`; `not_ready` → `bg-surface-mid text-muted`; `unknown` → `bg-surface-mid text-faint`.

**Test cases (`qbSyncStatus.test.ts`):**
- `normalizeQbSyncStatus` returns the right state for each of: `SYNCED`, `BILL_AND_PAYMENT_SYNCED`, `BILL_SYNCED`, `SYNC_READY`, `NOT_SYNC_READY`, `NOT_SYNCED`, `null`, `""`, `"garbage"`.
- `qbSyncLabel`: card `SYNCED`→"Synced"; bill `BILL_AND_PAYMENT_SYNCED`→"Synced"; bill `BILL_SYNCED`→"Bill only"; card `SYNC_READY`→"Ready"; card `NOT_SYNC_READY`→"Not synced"; bill `NOT_SYNCED`→"Not synced"; `null`→"—".

**Acceptance:** TDD (write test → fail → implement → pass). `npm run test -- qbSyncStatus` green. No raw colors outside `categoryColors.ts`.

- [ ] Write `qbSyncStatus.test.ts` (cases above); run → fails.
- [ ] Implement `qbSyncStatus.ts`; add `QB_SYNC_CLS` to `categoryColors.ts`; run → passes.
- [ ] Commit: `feat(finance): qb sync status normalizer + badge color map`.

---

### Task 3: Read `sync_status` from Ramp + thread through ingest

**Model:** Sonnet

**Files:**
- Modify: `lib/ramp.ts` (interfaces `RampTransaction`, `RampBill`, `RampBankLine`; readers `getRampTransactions`, `getRampBills`, `getRampBankTransactions`)
- Modify: `lib/finance/expenses.ts` (`ExpenseRecord` interface)
- Modify: `lib/finance/rampExpenses.ts` (`rampTxnToExpenseRecord`, `rampBillToExpenseRecords`)
- Modify: `lib/finance/bankLedger.ts` (`BankLedgerRecord`, `bankLineToLedgerRecord`, `bankLineToExpenseRecord`)
- Modify (tests): `lib/finance/rampExpenses.test.ts`, `lib/finance/bankLedger.test.ts` — extend existing record-shape assertions with the three new fields.

**Interfaces:**
- Consumes: nothing new.
- Produces: `ExpenseRecord` and `BankLedgerRecord` each gain `qb_sync_status: string | null`, `qb_synced_at: string | null`, `qb_remote_id: string | null`.

**Details:**
- `lib/ramp.ts`:
  - `RampTransaction` += `sync_status: string | null`, `qb_synced_at: string | null`; in `getRampTransactions` read `t.sync_status ?? null` and `t.synced_at ?? null`.
  - `RampBill` += `sync_status: string | null`, `remote_id: string | null`; read `b.sync_status ?? null`, `b.remote_id ?? null`.
  - `RampBankLine` += `sync_status: string | null`; read `t.sync_status ?? null`.
- `lib/finance/expenses.ts`: add the three fields to `ExpenseRecord` (after `counterparty_label`).
- `rampExpenses.ts`:
  - `rampTxnToExpenseRecord`: `qb_sync_status: txn.sync_status`, `qb_synced_at: txn.qb_synced_at`, `qb_remote_id: null`.
  - `rampBillToExpenseRecords`: every line item (and the no-line-item fallback) inherits `qb_sync_status: bill.sync_status`, `qb_remote_id: bill.remote_id`, `qb_synced_at: null`. Put these on the shared `base` object.
- `bankLedger.ts`: `BankLedgerRecord` += the three fields; `bankLineToLedgerRecord` sets `qb_sync_status: line.sync_status`, `qb_synced_at: null`, `qb_remote_id: null`; `bankLineToExpenseRecord` sets the same three (bank→expense path).
- Upserts in `syncExpenseRecords` / `syncBankLedger` already spread `...rec` — **no upsert changes needed**; confirm the spread carries the new fields.

**Acceptance:** `npm run verify` green. Extended tests assert the three fields are populated on a synced fixture txn/bill and null-where-expected. Typecheck passes across all four modules.

- [ ] Extend `rampExpenses.test.ts` + `bankLedger.test.ts` with field assertions; run → fails.
- [ ] Apply the `lib/ramp.ts`, `expenses.ts`, `rampExpenses.ts`, `bankLedger.ts` edits; run → passes.
- [ ] `npm run verify`; commit: `feat(finance): capture Ramp qb sync status through ingest`.

---

### Task 4: Expose columns in the two GET routes

**Model:** Haiku

**Files:**
- Modify: `app/api/finance/expenses/route.ts` (GET `select`)
- Modify: `app/api/finance/bank-ledger/route.ts` (GET `select`)

**Interfaces:**
- Consumes: the three DB columns from Task 1.
- Produces: GET responses include `qb_sync_status`, `qb_synced_at`, `qb_remote_id` per row.

**Details:** Add the three column names to each route's `.select(...)` string (in `expenses/route.ts`, alongside the existing column list before the `chart_of_accounts!...` join; in `bank-ledger/route.ts`, alongside its column list). No other logic changes — the enriched/mapped passthrough already spreads row fields.

**Acceptance:** `npm run build` + typecheck green. A manual GET (or existing route test if present) returns the three keys. If `bank-ledger/route.ts` maps rows explicitly (not a spread), add the three keys to that mapping.

- [ ] Add columns to both `select`s (and any explicit row mapping).
- [ ] `npm run verify`; commit: `feat(finance): return qb sync status from expenses + bank-ledger APIs`.

---

### Task 5: UI — badge, column, summary stat, filter

**Model:** Sonnet

**Files:**
- Create: `app/finance/transactions/components/QbSyncBadge.tsx`
- Modify: `app/finance/transactions/expenses/page.tsx`
- Modify: `app/finance/transactions/bank-ledger/page.tsx`

**Interfaces:**
- Consumes: `normalizeQbSyncStatus`, `qbSyncLabel` (Task 2); `QB_SYNC_CLS` (Task 2); the three response fields (Task 4).
- Produces: user-visible "QB Sync" column + "in QuickBooks" stat + sync filter on both tabs.

**`QbSyncBadge.tsx`:**
```tsx
export default function QbSyncBadge({ status, rampObject }: { status: string | null; rampObject: "card" | "bill" | "bank" }) {
  const state = normalizeQbSyncStatus(status);
  if (state === "unknown") return null;
  return <span className={`px-1.5 py-0.5 rounded text-2xs font-medium ${QB_SYNC_CLS[state]}`}>{qbSyncLabel(status, rampObject)}</span>;
}
```

**`expenses/page.tsx`:**
- `ExpenseRow` type += `qb_sync_status: string | null; qb_synced_at: string | null; qb_remote_id: string | null;`.
- `EXPENSE_CONTROLS.filters` += `{ param: "qbsync", accessor: (e) => normalizeQbSyncStatus(e.qb_sync_status) === "synced" ? "synced" : "not_synced" }`.
- Add a `FilterSelect` in the `FilterBar` (label "QB Sync"; options All / Synced / Not synced) wired to `filters.qbsync` / `setFilter("qbsync", …)`.
- Add a `<Th label="QB Sync" />` in the `LedgerTable` head (between "Mapping" and the amount `SortableTh`) and a matching `<td>` in `ExpenseRowView` rendering `<QbSyncBadge status={e.qb_sync_status} rampObject={e.ramp_object} />`. Bump the expanded-row `colSpan` from 7 to 8.
- Add a `SummaryStatBar` stat: `{ label: "In QuickBooks", value: expenses.filter(e => normalizeQbSyncStatus(e.qb_sync_status) === "synced").length }`.
- In the expandable detail grid, add `["Synced to QB", e.qb_synced_at ? fmtDateTime(e.qb_synced_at) : "—"]` and `["QB ref", e.qb_remote_id ?? "—"]`. Add a small `fmtDateTime` helper (or reuse `fmtDate` on the date part).

**`bank-ledger/page.tsx`:**
- `BankRow` type += the three fields.
- `BANK_CONTROLS.filters` += the same `qbsync` filter accessor.
- Add the `FilterSelect`, the "QB Sync" `Th` + badge `td`, and the "In QuickBooks" stat (mirror the expenses wiring). Bank rows are `ramp_object="bank"` for the badge prop.

**Acceptance:** `npm run verify` green. Browser check (dev server) on `/finance/transactions/expenses` and `/finance/transactions/bank-ledger`: badges render (Synced/Bill only/Ready/Not synced), the "In QuickBooks" stat matches the synced count, the filter narrows the list, and the expanded row shows synced-at / QB ref. No raw color utilities in either page.

- [ ] Create `QbSyncBadge.tsx`.
- [ ] Wire `expenses/page.tsx` (type, column, badge, stat, filter, detail).
- [ ] Wire `bank-ledger/page.tsx` (type, column, badge, stat, filter).
- [ ] `npm run verify` + browser verify; commit: `feat(finance): show QuickBooks sync status in Transactions`.

---

## Self-Review

- **Spec coverage:** capture (Task 3) · persist/migration (Task 1) · normalize+colors (Task 2) · API (Task 4) · badge+column+stat+filter+detail (Task 5) · tests (Tasks 2–3) · rollout note (below). All spec sections covered.
- **Type consistency:** `QbSyncState`, `RampObject`, `normalizeQbSyncStatus`, `qbSyncLabel`, `QB_SYNC_CLS`, and the three `qb_*` field names are used identically across Tasks 2→3→4→5.
- **Placeholders:** none — every mapping value and field name is explicit.

## Rollout (post-merge, human-gated)

1. Apply `supabase/migrations/20260805_expenses_qb_sync_status.sql` to prod.
2. Run one Ramp sync (Expenses tab "Sync Ramp" button or daily cron) to populate `qb_*` on existing rows.
