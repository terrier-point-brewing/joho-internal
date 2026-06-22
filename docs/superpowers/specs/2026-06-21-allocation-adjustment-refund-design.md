# Allocation Adjustment + Refund Flow

**Spec 2c-2 of the Invoicing / Kegging-Canning / Cold Storage / Export feature roadmap:**
1. Cold Storage + Transfer Log schema (Spec 1 — merged)
2. Export Transaction model + batch-completion automation (Spec 2a — merged)
3. Export Bay UI (Spec 2b — merged)
4. Ad-Hoc Export (Spec 2c-1 — merged)
5. **Allocation adjustment + refund flow** (this spec)
6. Export > Commitments unified invoicing — depends on Spec 2a
7. Export Settings + Barrel Excise Tax settings — depends on Spec 2a

## Problem

Today, `PATCH /api/production/allocations/[id]` fully blocks any percentage change once an allocation's deposit invoice is paid (`invoice_paid_at` set), returning a 422 telling the user to "contact support for a partial refund or additional invoice." There is no actual refund mechanism anywhere in the codebase — `lib/square/refunds.ts` is read-only (only `fetchRefunds` for finance reporting), and more fundamentally, **no Square payment ID is ever captured anywhere in this codebase**. `batch_allocations` tracks `square_deposit_invoice_id`/`square_deposit_order_id`, but Square's Refunds API requires a `payment_id`, which this system has never stored.

## Goals

- Capture the Square payment ID (and the actual amount paid) at the moment a deposit invoice is detected as paid — the only point Square makes this available — so a refund can later be issued against it.
- Replace the hard block on reducing a paid allocation's percentage with a real workflow: recalculate the deposit at the new (lower) percentage using current ingredient costs, show the user the refund amount due, and issue an actual Square refund before saving the new percentage.
- Persist a refund audit trail (refund id, amount, timestamp) on the allocation record.

## Non-Goals

- **Increasing a paid allocation's percentage** — explicitly out of scope. Per your direction, this is handled by creating an additional commitment or using an ad-hoc export instead, not by this spec's adjustment flow.
- **Backfilling `square_payment_id` for allocations already paid before this spec ships** — not attempted; these are rejected with a clear message directing manual handling via the Square Dashboard.
- Editing any other allocation field (label, partner, notes) — unchanged, still goes through the existing plain `PATCH` route.
- Any change to how deposit invoices are originally generated/sent (`createDepositInvoice`/`publishDepositInvoice`) — untouched.

## Architecture

**Migration** adds five columns to `batch_allocations`: `square_payment_id text`, `deposit_amount_paid_cents integer`, `square_refund_id text`, `refund_amount_cents integer`, `refunded_at timestamptz`. All nullable — only populated once an invoice is detected as paid (the first two) or once a refund is issued (the last three).

**`/api/production/allocations/[id]/invoice`'s sync action** (the existing endpoint that detects `PAID` status via `getDepositInvoiceStatus` and currently just sets `invoice_paid_at` + locks the allocation): extended to also fetch the Square Order's payment reference at that same moment and persist `square_payment_id` + `deposit_amount_paid_cents`. This is the only point in the whole flow where Square hands us a payment_id — if it's not captured here, it's not recoverable later without a separate Square API lookup by order id (which Non-Goals explicitly excludes doing for already-paid allocations).

**`lib/square/refunds.ts`** gains `createRefund(paymentId, amountCents, reason): Promise<{ refundId: string; status: string }>`, calling Square's `POST /refunds` via the existing `squarePost` wrapper from `lib/square/client.ts`, with a fresh idempotency key per call.

**New `POST /api/production/allocations/[id]/adjust`** (separate from the existing plain-field `PATCH`, since this is a distinct workflow with a real financial side effect, not a simple field edit). Request: `{ new_percentage: number }`.

