# Unified Refunds — Implementation Plan

> **Status: shipped 2026-08-08.** Migration applied, service and planner live,
> Credit Invoice modal on the Export Bay invoice panel, `syncRefunds` linking
> invoices at ingest, and the allocation adjust route reduced to a caller.
> The one thing this does NOT do is touch a refund's Square status — `PENDING`
> becomes `COMPLETED` when Square settles it, never when the app says so.

## Principle

**One refund, one row, one code path.** Every refund — allocation deposit, export
invoice, taproom POS, or one someone issued by hand in the Square dashboard —
lands in `square_refunds`. The only thing that differs between them is whether
line detail is attached.

Line detail is a nullable relationship, not a separate system. That single fact
drives everything below: GL posting, inventory, excise, and the alert.

---

## 1. Schema (one migration)

### Extend `square_refunds`

The table already carries `square_payment_id`, `amount_cents`, `status`,
`chart_of_accounts_id`, `raw_data`. Add:

| Column | Purpose |
|---|---|
| `origin` | `'app'` \| `'square'` — who issued it |
| `reason_code` | `'price_correction'` \| `'goods_returned'` \| `'never_delivered'` \| `'deposit_reduction'`, NULL until classified |
| `invoice_id` | FK → `invoices`, NULL for taproom refunds |
| `allocation_id` | FK → `batch_allocations`, for deposit reductions |
| `classified_at` / `classified_by` | audit for a Square-origin refund a human later explained |

`reason_code` NULL + `invoice_id` NOT NULL is the definition of "needs a reason".
No separate alert table.

**Casing note:** `origin` and `reason_code` are app-authored enums, so a CHECK
constraint is safe here — unlike a passed-through Square field. See
`project_constrain_casing_not_vocabulary`.

### New `refund_lines`

| Column | Purpose |
|---|---|
| `refund_id` | FK → `square_refunds` |
| `invoice_line_item_id` | FK → `invoice_line_items` — **the GL inheritance** |
| `quantity` | credited units (NULL for flat/derived lines) |
| `amount_cents` | the credited amount for this line |
| `basis` | `'per_unit'` \| `'derived'` \| `'flat'` |

No `chart_of_accounts_id` column. The account is read through
`invoice_line_item_id` so a later remap of the invoice line carries the credit
with it and the two can never disagree.

`updated_at` on both tables comes from `public.update_updated_at()` — never from
app code (`project_one_trigger_owns_updated_at`).

---

## 2. The planner — `lib/finance/refundPlanner.ts`

Pure, no I/O, fully unit-tested. Same shape as
[`shipmentEdit.ts`](../lib/production/shipmentEdit.ts): one module both the route
(enforcement) and the modal (affordances) consume, so the UI can never offer
something the API rejects.

Input: the invoice's paid line items + the operator's selections + a reason.
Output: `{ ok: false, error }` or a plan with refund total, per-line credits, and
which consequences fire.

### Line bases

| Basis | Lines | Credit computed how |
|---|---|---|
| `per_unit` | product lines, Packaging Fee, Keg Cleaning | quantity × **paid** unit price |
| `derived` | Excise Tax, Packaging Materials, invoice Discount | recomputed from what else was credited — read-only in the UI |
| `flat` | forklift, other quantity-1 service lines | all-or-nothing |

Corrected against prod during implementation: **Packaging Fee is billed per keg**
(quantities of 3–83 in `invoice_line_items`), so it is per-unit, not derived. The
invoice-level **Discount** line is derived and was missed here originally — it
carries negative money and must shrink in step with the lines it discounted, or
the credit refunds more than the customer ever paid.

Excise lines are `quantity: 1` with the whole amount in `unitPriceCents` (see
[`buildExciseTaxLines`](../lib/production/exportInvoicePreview.ts)), which is
exactly why they cannot be treated as per-unit.

### Guards

- **G1** — refund total may never exceed `paid − already_refunded`.
- **G2** — a `derived` line may not be credited alone. "Refund the excise, keep
  the beer" leaves the excise ledger and the invoice disagreeing with no volume
  change to explain it. Reject in the planner.
- **G3** — all prices come from **what was actually paid**, never a fresh price
  lookup. Same discipline as the allocation adjust route's warning against
  re-running `calculateIngredientDeposit()`.
- **G4** — `deposit_reduction` takes the existing proportional path and carries
  no lines.

### Consequences by reason

| Reason | Refund $ | Re-credit inventory | Reverse excise |
|---|---|---|---|
| `price_correction` | yes | no | no |
| `goods_returned` | yes | yes | yes |
| `never_delivered` | yes | yes | yes |
| `deposit_reduction` | yes | no | no |

