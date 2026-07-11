# Allocation Adjustment + Refund Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard block on reducing a paid allocation's percentage with a real refund workflow: capture the Square payment ID at the moment a deposit invoice is detected as paid, then let the user reduce a paid allocation's percentage by issuing an actual Square refund (computed via proportional arithmetic against the originally paid amount) before saving the new percentage.

**Architecture:** A migration adds five nullable columns to `batch_allocations` (`square_payment_id`, `deposit_amount_paid_cents`, `square_refund_id`, `refund_amount_cents`, `refunded_at`). The existing `sync` action in `/api/production/allocations/[id]/invoice` is extended to capture the first two at the moment `PAID` is detected. A new `createRefund` function in `lib/square/refunds.ts` wraps Square's `POST /refunds`. A new `POST /api/production/allocations/[id]/adjust` route validates the refund-eligible state, computes the refund via pure proportional math against the locked-in paid amount (never against current ingredient costs), calls `createRefund`, and only on success writes the new percentage + refund audit trail in one update. The UI's existing inline percentage field opens a confirmation modal showing originally-paid / new-deposit / refund-due amounts before calling the new endpoint.

**Tech Stack:** Next.js 16 App Router route handlers, Supabase Postgres (migration), Square REST API (`POST /v2/refunds`, `GET /v2/orders/{id}`), React (BatchLogTab.tsx), TanStack Query.

## Global Constraints

