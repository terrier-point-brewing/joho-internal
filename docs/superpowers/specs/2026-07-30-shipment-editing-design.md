# Shipment Editing — Phase 1

**Date:** 2026-07-30
**Status:** Design, pending approval
**Scope:** Edit a booked shipment's channel, recipient, and notes from Production → Shipments.

## Goal

An operator books a shipment, then discovers it was recorded against the wrong
channel (or the wrong customer). Today the only remedy is a hard `DELETE` on an
API route nothing in the UI calls, which does not restore cold-storage
inventory. This adds a guarded, audited edit path for the corrections that do
not require re-planning allocation credits.

## Non-goals (Phase 1)

- **Swapping *into* `contract_brewing`.** Entering contract mode requires
  re-running the allocation credit planner, an `excludeShipmentId` variant of
  the reserve loader, a preview surface for its warnings, and an atomic
  delete+insert RPC. Designed separately as Phase 2; see *Deferred* below.
- **Editing quantity or packaging variation.** Those change what was physically
  drained and must unwind `cold_storage_inventory`.
- **Editing taproom shipments.** POS-sync-owned.
- **Regenerating or repricing an existing invoice.**

---

## 1. Domain model

A *shipment* is the set of `export_transactions` rows sharing a `shipment_id`.
`writeColdStorageShipment` writes one row per drained batch (flat physical mode)
or one row per allocation credit (crediting mode).

`channel` is load-bearing in four places:

| Consumer | Dependency |
|---|---|
| NC DOR beer-excise worksheet | Gallons are bucketed by channel |
| `exportInvoicePreview` | Channel selects the pricing/discount branch, and **all rows on one invoice must share a channel** (`lib/production/exportInvoicePreview.ts:106`) |
| `checkAndFulfillCommitment` | Matches exports on `batch_id + channel + recipient_id` |
| `initialExportStatus` | `taproom` → `paid`; every other channel → `invoice_required` |

The third and fourth are why the edit needs guards rather than a plain `UPDATE`.

### Unit of edit

**The whole shipment, atomically.** Because an invoice cannot span mixed
channels, editing a subset of a shipment's rows would leave the remainder
permanently un-invoiceable. The API takes a `shipment_id`, not a row id.

---

## 2. Rules

### Editable fields

`channel`, `recipient_id` (+ denormalised `recipient_name`), `notes`.

### Legal channel transitions

| From | To |
|---|---|
| `distribution` | `wholesale` |
| `wholesale` | `distribution` |
| `contract_brewing` | `distribution`, `wholesale` |

`contract_brewing` is a **one-way exit** in Phase 1. `taproom` is neither a
source nor a target.

### Mixed-channel shipments are legal input

A crediting-mode shipment can legitimately span more than one channel:
`planCreditedWrites` stamps each credited row with **its own allocation's**
channel (`cand.channel`, which may be `contract_brewing` or a soft channel) and
stamps over-delivery rows with `overDeliveryChannel`. So a single `shipment_id`
can hold both `contract_brewing` and `distribution` rows.

The edit therefore must **not** require a single current channel. Instead:

- The target channel is applied to **every** row in the shipment, collapsing it
  to one channel. This is the intended semantics — the operator is asserting
  that the whole shipment belongs to the target channel.
- A shipment counts as *exiting contract* if **any** row has a non-null
  `allocation_id`, regardless of that row's own channel value.
- `allowedTargetChannels` takes the set of current channels, not a single one.

An invoiced mixed-channel shipment is already rejected by G1, and
`exportInvoicePreview` refuses to invoice mixed rows without an override — so
collapsing to one channel strictly improves invoiceability.

### Guards

Every guard returns HTTP 409 with a specific, operator-readable `error` string.
Guards are evaluated over **all** rows in the shipment; any single row tripping
a guard rejects the whole edit.

