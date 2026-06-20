# Export Transaction Model + Batch Completion

**Spec 2a of the Invoicing / Kegging-Canning / Cold Storage / Export feature roadmap:**
1. Cold Storage + Transfer Log schema (Spec 1 — merged)
2. **Export Transaction model + batch-completion automation** (this spec)
3. Export Bay UI (2-column matching, ad-hoc exports, allocation-adjustment/refund flow) — separate spec, depends on this one
4. Export > Commitments unified invoicing (Packaging Fees / Bulk Discount / Excise / Keg Cleaning / Forklift) — depends on Spec 3
5. Export Settings + Barrel Excise Tax settings (mirrored to Finance > Settings) — depends on Spec 4

## Problem

`batch_exports` is the current model for recorded exports: one row per `(batch_id, product_type)`, written by `/api/production/cold-storage-export`. It has no status lifecycle (the original feature request needs Invoice Required → Unpaid → Paid), no link to a specific `batch_allocations` row (needed to drive Commitment-fulfillment automation later), and is too coarse-grained for Spec 4's invoice generation (which needs one line item per recipe × packaging-variation, not per recipe × product-type).

Separately, `brew_batches.status` reaches its terminal state (`archived`) the moment product *arrives* in Cold Storage — before any of it has actually been exported. This doesn't match the original feature request's definition of "Complete" (a batch is complete once it has been fully exported, i.e. `batch_exhaustion.is_exhausted`), and is being replaced outright, not run alongside the new logic.

## Goals