Excise is per-volume, not a share of price — a price correction never moves it.
When volume *does* drop, the reversal must hit **both** the customer's refund and
the TTB/NC DOR record, through the normal excise write path.

---

## 3. The service — `lib/finance/issueRefund.ts`

One function, every entry point:

1. Plan (§2) and reject on any guard.
2. Call `createRefund()` — the existing
   [`lib/square/refunds.ts`](../lib/square/refunds.ts).
3. **Only on success**, write `square_refunds` + `refund_lines`.
4. Fan out consequences per reason.

Step 3 is non-negotiable ordering, inherited from the allocation adjust route: a
Square success followed by a DB failure must surface loudly and must never
retry the refund.

### Double-booking

Issuing in-app fires the Square webhook, which calls `syncRefunds`. Stamp the row
with the returned `square_refund_id` at write time; the sync already upserts on
that key, so the webhook updates the row instead of creating a second one.

---

## 4. GL posting

`syncRefunds` today posts every refund to a single contra-revenue account via
`resolveContraCoaId()`. That is correct for a taproom refund and wrong for an
invoice: it collapses packaging fees, excise, and materials into one bucket, and
excise is a pass-through liability that must never net against revenue.

New rule, one branch in the posting function:

- **Has `refund_lines`** → post one contra entry per line, each to the account on
  its `invoice_line_item_id`.
- **No `refund_lines`** → single contra account, exactly as today.

Classifying a Square-origin refund therefore doesn't only fix inventory — it
**re-posts the GL to the right accounts.**

---

## 5. Ingestion — `syncRefunds` becomes the other end of the same record

No parallel universe. Changes:

- Resolve `square_payment_id` → order → invoice; set `invoice_id` when it's an
  `export_invoice` or `allocation_deposit`.
- Set `origin = 'square'`, leave `reason_code` NULL.
- Keep the existing return-order resolution and taproom behaviour untouched.

A Square-issued refund gives a dollar amount with **no line attribution**. A $47
refund could be beer, excise, or both — it cannot be reverse-engineered. So the
app books the money immediately (financials stay right) and parks the operational
question for a human. It never guesses.

---

## 6. UI

**Credit Invoice** button on the Export Bay invoice row → modal listing the
invoice's paid lines. Per-unit lines take a quantity, derived lines are read-only
and recalculate, flat lines toggle. Reason picker at the top. Preview mirrors the
server's math but is display-only — the server recomputes independently. Same
contract as
[`RefundAdjustmentModal`](../app/production/components/RefundAdjustmentModal.tsx).

Unclassified refunds surface on the existing alert surface alongside
[phantom export alerts](../lib/production/phantomExportAlerts.ts). Clicking one
opens **the same modal**, pre-filled with the amount, asking only for the reason
and lines. There is no separate "classify" screen.

Sub-view switching inside the modal uses ButtonGroup, not a second TabBar
(`feedback_sub_subtabs_are_buttons_not_tabs`).

---

## 7. Downstream

- **Shipments** — show credited quantity and net dollars on the row; the shipment
  stays booked unless goods came back.
- **Cold storage** — untouched for price corrections; negative
  `writeColdStorageShipment` for returns.
- **Export invoices** — credited lines shown against originals; the columns must
  decompose to the total (`feedback_reconciliation_columns_must_tie`).
- **Financial transactions** — per-line contra entries per §4.
- **Excise** — only `goods_returned` / `never_delivered` reverse.

---

## 8. Migrating what exists

- The **allocation adjust route** stops owning its logic and becomes a thin caller
  of `issueRefund` with `reason_code = 'deposit_reduction'`. The proportional math
  moves into the planner unchanged.
- Existing `square_refunds` rows backfill to `origin = 'square'`,
  `reason_code = NULL`. Invoice-linked ones appear as needing a reason — which is
  the correct state; they genuinely were never classified.
- **The known overcharge refund** is currently sitting in the single contra
  account. Classifying it will move it to the right accounts. If its period is
  closed or closing, that restatement must go through the period-close rules, not
  around them (`project_period_close_is_human`,
  `feedback_teach_the_gate_dont_bypass_it`).

---

## Build order

1. Migration (§1)
2. Planner + tests (§2) — pure, so this is where the correctness lives
3. Service (§3) and GL posting (§4)
4. `syncRefunds` ingestion (§5)
5. Modal (§6)
6. Downstream + alert wiring (§7)
7. Allocation route migration + backfill (§8)

Steps 1–3 make the overcharge case work end to end. Steps 4–6 are what stop the
next one being handled in the Square dashboard.