**Cost basis is locked at the moment the customer's deposit is paid, not recomputed later.** The ingredient cost the customer was quoted and paid against is fixed at `deposit_amount_paid_cents` for the allocation's percentage *at that moment* (`percentage`, which cannot drift after payment except through this very endpoint). A later change to ingredient costs in the system never affects what this specific customer owes or is owed back — refund math is pure proportional arithmetic against the originally paid amount, not a fresh `calculateIngredientDeposit` call against current costs.

Validation, in order:
1. Allocation must be `locked` with `lock_reason === 'deposit_paid'` and `invoice_paid_at` set — otherwise this isn't the refund path; the caller should use the existing `PATCH` route instead (this endpoint returns 400 directing them there).
2. `new_percentage` must be strictly less than the allocation's current `percentage` — increases on a paid allocation are rejected (400, directing the user to an additional commitment or ad-hoc export instead, per the Non-Goals boundary).
3. `square_payment_id` must be present — if null (an allocation paid before this spec shipped), reject (422) with a message directing manual handling via the Square Dashboard.
4. Compute `refundAmountCents = Math.round(deposit_amount_paid_cents * (1 - new_percentage / percentage))` — the customer's originally-paid amount scaled down by the same ratio the percentage is shrinking by. Since `new_percentage < percentage` and `deposit_amount_paid_cents > 0` are both already guaranteed by steps 1-2, `refundAmountCents` is always strictly positive — there is no "no refund due" case to reject here; locking the cost basis at payment time makes that scenario impossible by construction.

If all validations pass: call `createRefund(square_payment_id, refundAmountCents, reason)` where `reason` is a generated string like `Allocation percentage reduced from {old}% to {new}%`. **Only on a successful refund response**, update the allocation in one write: `percentage: new_percentage`, `square_refund_id`, `refund_amount_cents: refundAmountCents`, `refunded_at: now()` — `locked`/`lock_reason` stay unchanged (still `true`/`'deposit_paid'`, since a deposit is still in place, just at a different amount). If the refund call fails, return its error (500) and do not touch the allocation row — a failed refund must never leave the percentage changed without the money having actually moved.

Note: `calculateIngredientDeposit` (used elsewhere for generating the *original* deposit invoice) is not called anywhere in this endpoint — this is a deliberate departure from the earlier draft of this spec, which incorrectly proposed recomputing against current ingredient costs.

**UI**: `BatchLogTab.tsx`'s existing inline percentage field (`savePct`), when the user enters a value lower than the current percentage on a locked+paid allocation, opens a confirmation modal instead of calling `PATCH` directly. The modal shows "Originally paid: $X.XX", "New deposit at {new}%: $Y.YY" (computed via the same proportional formula, purely for display before submission), "Refund due: $Z.ZZ", with a "Refund & Save" button that calls the new `/adjust` endpoint. If the user enters a higher value on a locked+paid allocation, the field keeps today's existing behavior unchanged (disabled/blocked — per Non-Goals, this spec doesn't add increase support).

## Edge Cases

- **Pre-spec paid allocations with no `square_payment_id`**: rejected (422) with a message directing manual handling via Square Dashboard — no backfill attempted.
- **Refund failure**: allocation row is untouched unless the Square refund call itself succeeds — write happens strictly after a successful refund response, never before or speculatively.
- **Idempotency**: each `/adjust` call generates a fresh idempotency key for `createRefund` — this is a one-time user-initiated action through the UI, not a retried background job, so key reuse across calls isn't needed.
- **Concurrent edits**: out of scope, matching the existing plain `PATCH` route's last-write-wins behavior — not a new risk introduced by this spec.

## Testing

No test runner exists in this repo (consistent with Specs 1/2a/2b/2c-1) — verification is `npm run lint` / `npm run build`, per-task code review, and a manual dry-run/code-trace walkthrough. No live Square refund is triggered during verification — that's a real financial transaction against a real payment, requiring explicit opt-in from you before ever being exercised live, same caution applied to every other live-write step across this whole feature roadmap.