- No test runner exists in this repo — verification is `npm run lint` / `npm run build`, per-task code review, and manual code-trace walkthroughs (per spec's Testing section).
- No live Square refund is to be triggered during verification of this plan — that's a real financial transaction requiring explicit opt-in, never exercised automatically.
- Increasing a paid allocation's percentage stays out of scope — explicitly rejected, not silently ignored.
- Cost basis for refund math is locked at `deposit_amount_paid_cents` (the amount actually paid) — `calculateIngredientDeposit` (current ingredient costs) must never be called inside the `/adjust` endpoint.
- A failed refund call must never leave the allocation row's percentage changed — the DB write happens strictly after a successful refund response.
- Business logic lives in `lib/`, not in `app/api/**` route handlers, per this repo's architecture rules.

---

## File Structure

- **Create:** `supabase/migrations/20260623_allocation_refunds.sql` — adds the five columns.
- **Modify:** `lib/square/deposit-invoices.ts` — add `getOrderPayment(orderId)` to fetch the Square Order's tender/payment reference.
- **Modify:** `app/api/production/allocations/[id]/invoice/route.ts` — `sync` action persists `square_payment_id` + `deposit_amount_paid_cents` when transitioning to `PAID`.
- **Modify:** `lib/square/refunds.ts` — add `createRefund(paymentId, amountCents, reason)`.
- **Create:** `app/api/production/allocations/[id]/adjust/route.ts` — the new refund-and-reduce endpoint.
- **Modify:** `app/production/types.ts` — add the five new fields to `BatchAllocation`.
- **Create:** `app/production/components/RefundAdjustmentModal.tsx` — confirmation modal showing paid/new/refund amounts.
- **Modify:** `app/production/components/BatchLogTab.tsx` — `savePct` branches into the new modal flow for paid-allocation reductions.

---

### Task 1: Migration — refund tracking columns on `batch_allocations`

**Files:**
- Create: `supabase/migrations/20260623_allocation_refunds.sql`

**Interfaces:**
- Produces: columns `square_payment_id text`, `deposit_amount_paid_cents integer`, `square_refund_id text`, `refund_amount_cents integer`, `refunded_at timestamptz` on `public.batch_allocations`, all nullable.

- [ ] **Step 1: Write the migration**

```sql
-- Allocation adjustment + refund flow (Spec 2c-2): capture the Square
-- payment ID at the moment a deposit invoice is detected as paid (the only
-- point Square makes it available), and add a refund audit trail so a paid
-- allocation's percentage can be reduced with a real Square refund instead
-- of a hard block.

alter table public.batch_allocations
  add column square_payment_id text,
  add column deposit_amount_paid_cents integer,
  add column square_refund_id text,
  add column refund_amount_cents integer,
  add column refunded_at timestamptz;
```

- [ ] **Step 2: Apply locally / verify it's valid SQL**

Run: `cat supabase/migrations/20260623_allocation_refunds.sql` and visually confirm column names match exactly what later tasks reference (`square_payment_id`, `deposit_amount_paid_cents`, `square_refund_id`, `refund_amount_cents`, `refunded_at`). If you have a local Supabase stack running, apply with `supabase db push` or the project's normal migration-apply step; otherwise leave for the next deploy — this repo's convention is migrations are the source of truth and get applied via Supabase tooling, not by hand-editing prior migrations.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260623_allocation_refunds.sql
git commit -m "feat(db): add refund tracking columns to batch_allocations"
```

---

### Task 2: Capture Square payment ID when invoice sync detects PAID

**Files:**
- Modify: `lib/square/deposit-invoices.ts`
- Modify: `app/api/production/allocations/[id]/invoice/route.ts:228` (the `sync` action's `PAID` branch)

**Interfaces:**
- Consumes: `squareGet` from `./client` (existing).
- Produces: `getOrderPayment(orderId: string): Promise<{ paymentId: string | null; amountPaidCents: number | null }>` — exported from `lib/square/deposit-invoices.ts`. Later tasks (Task 4) consume `square_payment_id` and `deposit_amount_paid_cents` columns this populates.

- [ ] **Step 1: Add `getOrderPayment` to `lib/square/deposit-invoices.ts`**

Add this interface near the other response interfaces (after `SquareInvoiceGetResponse`):

```typescript
interface SquareOrderTender {
  id: string;
  payment_id?: string;
  amount_money?: { amount: number; currency: string };
}
interface SquareOrderGetResponse {
  order: { id: string; tenders?: SquareOrderTender[] };
}
```

Add this function after `getDepositInvoiceStatus`:

```typescript
/**
 * Fetches the Square Order's payment reference. Square only attaches a
 * `payment_id` to an order's tenders once the order has been paid — this is
 * the only point in the whole flow where Square hands us a payment_id; if
 * it isn't captured here (see the invoice sync route), it isn't recoverable
 * later without a separate Square lookup, which is out of scope for
 * already-paid allocations.
 */
export async function getOrderPayment(
  orderId: string
): Promise<{ paymentId: string | null; amountPaidCents: number | null }> {
  const { order } = await squareGet<SquareOrderGetResponse>(`/orders/${orderId}`);
  const tender = order.tenders?.[0];
  return {
    paymentId: tender?.payment_id ?? null,
    amountPaidCents: tender?.amount_money?.amount ?? null,
  };
}
```

- [ ] **Step 2: Wire it into the `sync` action's `PAID` branch**

In `app/api/production/allocations/[id]/invoice/route.ts`, update the import line:

```typescript
import {
  calculateIngredientDeposit,
  createDepositInvoice,
  publishDepositInvoice,
  reviseDepositInvoice,
  getDepositInvoiceStatus,
  getOrderPayment,
} from "@/lib/square/deposit-invoices";
```

Replace this block (currently at line 228):

```typescript
    if (squareStatus.status === "PAID" && !allocation.invoice_paid_at) {
      allocationUpdate.invoice_paid_at = squareStatus.paidAt ?? new Date().toISOString();
      allocationUpdate.locked = true;
      allocationUpdate.lock_reason = "deposit_paid";
      allocationUpdate.locked_at = new Date().toISOString();
    }
```

with:

```typescript
    if (squareStatus.status === "PAID" && !allocation.invoice_paid_at) {
      allocationUpdate.invoice_paid_at = squareStatus.paidAt ?? new Date().toISOString();
      allocationUpdate.locked = true;
      allocationUpdate.lock_reason = "deposit_paid";
      allocationUpdate.locked_at = new Date().toISOString();

      // Capture the payment reference now — this is the only point Square
      // makes it available; if missed here, refunds can't be issued later.
      if (allocation.square_deposit_order_id) {
        const { paymentId, amountPaidCents } = await getOrderPayment(allocation.square_deposit_order_id);
        allocationUpdate.square_payment_id = paymentId;
        allocationUpdate.deposit_amount_paid_cents = amountPaidCents;
      }
    }
```

- [ ] **Step 3: Verify with lint/build**

Run: `npm run lint`
Expected: no new errors from `deposit-invoices.ts` or the invoice route.

Run: `npm run build`
Expected: build succeeds (TypeScript compiles, no type errors on the new fields — Task 5 adds them to the `BatchAllocation` type, so if build fails here on `allocationUpdate.square_payment_id` not existing on the Supabase update payload type, that's expected to be untyped `Record<string, unknown>` already — confirm by checking the declaration `const allocationUpdate: Record<string, unknown> = {};` a few lines above; it's untyped, so this won't fail).

- [ ] **Step 4: Commit**

```bash
git add lib/square/deposit-invoices.ts app/api/production/allocations/\[id\]/invoice/route.ts
git commit -m "feat: capture Square payment ID when deposit invoice sync detects PAID"
```

---

### Task 3: `createRefund` in `lib/square/refunds.ts`

**Files:**
- Modify: `lib/square/refunds.ts`

**Interfaces:**
- Consumes: `squarePost` from `./client` (existing).
- Produces: `createRefund(paymentId: string, amountCents: number, reason: string): Promise<{ refundId: string; status: string }>` — consumed by Task 4's `/adjust` route.

- [ ] **Step 1: Add `createRefund`**

Add to `lib/square/refunds.ts` (after the existing `fetchRefunds` function):

```typescript
import crypto from "crypto";

interface SquareRefundResponse {
  refund: { id: string; status: string };
}

/**
 * Issues a Square refund against a previously captured payment. Used by the
 * allocation adjustment flow when a customer's paid percentage is reduced —
 * never called speculatively; the caller must already know the exact
 * amount owed before invoking this.
 */
export async function createRefund(
  paymentId: string,
  amountCents: number,
  reason: string
): Promise<{ refundId: string; status: string }> {
  const { refund } = await squarePost<SquareRefundResponse>("/refunds", {
    idempotency_key: crypto.randomUUID(),
    payment_id: paymentId,
    amount_money: { amount: amountCents, currency: "USD" },
    reason,
  });
  return { refundId: refund.id, status: refund.status };
}
```

Update the top import line to include `squarePost`:

```typescript
import { squareGetAll, squarePost } from "./client";
```

- [ ] **Step 2: Verify with lint**

Run: `npm run lint`
Expected: no errors (unused import etc.) in `lib/square/refunds.ts`.

- [ ] **Step 3: Commit**

```bash
git add lib/square/refunds.ts
git commit -m "feat: add createRefund to lib/square/refunds.ts"
```

---

### Task 4: `POST /api/production/allocations/[id]/adjust` route

**Files:**
- Create: `app/api/production/allocations/[id]/adjust/route.ts`

**Interfaces:**
- Consumes: `createRefund` from `@/lib/square/refunds` (Task 3); `requireRole` from `@/lib/auth`; `createSupabaseServerClient` from `@/lib/supabase/server`.
- Produces: `POST` handler accepting `{ new_percentage: number }`, returning `{ allocation: <updated row>, refundAmountCents: number, refundId: string }` on success, or `{ error: string }` with the status codes below.

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createRefund } from "@/lib/square/refunds";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

// POST /api/production/allocations/[id]/adjust
// Reduces a paid allocation's percentage and issues a proportional Square
// refund against the originally captured payment. This is a distinct
// workflow from the plain PATCH route because it has a real financial
// side effect — increasing percentage is explicitly out of scope here.
export async function POST(req: NextRequest, { params }: RouteParams) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;
  const body = await req.json();
  const newPercentage = Number(body.new_percentage);

  if (body.new_percentage == null || isNaN(newPercentage)) {
    return NextResponse.json({ error: "new_percentage is required" }, { status: 400 });
  }

  const { data: allocation, error: fetchErr } = await supabase
    .from("batch_allocations")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchErr || !allocation) {
    return NextResponse.json({ error: "Allocation not found" }, { status: 404 });
  }

  // 1. Must be in the refund-eligible state.
  if (!allocation.locked || allocation.lock_reason !== "deposit_paid" || !allocation.invoice_paid_at) {
    return NextResponse.json(
      { error: "This allocation is not a paid, locked deposit — use the regular PATCH route to edit it instead." },
      { status: 400 }
    );
  }

  // 2. Only decreases are supported by this endpoint.
  if (newPercentage >= Number(allocation.percentage)) {
    return NextResponse.json(
      { error: "Increasing a paid allocation's percentage isn't supported here — create an additional commitment or use an ad-hoc export instead." },
      { status: 400 }
    );
  }

  // 3. Must have a captured payment ID to refund against.
  if (!allocation.square_payment_id || allocation.deposit_amount_paid_cents == null) {
    return NextResponse.json(
      { error: "No Square payment ID is on file for this allocation (it was likely paid before refund tracking shipped) — handle this refund manually via the Square Dashboard." },
      { status: 422 }
    );
  }

  // 4. Pure proportional math against the amount actually paid — never a
  // fresh calculateIngredientDeposit() call against current ingredient costs.
  const currentPercentage = Number(allocation.percentage);
  const paidCents = Number(allocation.deposit_amount_paid_cents);
  const refundAmountCents = Math.round(paidCents * (1 - newPercentage / currentPercentage));

  const reason = `Allocation percentage reduced from ${currentPercentage}% to ${newPercentage}%`;

  let refund;
  try {
    refund = await createRefund(allocation.square_payment_id, refundAmountCents, reason);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Square refund failed" },
      { status: 500 }
    );
  }

  // Only write the row once the refund has actually succeeded.
  const { data: updated, error: updateErr } = await supabase
    .from("batch_allocations")
    .update({
      percentage: newPercentage,
      square_refund_id: refund.refundId,
      refund_amount_cents: refundAmountCents,
      refunded_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();

  if (updateErr) {
    return NextResponse.json(
      { error: `Refund succeeded (id: ${refund.refundId}) but saving the new percentage failed: ${updateErr.message}. Do not retry the refund — fix the allocation row manually.` },
      { status: 500 }
    );
  }

  return NextResponse.json({ allocation: updated, refundAmountCents, refundId: refund.refundId });
}
```

- [ ] **Step 2: Verify with lint/build**

Run: `npm run lint`
Expected: no errors.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Manual code-trace walkthrough (no test runner in this repo)**

Trace through these scenarios by reading the code above and confirming the branch taken:
1. Allocation not locked / wrong lock_reason / no `invoice_paid_at` → 400, directing to PATCH. ✓ (validation 1)
2. `new_percentage` equal to or greater than current → 400, directing to commitment/ad-hoc export. ✓ (validation 2)
3. `square_payment_id` null → 422, directing to Square Dashboard. ✓ (validation 3)
4. All valid, e.g. `percentage=50`, `deposit_amount_paid_cents=10000`, `new_percentage=25` → `refundAmountCents = round(10000 * (1 - 25/50)) = round(10000 * 0.5) = 5000`. Confirm this matches by hand.
5. `createRefund` throws → 500, allocation row untouched (no `.update()` call reached). ✓
6. `createRefund` succeeds but the subsequent `.update()` fails → 500 with an explicit "do not retry" message, since the refund already happened. ✓

- [ ] **Step 4: Commit**

```bash
git add app/api/production/allocations/\[id\]/adjust/route.ts
git commit -m "feat: add POST /api/production/allocations/[id]/adjust refund endpoint"
```

---

### Task 5: Add new fields to `BatchAllocation` type

**Files:**
- Modify: `app/production/types.ts:355-385` (the `BatchAllocation` interface)

**Interfaces:**
- Produces: `BatchAllocation.square_payment_id`, `.deposit_amount_paid_cents`, `.square_refund_id`, `.refund_amount_cents`, `.refunded_at` — consumed by Task 6's UI components.

- [ ] **Step 1: Add the fields**

In `app/production/types.ts`, find this block:

```typescript
  // ── Deposit invoice tracking ─────────────────────────────────────────────
  square_deposit_invoice_id: string | null;
  square_deposit_order_id: string | null;
  invoice_generated_at: string | null;
  invoice_sent_at: string | null;
  invoice_paid_at: string | null;
```

Replace with:

```typescript
  // ── Deposit invoice tracking ─────────────────────────────────────────────
  square_deposit_invoice_id: string | null;
  square_deposit_order_id: string | null;
  invoice_generated_at: string | null;
  invoice_sent_at: string | null;
  invoice_paid_at: string | null;
  // ── Refund tracking ──────────────────────────────────────────────────────
  square_payment_id: string | null;
  deposit_amount_paid_cents: number | null;
  square_refund_id: string | null;
  refund_amount_cents: number | null;
  refunded_at: string | null;
```

- [ ] **Step 2: Verify with build**

Run: `npm run build`
Expected: succeeds (these are additive optional-shape-compatible fields; existing usages of `BatchAllocation` that don't reference them are unaffected).

- [ ] **Step 3: Commit**

```bash
git add app/production/types.ts
git commit -m "feat: add refund tracking fields to BatchAllocation type"
```

---

### Task 6: Refund confirmation modal + wire into `BatchLogTab.tsx`

**Files:**
- Create: `app/production/components/RefundAdjustmentModal.tsx`
- Modify: `app/production/components/BatchLogTab.tsx:526-544` (`savePct`) and `:741-754` (the inline % input)

**Interfaces:**
- Consumes: `Modal` from `./shared` (existing); `BatchAllocation` type (Task 5); the new `/adjust` endpoint (Task 4).
- Produces: `RefundAdjustmentModal` component with props `{ allocation: BatchAllocation; newPercentage: number; submitting: boolean; onConfirm: () => void; onClose: () => void }`.

- [ ] **Step 1: Write `RefundAdjustmentModal.tsx`**

```typescript
"use client";

import { Modal } from "./shared";
import type { BatchAllocation } from "../types";

/**
 * Shown when a brewer reduces the percentage on a locked, paid allocation.
 * Refund math mirrors the server's proportional formula exactly so the
 * preview here matches what /adjust will actually charge back — but this
 * is display-only; the server recomputes independently before refunding.
 */
export function RefundAdjustmentModal({
  allocation,
  newPercentage,
  submitting,
  onConfirm,
  onClose,
}: {
  allocation: BatchAllocation;
  newPercentage: number;
  submitting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const paidCents = allocation.deposit_amount_paid_cents ?? 0;
  const currentPercentage = Number(allocation.percentage);
  const newDepositCents = Math.round(paidCents * (newPercentage / currentPercentage));
  const refundCents = paidCents - newDepositCents;

  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return (
    <Modal title="Reduce Allocation & Refund" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-zinc-500">Originally paid ({currentPercentage.toFixed(1)}%)</span>
            <span className="text-zinc-200 tabular-nums">{fmt(paidCents)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-zinc-500">New deposit at {newPercentage.toFixed(1)}%</span>
            <span className="text-zinc-200 tabular-nums">{fmt(newDepositCents)}</span>
          </div>
          <div className="flex justify-between text-sm font-semibold border-t border-zinc-700 pt-2 mt-1">
            <span className="text-zinc-300">Refund due</span>
            <span className="text-amber-400 tabular-nums">{fmt(refundCents)}</span>
          </div>
        </div>

        <p className="text-[10px] text-zinc-600">
          This will issue a real Square refund to the partner&apos;s original payment method, then save the new percentage. This cannot be undone from this screen.
        </p>

        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose}
            className="px-4 py-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="px-4 py-1.5 text-sm bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded font-medium transition-colors">
            {submitting ? "Refunding…" : "Refund & Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: Wire into `BatchLogTab.tsx`**

Add the import near the other component imports (after the `DepositInvoiceModal` import):

```typescript
import { RefundAdjustmentModal } from "./RefundAdjustmentModal";
```

Add state near the other invoice-modal state (after the `invoiceActionLoading` state declaration, around line 452):

```typescript
  const [refundAlloc, setRefundAlloc] = useState<{ allocation: BatchAllocation; newPercentage: number } | null>(null);
  const [refundSubmitting, setRefundSubmitting] = useState(false);
```

Replace `savePct` (currently lines 529-544):

```typescript
  async function savePct(a: BatchAllocation) {
    const raw = editingPct[a.id];
    if (raw === undefined) return;
    const pct = parseFloat(raw);
    if (isNaN(pct) || pct === Number(a.percentage)) {
      setEditingPct(p => { const n = { ...p }; delete n[a.id]; return n; });
      return;
    }

    // A locked+paid allocation being reduced goes through the refund flow
    // instead of the plain PATCH — that endpoint rejects this case outright.
    if (a.locked && a.lock_reason === "deposit_paid" && a.invoice_paid_at && pct < Number(a.percentage)) {
      setRefundAlloc({ allocation: a, newPercentage: pct });
      return; // editingPct stays set until the modal resolves, so the field still shows the typed value
    }

    const res = await fetch(`/api/production/allocations/${a.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ percentage: pct }),
    });
    if (!res.ok) { alert((await res.json()).error ?? "Error"); return; }
    setEditingPct(p => { const n = { ...p }; delete n[a.id]; return n; });
    await refresh();
  }

  async function handleConfirmRefund() {
    if (!refundAlloc) return;
    setRefundSubmitting(true);
    try {
      const res = await fetch(`/api/production/allocations/${refundAlloc.allocation.id}/adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_percentage: refundAlloc.newPercentage }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setEditingPct(p => { const n = { ...p }; delete n[refundAlloc.allocation.id]; return n; });
      setRefundAlloc(null);
      await refresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to issue refund");
    } finally {
      setRefundSubmitting(false);
    }
  }
```

Update the inline % input's `disabled` condition (currently `disabled={a.locked || !!a.invoice_paid_at}` at line 748) so a paid+locked allocation can still be edited downward (validation of direction happens in `savePct`/the server):

```typescript
                        disabled={a.locked && a.lock_reason !== "deposit_paid"}
```

This keeps the field disabled for `contract_signed`-locked or any other non-deposit lock (unchanged behavior), but unlocks editing for `deposit_paid`-locked allocations so `savePct` can route reductions into the refund modal. Increases on a paid allocation still get rejected — now by the `/adjust` route's validation 2 if somehow routed there, but since `savePct` only opens the refund modal for `pct < Number(a.percentage)`, an increase attempt on a paid allocation falls through to the plain `PATCH` call, which already 422s it via the existing check at `app/api/production/allocations/[id]/route.ts:33` (`current.invoice_paid_at && ... !== ...`).

Add the modal render near the other modals at the bottom of the component (find where `invoiceModalAlloc &&` renders `DepositInvoiceModal` and add this as a sibling):

```typescript
      {refundAlloc && (
        <RefundAdjustmentModal
          allocation={refundAlloc.allocation}
          newPercentage={refundAlloc.newPercentage}
          submitting={refundSubmitting}
          onConfirm={handleConfirmRefund}
          onClose={() => setRefundAlloc(null)}
        />
      )}
```

- [ ] **Step 3: Locate the exact spot for the modal render**

Run: `grep -n "invoiceModalAlloc &&" app/production/components/BatchLogTab.tsx`

Find the line where `{invoiceModalAlloc && (` opens the `DepositInvoiceModal` JSX block, and insert the `{refundAlloc && (...)}` block immediately after that block's closing `)}`.

- [ ] **Step 4: Verify with lint/build**

Run: `npm run lint`
Expected: no errors.

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 5: Manual UI walkthrough**

Run: `npm run dev`, navigate to Production → Batch Log, expand a batch with a contract_brewing allocation that has `locked=true`, `lock_reason='deposit_paid'`, `invoice_paid_at` set, and a non-null `deposit_amount_paid_cents` (seed/update test data via Supabase if none exists). Confirm:
1. The % field is now editable (not greyed out) for this row.
2. Typing a lower value and blurring opens the `RefundAdjustmentModal` instead of immediately saving.
3. The modal shows correct "Originally paid" / "New deposit" / "Refund due" numbers matching the proportional formula.
4. Clicking Cancel closes the modal without any network call (check Network tab).
5. **Do not click "Refund & Save"** unless explicitly told to exercise a live Square refund — per the spec's Testing section, no live refund should be triggered during verification.
6. Typing a *higher* value on this same row still gets rejected (the underlying PATCH call 422s) — confirm via the error alert.

- [ ] **Step 6: Commit**

```bash
git add app/production/components/RefundAdjustmentModal.tsx app/production/components/BatchLogTab.tsx
git commit -m "feat: add refund confirmation modal for reducing paid allocations"
```

---

## Final Verification

- [ ] Run `npm run lint` — zero errors across all changed files.
- [ ] Run `npm run build` — succeeds.
- [ ] Re-read the spec's Edge Cases section and confirm each is handled: pre-spec paid allocations with no `square_payment_id` (Task 4 validation 3), refund failure leaves row untouched (Task 4 try/catch), idempotency via fresh key per call (Task 3's `crypto.randomUUID()`), concurrent edits out of scope (unchanged, matches existing PATCH behavior).