| # | Condition | Message |
|---|---|---|
| G1 | Any row has a non-null `invoice_id` | Invoiced — use the invoice-level billing-channel override instead |
| G2 | Any row's `status` is `unpaid` or `paid` | Payment has been recorded |
| G3 | Any row's `channel` is `taproom` | Taproom consumption is owned by the POS sync |
| G4 | Target channel is `taproom` | Cannot convert a shipment into taproom consumption |
| G5 | Target channel is `contract_brewing` | Not supported — unship and rebook (Phase 2) |
| G6 | Any row has `is_phantom = true` | Phantom recount rows have no physical shipment to re-channel |
| G7 | `recipient_id` explicitly set to null | Every editable channel is a partner channel and needs a recipient to invoice |
| G8 | Patch is a no-op — every row already at the target channel, and no other field changed | No changes |
| G9 | `edit_reason` missing/blank when any row's `channel` changes | A reason is required |
| G10 | Shipment id matches no rows | Not found (404, not 409) |

G2 is strictly redundant with G1 in current data (status only leaves
`invoice_required` via the invoice flow), but is stated independently so the
guard survives any future path that marks a row paid without an invoice.

### Contract-brewing exit side effects

When any row in the shipment carries an `allocation_id` and the target channel
is not `contract_brewing`, then, in this order:

1. Collect the distinct non-null `allocation_id` values across the shipment.
2. Set `allocation_id = null` and `over_allocation = false` on every row.
   Over-allocation is a property of crediting against a booked deposit; it is
   meaningless once the row is no longer credited.
3. For each collected allocation, run `recheckCommitmentFulfillment`.

Step 3 needs new behaviour: `checkAndFulfillCommitment` only ever *sets*
`fulfilled` and early-returns when already fulfilled. Removing credit can push a
commitment back below its threshold, so fulfillment must become reversible.

`recheckCommitmentFulfillment` shares the existing bbl computation and:

- `exportedBbl >= allocatedBbl` and status ≠ `fulfilled` → set `fulfilled`
- `exportedBbl < allocatedBbl` and status = `fulfilled` → set `open`
- otherwise → no write

`open` is the correct reversal target (not `brewing`): fulfillment only ever
fires once the batch is `complete`, so `brewing` is unreachable at this point.

`checkAndFulfillCommitment` is refactored to delegate to the shared computation
so the two can never diverge. Its external behaviour is unchanged.

---

## 3. Data layer

One migration. **No new tables.**

### 3.1 The missing audit trigger

`export_transactions` has no audit trigger. The `batch_exports` table it
replaced in `20260622_export_transactions.sql` did have one
(`audit_batch_exports`); it was not carried over. This is a pre-existing gap:
the current unguarded `PATCH`/`DELETE` on `/api/production/exports/[id]` mutates
and hard-deletes ledger rows with no trail at all.

```sql
drop trigger if exists audit_export_transactions on public.export_transactions;
create trigger audit_export_transactions
  after insert or update or delete on public.export_transactions
  for each row execute function public.audit_trigger_fn();
```

`audit_trigger_fn` already records `table_name`, `record_id`, `operation`,
`user_id` (via `auth.uid()`), `changed_at`, and full `old_data`/`new_data`
jsonb into `audit_log`. That is a complete channel-change history for free.

### 3.2 `edit_reason`

```sql
alter table public.export_transactions
  add column if not exists edit_reason text;
```

The operator's reason for the most recent edit. Required by the API whenever
`channel` changes (G9). Because it is a column, it lands in `audit_log.new_data`
alongside the old and new channel — so the full reasoned history is queryable
from `audit_log` even though the column itself only holds the latest value.

**Migration filename:** take a full `YYYYMMDDHHMMSS` stamp at authoring time and
verify no collision against `supabase/migrations/` first. Plain-date prefixes
have collided with parallel branches before.

---

## 4. Code layout

| File | Status | Role |
|---|---|---|
| `supabase/migrations/<stamp>_export_transaction_edit.sql` | new | §3 |
| `lib/production/shipmentEdit.ts` | new | Pure guard evaluation |
| `lib/production/shipmentEdit.test.ts` | new | One case per guard + transitions |
| `lib/production/commitmentFulfillment.ts` | edit | Add `recheckCommitmentFulfillment`; extract shared computation |
| `lib/production/commitmentFulfillment.test.ts` | new/edit | Reversal cases |
| `app/api/production/shipments/[id]/route.ts` | new | `PATCH`, sole writer |
| `app/production/components/EditShipmentModal.tsx` | new | Edit form |
| `app/production/components/ShipmentsTab.tsx` | edit | Edit affordance on the card header |
| `lib/auth/__fixtures__/legacy-matrix.ts` | edit | Register the route |

One locality group (production / shipments). Per the CLAUDE.md tier table:
**write a plan, execute inline. No subagent spawns.**

