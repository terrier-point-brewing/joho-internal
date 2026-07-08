# Square Invoice Webhooks — Automatic Paid-Status Capture

**Date:** 2026-07-08
**Status:** Approved (design)
**Branch:** `claude/square-webhooks-invoice-status-9bd940`

## Problem

When a customer pays a Square invoice, nothing in our system updates until a
user manually clicks a **Sync** button. Paid invoices therefore show stale
statuses across the app.

Three places track a Square invoice's paid-status today, all updated only by the
manual sync paths (`getInvoiceStatus` / `syncSquareInvoicesForYear`):

1. **`invoices.status`** — the finance ledger (system of record for invoices).
2. **`export_transactions.status`** — export / distribution / wholesale
   workflow, linked to `invoices` via the `invoice_id` FK.
3. **`batch_allocations`** deposit fields — `invoice_paid_at`,
   `square_payment_id`, `deposit_amount_paid_cents`. The `square_payment_id` is
   *only capturable at payment time* (via the order's tenders) and is required to
   issue refunds later.

The Square webhook endpoint already exists (`app/api/webhooks/square/route.ts`)
and handles `order.*` / `refund.*` events, but it **explicitly drops `invoice.*`
events**. That is the gap. A webhook firing on invoice payment is the ideal,
most-reliable place to capture all three consumers — especially the
refund-critical payment reference.

## Goal

On `invoice.*` webhook deliveries, automatically reconcile the invoice's status
across all three consumers, using a single shared code path that also replaces
the duplicated logic in the two manual "Sync" actions. Add a daily cron
safety-net so a missed delivery self-heals.

Non-goals: no new DB columns/migrations (all columns exist); no change to
invoice `generate`/`send` flows; no change to line-item sync.

## Architecture

One shared reconcile function is the single code path for **four** callers:

- the Square webhook (`invoice.*` events),
- the export-invoice manual `sync` action,
- the deposit-allocation manual `sync` action,
- a new daily cron safety-net.

```
Square invoice.* webhook ─┐
export sync action ───────┤
allocation sync action ───┼──▶ reconcileInvoiceStatus(supabase, squareInvoiceId)
daily cron (non-terminal) ┘        │
                                    ├─ getInvoiceStatus(Square)  [source of truth]
                                    ├─ update invoices.status
                                    ├─ cascade export_transactions.status (invoice_id FK)
                                    └─ cascade batch_allocations (square_deposit_invoice_id)
                                         └─ on PAID: capture square_payment_id via getOrderPayment
```

## Components

### 1. `lib/finance/invoiceStatus.ts` (new) — shared status mapper

Consolidates the **three** drifting Square→ledger mappers into one:

- `lib/finance/syncSquareInvoices.ts::squareStatusToLedger`
- `app/api/production/allocations/[id]/invoice/route.ts::mapSquareStatus`
- inline `PAID` checks in `app/api/production/export/invoice/route.ts`

```ts
export function mapSquareInvoiceStatus(squareStatus: string): InvoiceStatus
```

Unified mapping (`InvoiceStatus` from `types/finance.ts`):

| Square status              | Ledger status |
| -------------------------- | ------------- |
| DRAFT                      | draft         |
| UNPAID / SCHEDULED         | open          |
| PARTIALLY_PAID             | partial       |
| PAID / PARTIALLY_REFUNDED  | paid          |
| CANCELED / REFUNDED / FAILED | voided      |
| (anything else)            | unknown       |

**Behavior change (approved):** the deposit route previously mapped
`REFUNDED → paid`; unified to `REFUNDED → voided`. A fully-refunded invoice is
voided in the ledger; partial refunds remain `paid`, and refunded dollars are
already tracked separately by the refund sync.

`syncSquareInvoicesForYear` is updated to call this shared mapper so the bulk
reconciler and the per-invoice reconciler never diverge.

### 2. `lib/finance/reconcileInvoiceStatus.ts` (new) — shared reconcile

```ts
export interface ReconcileInvoiceStatusResult {
  squareInvoiceId: string;
  squareStatus: string;          // raw Square status
  ledgerStatus: InvoiceStatus;   // mapped
  updatedLedger: boolean;
  updatedExportTransactions: number;
  updatedAllocation: boolean;
  paymentCaptured: boolean;      // square_payment_id captured this run
  skippedReason?: "no-ledger-row";
}

export async function reconcileInvoiceStatus(
  supabase: SupabaseClient,      // admin client (server-side, bypasses RLS)
  squareInvoiceId: string,
): Promise<ReconcileInvoiceStatusResult>
```

Steps:

1. **Refetch from Square** — `getInvoiceStatus(squareInvoiceId)` returns
   `{ status, paidAt, version, publicUrl, invoiceNumber }`. Square is the source
   of truth; we do not trust the webhook payload (mirrors the order webhook,
   which refetches the order by id).
2. **Load ledger row** — `invoices` where `source='square'` and
   `square_invoice_id = squareInvoiceId`. If absent → return early with
   `skippedReason: "no-ledger-row"` and log (generate always creates the row
   first; the daily cron and full-year sync backstop any orphan).
3. **Update `invoices`** — `status = mapSquareInvoiceStatus(sq.status)`,
   `invoice_number` if present, merge `raw_data` (`square_status`, `updated_at`,
   `paid_at`). `updated_at` maintained by existing DB trigger.
4. **Cascade `export_transactions`** — for rows with `invoice_id = invoices.id`:
   set `status='paid'` when ledger status is `paid`; set `status='unpaid'` when
   `open`/`partial`. Guarded so it is idempotent.
5. **Cascade `batch_allocations`** — find the allocation with
   `square_deposit_invoice_id = squareInvoiceId`. If found:
   - When ledger status is `paid` and `invoice_paid_at` is null: set
     `invoice_paid_at = sq.paidAt ?? now`, and capture the payment reference via
     `getOrderPayment(square_deposit_order_id)` → `square_payment_id`,
     `deposit_amount_paid_cents`. If no `payment_id` is returned, log an error
     (refunds unavailable until manually resolved) but still record `paid`.
   - When Square status is `CANCELED`/`FAILED`: clear `invoice_sent_at`
     (matches current sync behavior).
6. **Return** the result summary for logging.

**Idempotency:** every write is guarded (`invoice_paid_at IS NULL`,
`status='unpaid'`, status equality) so repeated deliveries and cron overlap are
harmless.

**Client:** uses the admin client. The webhook already uses admin; the two
routes will pass their admin client. Admin bypasses RLS, which is correct for a
server-side reconcile.

### 3. `lib/square/webhook.ts` — invoice event helpers

Add alongside the existing helpers:

```ts
export function isInvoiceEvent(type: unknown): boolean       // type.startsWith("invoice.")
export function extractSquareInvoiceId(event: unknown): string | null
```

`extractSquareInvoiceId` reads Square's `data.object.invoice.id`, falling back to
`data.id` for resilience. Returns null on a non-invoice/malformed payload.

### 4. `app/api/webhooks/square/route.ts` — dispatch invoice events

- Widen the top-level gate: currently
  `if (!isFinanceSyncableEvent(type)) return ignored`. Change to admit invoice
  events too (`isFinanceSyncableEvent(type) || isInvoiceEvent(type)`).
- In `after()`, branch: `isInvoiceEvent` → `reconcileInvoiceStatus(admin, id)`
  where `id = extractSquareInvoiceId(event)`; existing refund/order branches
  unchanged. Wrapped in try/catch with a `[square-webhook] invoice reconcile`
  log line, same immediate-200 pattern.

### 5. Refactor the two manual `sync` actions

- **`app/api/production/export/invoice/route.ts`** `sync` action → look up the
  invoice's `square_invoice_id`, call `reconcileInvoiceStatus`, return
  `{ squareStatus }`. Removes the inline `getInvoiceStatus` + dual updates +
  the heavy post-sync `syncSquareInvoicesForYear` call.
- **`app/api/production/allocations/[id]/invoice/route.ts`** `sync` action →
  call `reconcileInvoiceStatus` (which now performs the payment-reference
  capture), re-read the allocation for the response, return
  `{ allocation, squareStatus }`. Removes the inline mapper + `getOrderPayment`
  logic.
- `generate` and `send` actions are left intact. The local `mapSquareStatus`
  helper is deleted once its only caller (`sync`) is refactored.

### 6. `app/api/cron/finance-sync/route.ts` — invoice safety-net

Extend the existing daily cron. After the orders/refunds sync, query `invoices`
where `source='square'`, `square_invoice_id IS NOT NULL`, and
`status IN ('draft','open','partial')`, then run `reconcileInvoiceStatus` for
each. Bounded to non-terminal (unpaid) invoices, idempotent, same code path as
the webhook. Add an `invoices` summary to the cron `outcome.detail`.

## Data flow (paid invoice, happy path)

1. Customer pays a published Square invoice.
2. Square POSTs `invoice.payment_made` (and/or `invoice.updated`) to the webhook.
3. Route verifies HMAC, acks 200, schedules `after()`.
4. `reconcileInvoiceStatus` refetches status (PAID), updates `invoices.status →
   paid`, flips the invoice's `export_transactions` rows to `paid` (or, for a
   deposit invoice, sets `invoice_paid_at` + captures `square_payment_id`).
