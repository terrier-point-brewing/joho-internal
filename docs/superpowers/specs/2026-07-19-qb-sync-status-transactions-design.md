# QuickBooks sync status on Transactions — design

**Date:** 2026-07-19
**Status:** Approved (design), pending implementation plan

## Goal

Capture Ramp's per-object QuickBooks sync state during ingest, persist it, and
surface it in the Finance → Transactions **Expenses** and **Bank Ledger** tabs.
This gives operators a per-row "is this already in QuickBooks?" signal and lays
the groundwork for a future export route that must **exclude objects Ramp already
synced to QuickBooks** (the app now codes some expense types at finer granularity
than Ramp does, so we will eventually push our own QB uploads — but only for
things Ramp hasn't already pushed).

## Verified precondition (live Ramp data, read-only probe)

- Accounting connection: `remote_provider_name: "QuickBooks"`, `connection_type:
  "DIRECT"` (Ramp's native integration), `status: "linked"`, active. Ramp is the
  party syncing to QB, and it exposes that state over the developer API.
- `/transactions` (last 100): `SYNCED` 68 · `NOT_SYNC_READY` 31 · `SYNC_READY` 1.
  Each row also carries a `synced_at` timestamp. `?sync_status=SYNCED` server-side
  filtering works.
- `/bills` (12): `BILL_AND_PAYMENT_SYNCED` 6 · `BILL_SYNCED` 3 · `NOT_SYNCED` 3.
  Each bill carries `remote_id` (the QB object id) and `enable_accounting_sync`.
- `/banking/syncable-transactions`: `sync_status` field exists (0 rows in the
  probed window; capture it when present).

## Data model

### New columns (both `expenses` and `ramp_bank_ledger`)

| Column | Type | Meaning | Source |
|---|---|---|---|
| `qb_sync_status` | `text` (nullable) | Raw Ramp `sync_status` value | txn/bill/bank `sync_status` |
| `qb_synced_at` | `timestamptz` (nullable) | When Ramp pushed it to QB | txn `synced_at` (null for bill/bank) |
| `qb_remote_id` | `text` (nullable) | QuickBooks object id | bill `remote_id` (null for card/bank) |

**Naming rationale:** `expenses.synced_at` **already exists** and means "when *our
app* last upserted this row from Ramp" — a different concept. The `qb_` prefix
keeps the QB-sync fields unambiguous.

**Why store raw, not normalized:** the three object types use different enums
(cards `NOT_SYNC_READY|SYNC_READY|SYNCED`; bills
`NOT_SYNCED|BILL_SYNCED|BILL_AND_PAYMENT_SYNCED`; bank per docs). Storing the raw
value preserves the bill-vs-payment nuance (a user decision) and lets a pure
helper normalize for display/filtering. `qb_remote_id` is included now — YAGNI
notwithstanding — because the known next consumer (the export route) will dedupe
against QB object ids, per the codebase's "build for extension" priority.

**Migration:** `supabase/migrations/20260805_expenses_qb_sync_status.sql`
(after the latest existing `20260804`). `add column if not exists` × 3 on each
table; one index `idx_expenses_qb_sync_status`. **No data migration, no
destructive ops.** Existing rows have NULL `qb_*` until the first post-deploy
sync re-upserts them (upsert key `(source, source_transaction_id)` fills them
in place). The plan's final step: run one Ramp sync to populate history.

## Normalization (`lib/finance/qbSyncStatus.ts` — pure, unit-tested)

```
type QbSyncState = "synced" | "partial" | "ready" | "not_ready" | "unknown";

normalizeQbSyncStatus(raw: string | null): QbSyncState
  SYNCED, BILL_AND_PAYMENT_SYNCED        -> "synced"
  BILL_SYNCED                            -> "partial"   // bill in QB, payment not
  SYNC_READY                             -> "ready"
  NOT_SYNC_READY, NOT_SYNCED             -> "not_ready"
  null / unrecognized                    -> "unknown"

qbSyncLabel(raw: string | null, rampObject: "card"|"bill"|"bank"): string
  synced (card/bank)          -> "Synced"
  BILL_AND_PAYMENT_SYNCED     -> "Synced"
  BILL_SYNCED                 -> "Bill only"
  ready                       -> "Ready"
  not_ready                   -> "Not synced"
  unknown                     -> "—"
```

Badge tone/class map (`QB_SYNC_CLS`, keyed by `QbSyncState`) is added to the
existing centralized `app/finance/lib/categoryColors.ts` (which already owns the
violet "QuickBooks" category color and other finance pills). No raw colors in
feature files.

- `synced` → success tone
- `partial` → info tone (attention: only half in QB)
- `ready` → neutral/info
- `not_ready` → faint/neutral
- `unknown` → nothing / muted

## Ingest wiring (minimal churn)

1. `lib/ramp.ts` — add the fields to `RampTransaction` (`sync_status`,
   `synced_at`), `RampBill` (`sync_status`, `remote_id`), `RampBankLine`
   (`sync_status`); read them in `getRampTransactions` / `getRampBills` /
   `getRampBankTransactions`.
2. `lib/finance/expenses.ts` — add `qb_sync_status`, `qb_synced_at`,
   `qb_remote_id` to `ExpenseRecord`.
3. `lib/finance/rampExpenses.ts` — populate from txn (card) and bill (all line
   items inherit the parent bill's `sync_status` + `remote_id`; `qb_synced_at`
   null for bills).
4. `lib/finance/bankLedger.ts` — add the three fields to `BankLedgerRecord` and
   populate in `bankLineToLedgerRecord` (and the bank→expense record path).
   `qb_synced_at` / `qb_remote_id` stay null for bank lines.

Upserts already spread `...rec`, so once the record types carry the fields,
storage flows through with no upsert changes.

## API

- `GET /api/finance/expenses` — add `qb_sync_status, qb_synced_at, qb_remote_id`
  to the `select`. Enriched rows pass through unchanged otherwise.
- `GET /api/finance/bank-ledger` — same three columns added to its `select`.

## UI (both tabs)

- **New shared component** `app/finance/transactions/components/QbSyncBadge.tsx`
  — props `{ status: string | null; rampObject: "card"|"bill"|"bank" }`; renders
  the literal-labeled pill via `qbSyncLabel` + `QB_SYNC_CLS`. Renders nothing for
  `unknown`.
- **New "QB Sync" column** in each `LedgerTable` head + body cell.
- **Summary stat** in `SummaryStatBar`: `"{n} in QuickBooks"` (count of rows whose
  normalized state is `synced`).
- **Filter** (`FilterSelect`): All / Synced / Not synced — wired through
  `useTableControls` `ControlsConfig` (`param: "qbsync"`, accessor =
  `normalizeQbSyncStatus`). This is the piece that directly serves the export
  goal (isolate the not-yet-in-QB set).
- **Expandable detail** additions: `qb_synced_at` (formatted) and `qb_remote_id`
  in the existing detail grid.
- Add `qb_sync_status`, `qb_synced_at`, `qb_remote_id` to the `ExpenseRow` /
  `BankRow` client types.

## Testing

- `lib/finance/qbSyncStatus.test.ts` — `normalizeQbSyncStatus` + `qbSyncLabel`
  for every enum value across all three object types, plus null/unknown.
- Extend `rampExpenses.test.ts` / `bankLedger.test.ts` record-shape assertions if
  they pin exact fields (add the three fields).
- `npm run verify` (lint + typecheck + tests) green; keep `lib/` coverage above
  the `vitest.config.ts` floor.

## Scope / non-goals

- ~11 files, mostly mechanical after the normalizer + badge. One migration, no
  destructive ops.
- **Not** in scope: the actual QB export route (this is its precondition), calling
  Ramp's `POST /accounting/syncs` (Ramp's native integration owns the sync — we
  must never post our own results), and webhook/near-real-time updates (the daily
  cron + on-demand sync already repopulate `qb_sync_status`).

## Rollout

1. Merge PR.
2. Apply migration `20260805_expenses_qb_sync_status.sql` to prod (human-gated,
   per repo migration policy).
3. Run one Ramp sync (on-demand button or wait for daily cron) to populate
   `qb_*` on existing rows.