### 4.1 `lib/production/shipmentEdit.ts`

Pure, no I/O, fully unit-testable.

```ts
export type EditableChannel = "distribution" | "wholesale" | "contract_brewing";

export interface ShipmentEditRow {
  id: string;
  channel: string;
  status: string;
  invoice_id: string | null;
  is_phantom: boolean | null;
  allocation_id: string | null;
}

export interface ShipmentEditPatch {
  channel?: string;
  recipient_id?: string | null;
  recipient_name?: string | null;
  notes?: string | null;
  edit_reason?: string | null;
}

export type ShipmentEditPlan =
  | { ok: false; error: string }
  | {
      ok: true;
      /** Column updates to apply to every row in the shipment. */
      updates: Record<string, unknown>;
      /** Distinct allocations to re-check after the update. Empty unless credits are released. */
      allocationsToRecheck: string[];
      /** True when releasing allocation credits — clears allocation_id + over_allocation. */
      clearsCredits: boolean;
    };

export function planShipmentEdit(
  rows: ShipmentEditRow[],
  patch: ShipmentEditPatch,
): ShipmentEditPlan;

/** Cheap client-side mirror of G1–G3 and G6 for showing/hiding the Edit button. */
export function isShipmentEditable(rows: ShipmentEditRow[]): boolean;

/**
 * Legal targets given the shipment's current channel set (a crediting-mode
 * shipment may hold several). Drives the modal's channel select.
 */
export function allowedTargetChannels(currentChannels: string[]): EditableChannel[];
```

`isShipmentEditable` and `allowedTargetChannels` are exported so the client
derives affordances from the same source as the server enforcement — the UI can
never offer an edit the API will reject.

### 4.2 `PATCH /api/production/shipments/[id]`

`id` is the `shipment_id`. Requires `CAP.exportOperate` (same capability as
every other export-mutating route).

1. `requirePermission(CAP.exportOperate)`
2. Load all `export_transactions` for the `shipment_id`. Empty → 404.
3. `planShipmentEdit(rows, body)`. `ok: false` → 409 with the message.
4. Apply `updates` to every row via one `.update().eq("shipment_id", id)`.
   When `clearsCredits`, the same statement sets `allocation_id = null` and
   `over_allocation = false`.
5. For each `allocationsToRecheck`, `await recheckCommitmentFulfillment`.
6. Return the updated rows.

A single `UPDATE ... WHERE shipment_id = $1` is one statement, so step 4 is
atomic on its own. Step 5 is idempotent and safely re-runnable, so no RPC or
transaction wrapper is needed in Phase 1. (Phase 2's delete+insert **does**
need one.)

The route uses `createSupabaseServerClient` — the user's session client, not
the admin client — so `auth.uid()` resolves inside `audit_trigger_fn` and the
audit row is attributed to the actual operator.

### 4.3 `EditShipmentModal.tsx`

Uses `Modal` / `Field` / `ModalActions` from `app/components/ui/Modal.tsx`, the
`.inp` input classes, and `Banner` for the error. No hand-rolled primitives, no
raw colour utilities.

Fields:
- **Channel** — `<select className="inp">` limited to `allowedTargetChannels`
- **Customer** — partner select from `useContractPartnersQuery`
- **Notes** — optional textarea
- **Reason for change** — required when channel changes (mirrors G9)

Shows an inline warning whenever the shipment carries allocation credits:
*"This shipment currently credits N allocation(s). Changing its channel will
release those credits and may reopen a fulfilled commitment."*

On success: close, and `qc.invalidateQueries({ queryKey: queryKeys.production.exports() })`.
The tab already reads from that key, so no new query key is needed.

### 4.4 `ShipmentsTab.tsx`

An **Edit** button in the group header, next to the status badge, rendered only
when `isShipmentEditable(rowsForGroup)`. Taproom day-groups never get one (G3).

This requires the group to retain its constituent raw rows. `InvoiceGroup`
currently keeps only the flattened `AllocationCredit` projection, so
`groupByInvoice` gains a `rows: ShipmentRow[]` field on `InvoiceGroup`. Note
that a group keyed by `invoice_id` can span several `shipment_id`s — but G1
rejects any invoiced shipment, so an editable group is always exactly one
shipment. The Edit button reads its `shipment_id` from `rows[0]`.