- Replace `batch_exports` with `export_transactions`: one row per packaging variant shipped (matching Spec 1's "one row per variation" convention), with a status lifecycle (`invoice_required` → `unpaid` → `paid`), an explicit `shipment_id` grouping key so a later UI can select an entire shipment at once, and a nullable `allocation_id` ready for Spec 3 to populate.
- Replace `brew_batches.status`'s `archived` value with `complete`, triggered by `batch_exhaustion.is_exhausted` becoming true after an export, not by arrival in cold storage.
- Migrate existing `archived` batches by recomputing their actual exhaustion state (data treated as green-field test data per explicit instruction — no real export history to preserve, but the status recompute still needs to run since `brew_batches.status` itself is real, non-test state for batches currently mid-production).
- Repoint every existing consumer of `batch_exports` (`/api/production/allocations`, `/api/production/exports`, the 3 channel tabs under `ExportTab.tsx`) to `export_transactions`.

## Non-Goals

- Export Bay UI (2-column matching, ad-hoc export creation, allocation-adjustment/refund flow) — Spec 2b.
- Wiring `allocation_id` on writes — the column exists now so Spec 2b doesn't need a schema change, but the existing cold-storage-export flow doesn't know which allocation it's fulfilling, so it writes `allocation_id = null`.
- Commitment-fulfillment status automation — needs `allocation_id` populated, deferred to Spec 2b.
- Invoice generation, Packaging Fees / Bulk Discount logic, Excise Tax settings — Spec 3/4.
- Any UI beyond repointing the 3 existing channel tabs to the new table with equivalent display.

## Data Model

### `brew_batches.status`

Drop `archived`, add `complete` to the status check constraint/enum. New status set: `planning | brewing | fermenting | conditioning | packaging | complete`.

Migration:
```sql
-- For every batch currently marked 'archived' (which only happened via the
-- old, incorrect cold-storage-arrival trigger), recompute actual exhaustion
-- and set the status that reflects reality.
update brew_batches b
set status = case when be.is_exhausted then 'complete' else 'packaging' end
from batch_exhaustion be
where be.batch_id = b.id
  and b.status = 'archived';
```

### New table: `export_transactions`

```sql
create table public.export_transactions (
  id                      uuid primary key default gen_random_uuid(),
  shipment_id             uuid not null,
  batch_id                uuid not null references public.brew_batches(id) on delete cascade,
  recipe_id               uuid references public.recipes(id) on delete set null,
  allocation_id           uuid references public.batch_allocations(id) on delete set null,
  packaging_item_id       uuid not null references public.packaging_items(id) on delete restrict,
  variant_label           text not null,
  quantity                numeric not null,
  volume_bbl              numeric not null,
  channel                 text not null,
  recipient_id            uuid references public.contract_brewing_partners(id) on delete set null,
  recipient_name          text,
  status                  text not null default 'invoice_required',
  federal_excise_tax_usd  numeric,
  state_excise_tax_usd    numeric,
  source_transfer_id      uuid references public.batch_transfers(id) on delete set null,
  notes                   text,
  created_at              timestamptz not null default now()
);

create index export_transactions_shipment_idx on public.export_transactions(shipment_id);
create index export_transactions_batch_idx on public.export_transactions(batch_id);
create index export_transactions_allocation_idx on public.export_transactions(allocation_id);
create index export_transactions_status_idx on public.export_transactions(status);
```

`channel` mirrors `commitments.channel`/today's `batch_exports.channel` values (`taproom | distribution | contract_brewing`) for the existing 3-tab UI to keep filtering the same way.

`status` check constraint: `status in ('invoice_required', 'unpaid', 'paid')`.

### `batch_exports` table

Dropped. No backfill — confirmed green-field/test-only data.

## API Changes

### `/api/production/cold-storage-export/route.ts`

Unchanged: FIFO inventory computation, capacity/validation checks, and the `batch_transfers` (`transfer_type = 'export'`) insert.

Changed: generate one `shipment_id` (uuid) per request. Replace the `batch_exports` insert loop with one `export_transactions` insert per consumed line (one per packaging variant drawn from inventory), all sharing that `shipment_id`, `allocation_id = null`, `volume_bbl` computed the same way `cold_storage_inventory` rows compute it, and per-row excise tax computed from that row's own `volume_bbl` using the existing `FEDERAL_EXCISE_PER_BBL`/`NC_EXCISE_PER_GAL` constants (unchanged values, just applied per-row instead of per-batch-aggregate).

After the writes commit, call a new batch-completion check (see below) once per distinct `batch_id` touched by this request.

### Batch completion check

New function, e.g. `lib/production/batchCompletion.ts`:
```ts
async function checkAndCompleteBatch(supabase: SupabaseClient, batchId: string): Promise<void> {
  const { data: exhaustion } = await supabase
    .from("batch_exhaustion")
    .select("is_exhausted")
    .eq("batch_id", batchId)
    .single();
  if (!exhaustion?.is_exhausted) return;
  const { data: batch } = await supabase.from("brew_batches").select("status").eq("id", batchId).single();
  if (batch?.status === "complete") return;
  await supabase.from("brew_batches").update({ status: "complete" }).eq("id", batchId);
  await supabase.from("batch_status_history").insert({
    batch_id: batchId, status: "complete", note: "Auto: fully exported",
  });
}
```
Called from `cold-storage-export/route.ts` after its writes commit — mirrors the existing auto-transition pattern in `record_batch_transfer`, just triggered by export completion instead of tank arrival.

### `record_batch_transfer` RPC

Remove the `cold_storage → archived` mapping from `v_new_status`'s `case` statement (the function defined in `20260617_schedule_and_transfer_fixes.sql`). Arrival in cold storage no longer changes batch status — the batch stays at `packaging` until exported, matching the corrected semantics. No other change to this function.

### `app/production/types.ts`

`BatchStatus` type and `EQUIPMENT_TYPE_TO_STATUS` both need the matching update: drop `"archived"` from `BatchStatus`, add `"complete"`; remove the `cold_storage: "archived"` entry from `EQUIPMENT_TYPE_TO_STATUS` (no equipment-type mapping drives `complete` — only the batch-completion check does).

### Repointed consumers

- `/api/production/allocations` (GET): `exported_bbl` now sums `export_transactions.volume_bbl` grouped by `batch_id` + `channel` + `partner_id` (the same grouping key `batch_exports` used), instead of `batch_exports.volume_bbl`.
- `/api/production/exports` (GET): queries `export_transactions` instead of `batch_exports`, same response shape consumers expect (one row per export — now per packaging variant instead of per product-type, which is a finer-grained but compatible superset for any caller currently just summing/listing).
- `ExportTab.tsx`'s 3 channel-tab components (Taproom/Distribution/Contract Brewing): same query target swap, same filter-by-`channel` logic, same displayed columns (recipient, quantity, volume, excise tax) — just reading from the new table.

## Edge Cases

- **Multi-batch shipments**: FIFO consumption drawing from two different source batches for the same packaging variant in one Ship action produces two `export_transactions` rows (different `batch_id`), sharing one `shipment_id`. Both batches' completion is checked independently after the write.
- **Partial exhaustion**: a Ship action that doesn't fully exhaust a batch leaves its status unchanged at `packaging`. Only a request that pushes `batch_exhaustion.remaining_bbl` to ≤0.001 (the view's existing tolerance) triggers `complete`.
- **Re-running the completion check is idempotent**: if a batch is already `complete`, the check is a no-op (no duplicate `batch_status_history` rows).

## Testing

No test runner exists in this repo (consistent with Spec 1) — verification is `npm run lint` / `npm run build`, per-task code review, and a manual dry-run walkthrough (no live writes against batches with real packaging stock, per the same caution applied in Spec 1) confirming: a simulated export request would produce the correct number of `export_transactions` rows with correct `shipment_id` grouping, correct per-row excise tax, and correct `brew_batches.status` transition only when exhaustion is actually reached.