5. Finance ledger UI, export tab, and deposit tracking now reflect paid
   automatically — no manual Sync.

## Error handling

- Missing signature key/URL → 500 (unchanged).
- Invalid signature → 401 (unchanged).
- Unparseable body → 200 ack (unchanged).
- Non-actionable event type → 200 ack (unchanged; now `invoice.*` is actionable).
- Reconcile failure inside `after()` → logged, not returned (Square already has
  its 200); the daily cron and manual Sync backstop.
- No ledger row for the invoice → early return `no-ledger-row`, logged.
- Missing `payment_id` on a paid deposit order → logged error, `paid` still
  recorded (current behavior preserved).

## Testing (co-located, per CLAUDE.md `lib/` coverage rule)

- `lib/finance/invoiceStatus.test.ts` — full mapping table incl. the
  `REFUNDED → voided` and `PARTIALLY_REFUNDED → paid` cases and the unknown
  default.
- `lib/square/webhook.test.ts` (extend) — `isInvoiceEvent` true/false;
  `extractSquareInvoiceId` for `data.object.invoice.id`, `data.id` fallback, and
  malformed/null payloads.
- `lib/finance/reconcileInvoiceStatus.test.ts` — with mocked `getInvoiceStatus`
  / `getOrderPayment` and a mocked Supabase client:
  - ledger status update,
  - export_transactions cascade to paid/unpaid,
  - deposit allocation paid + payment-reference capture,
  - idempotency (second run makes no duplicate writes),
  - `no-ledger-row` skip,
  - missing `payment_id` logs but records paid.

## Ops / configuration (no code)

- In the Square dashboard, subscribe the existing webhook notification URL to
  `invoice.*` events: `invoice.published`, `invoice.updated`,
  `invoice.payment_made`, `invoice.canceled`, `invoice.refunded`,
  `invoice.scheduled_charge_failed`, `invoice.deleted`.
- `SQUARE_WEBHOOK_SIGNATURE_KEY` and `SQUARE_WEBHOOK_URL` are reused as-is — no
  new environment variables.
- No database migration.

## Files touched

New:
- `lib/finance/invoiceStatus.ts` (+ test)
- `lib/finance/reconcileInvoiceStatus.ts` (+ test)

Modified:
- `lib/square/webhook.ts` (+ existing test extended)
- `lib/finance/syncSquareInvoices.ts` (use shared mapper)
- `app/api/webhooks/square/route.ts`
- `app/api/production/export/invoice/route.ts` (`sync` action)
- `app/api/production/allocations/[id]/invoice/route.ts` (`sync` action)
- `app/api/cron/finance-sync/route.ts`