---

## 5. Testing

Unit tests are the primary gate; `lib/` coverage must not drop below the
`vitest.config.ts` floor.

### `shipmentEdit.test.ts`

- One rejection case per guard G1–G9, asserting the specific message
- Each legal transition in §2 produces `ok: true` with the expected `updates`
- `contract_brewing → distribution` sets `clearsCredits: true` and returns the
  distinct allocation ids, de-duplicated across rows
- `distribution → wholesale` sets `clearsCredits: false` and an empty
  `allocationsToRecheck`
- **Mixed-channel shipment** (`contract_brewing` + `distribution` rows, as
  `planCreditedWrites` produces) → `distribution`: accepted, all rows collapse
  to `distribution`, `clearsCredits: true`
- A row with an `allocation_id` but a non-contract channel still counts toward
  `clearsCredits` and `allocationsToRecheck`
- Recipient-only and notes-only edits pass **without** `edit_reason` (G9 is
  scoped to channel changes)
- `allowedTargetChannels` never returns `taproom` or `contract_brewing`, and
  handles a multi-channel input set
- `isShipmentEditable` agrees with `planShipmentEdit` on every guard it mirrors

### `commitmentFulfillment.test.ts`

- `fulfilled` → `open` when exported drops below allocated
- No write when already `open` and still below
- No write when `fulfilled` and still at/above
- `open` → `fulfilled` on crossing up (existing behaviour, unchanged)
- Batch not `complete` → no write in either direction

### Manual verification

`npm run verify` must pass. Then, in a browser: book a distribution shipment,
edit it to wholesale, confirm the badge changes and an `audit_log` row exists
with the old and new channel and the reason. Several recent merged features
were never opened in a browser and shipped with visible defects — do not skip
this.

---

## 6. Deferred to Phase 2 (`→ contract_brewing`)

Recorded so Phase 1 does not foreclose it. Phase 1's guards, modal, audit
trigger, and `edit_reason` column are all reused unchanged; G5 is replaced.

Entering contract mode means re-deriving the allocation credit split. It does
**not** need to touch inventory — the physical drain is channel-independent,
and `requestedBbl`, `perBatchDrawBbl`, and `depleted` are all recoverable from
the existing rows. It needs:

1. **`excludeShipmentId` on `loadShipReserveContext`.** The loader derives
   `bookedRemainingBbl` and per-batch reserve from *all* rows currently in
   `export_transactions` (`lib/production/shipReserveContext.ts:64`), which for
   an edit includes the shipment being edited. `planShipment` then subtracts
   `perBatchDrawBbl` again, double-counting the drain and emitting spurious
   `guarantee_coverage` warnings. The invariant must be: plan against the
   ledger *as if this shipment were never booked*.
2. **Extract the row-split step** from `writeColdStorageShipment` so the ship
   path and the re-channel path share one planner.
3. **A preview endpoint**, mirroring `/api/production/export-bay/ship/preview`.
   The planner emits `over_booked` / `guarantee_coverage` / `under_production`;
   re-channelling a large shipment into contract can exceed the booked deposit
   and mint `over_allocation` rows. The operator must see this before
   committing.
4. **An atomic plpgsql RPC** for the delete+insert. Supabase JS has no
   transactions; split across two HTTP calls, a mid-way failure destroys the
   shipment. Same pattern as `record_batch_transfer`.

Note also that `writeExportTransaction` recomputes excise tax at current rates.
Total bbl is conserved by a re-channel, so the total only moves if rates changed
since the original ship — the Phase 2 preview should surface any delta rather
than silently reprice.

Only `export_transaction_taxes` references `export_transactions`, `on delete
cascade`, and it is recomputed on insert — so delete-and-reinsert under the same
`shipment_id` is FK-safe.

---

## 7. Related pre-existing issue (out of scope)

`app/api/production/exports/[id]/route.ts` is called by nothing in the UI and is
unsafe:

- `DELETE` hard-deletes an export row **without restoring cold-storage
  inventory**, leaving the batch permanently short.
- `PATCH` allows `status`, `quantity`, and `volume_bbl` to be set with no
  guards, no excise-tax recomputation, and no invoice consistency check.

The audit trigger in §3.1 at least makes both traceable. Fixing or removing the
route is tracked separately.
