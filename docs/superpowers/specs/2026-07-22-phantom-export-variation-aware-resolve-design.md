# Variation-aware phantom-export resolve

**Date:** 2026-07-22
**Area:** Production → Export Bay → "Draft swaps recorded without cold-storage stock" alert

## Problem

When a draft keg swap is synced but cold storage has no matching keg to deduct,
the system books a batch-less **phantom** export (so barrel excise is still
recorded) and raises a reconcile alert in the Export Bay.

The alert already has a **Reconcile** action (batch picker + button) beside
**Dismiss**, but it only renders when `eligibleBatches.length > 0`. Eligible
batches are computed as cold-storage lots of the **exact variation the phantom
auto-derived**, in a **single batch** with enough for the full swap. When that
set is empty, the user sees only **Dismiss** and cannot safely resolve.

This fails in two real situations:

1. **Wrong (mislinked) variation.** The phantom derives its variation from
   `(recipe_id, packaging_item_id, packaging_format)`. If the recipe is
   mislinked (e.g. Vienna Lager → "Fortnight - 1/6 Keg"), the derived variation
   never has stock. The keg physically drained is a *different* same-size
   variation (e.g. the generic "1/6 Keg", 34 on hand), which Reconcile never
   offers. → only Dismiss.
2. **Forgotten stock (posthumous).** The booked variation was correct, but the
   brewer forgot to enter the keg into cold storage at swap time. Once the keg
   is entered, the user wants to deduct it as booked — the existing reconcile
   covers this *only if* a single batch holds the full quantity.

### Confirmed live example

One open alert: **Vienna Lager**, booked as **"Fortnight - 1/6 Keg"** (1 keg,
0.1666 BBL, $3.77 excise, 2026-07-20). Cold storage for Vienna Lager holds
**no** Fortnight-1/6 stock, but **34× generic "1/6 Keg"** and 10× "1/2 Keg".
The generic 1/6 keg is the same size (661 fl oz) as booked.

## Goal

Let the user **resolve** a phantom alert by picking the correct cold-storage lot
(**variation + batch**) to deduct against — covering both the wrong-variation and
forgotten-stock cases — instead of being locked to the auto-derived variation.

## Constraints & decisions (from brainstorming)

- **Always same size.** The correct keg is always the same per-keg volume as
  booked; only the variation identity may differ. Therefore `volume_bbl` and the
  `export_transaction_taxes` (excise) rows stay valid as-booked — **no excise or
  volume recompute**. The server enforces same-size and never trusts the client.
- **Correct the record when the variation changes.** If the chosen variation
  differs from the booked one, update the export row's
  `packaging_item_id` / `packaging_format` / `variant_label` to the deducted keg
  so the saved shipment reflects reality. `is_phantom` stays `true` (permanent
  origin marker).
- **Offer all same-size keg lots of the recipe** (generic *and* partner), so the
  mislink case is coverable.
- **Single lot per resolve** (one variation + one batch holding the full
  quantity) for v1 — matches the existing reconcile and covers keg swaps
  (typically 1 keg). Multi-batch splitting is out of scope.
- **Dismiss is unchanged.**

## Design

### Data / alert shape — `lib/production/phantomExportAlerts.ts`

Replace the batch-only eligibility with lot eligibility.

```ts
export interface EligibleLot {
  variationId: string;
  variationName: string;
  batchId: string;
  batchCode: string;
  onHand: number;
}
// PhantomAlert:
//   - remove:  eligibleBatches: EligibleBatch[]
//   - add:     eligibleLots: EligibleLot[]
//   - keep:    variationId/variationName (the *derived/booked* one, for display
//              and for the "did the variation change?" comparison at resolve)
```

`fetchEligibleLots(supabase, alert)` — cold-storage lots for the alert's recipe,
**keg** container, **same per-keg volume** as the phantom
(`total_volume_fl_oz ≈ alert.volumeBbl / alert.quantityKegs × BBL_TO_FL_OZ`,
within epsilon), with `on_hand >= alert.quantityKegs`. One `EligibleLot` per
`(variation, batch)` with `quantity_on_hand > 0` meeting the threshold. Joins
`brew_batches(batch_number)` and `packaging_variations(name, total_volume_fl_oz,
container:packaging_items(type, volume_fl_oz))`.

The existing `EligibleBatch` type and `fetchEligibleBatches` are removed (no
other consumers — verify with grep during implementation).

### Resolve logic — `lib/production/reconcilePhantom.ts`

`reconcilePhantom(supabase, { exportTransactionId, variationId, batchId })`
(was `{ exportTransactionId, batchId }` with a derived variation):

1. `loadOpenPhantom` — must exist, be `is_phantom`, and not acknowledged (else
   `PhantomReconcileError` → HTTP 400). Unchanged.
2. Load the chosen variation (`packaging_variations` + container). Validate:
   - container `type === "keg"`;
   - **same per-keg volume** as the phantom row (guards excise integrity);
   - the `(recipe_id, variationId, batchId)` lot's on-hand `>= row.quantity`.
   Any failure → `PhantomReconcileError`.
3. `depleteColdStorageInventory(supabase, { recipeId, variationId, quantity, batchId })`.
4. Update the export row:
   - always: `batch_id = batchId`, `alert_acknowledged_at = now()`;
   - if `variationId`'s `(container_id, format)` differs from the row's
     `(packaging_item_id, packaging_format)`: also set
     `packaging_item_id = variation.container_id`,
     `packaging_format = variation.format`,
     `variant_label = variation.name`.
5. `checkAndCompleteBatch(supabase, batchId)`.

`dismissPhantomExport` is unchanged (acknowledges without depleting / setting
batch_id).

`resolveSwapVariationId` remains, used by `phantomExportAlerts.ts` to compute the
displayed/booked `variationId` (the comparison baseline). The resolve path no
longer derives the variation — it uses the caller's `variationId`.

### API route — `app/api/production/taproom-consumption/reconcile-phantom/route.ts`

`requireRole(["manager"])` unchanged. Accept `{ exportTransactionId,
variationId, batchId }`; 400 on missing fields; map `PhantomReconcileError` to
400 as today.

### UI — `app/production/components/ExportBayTab.tsx`

- Local alert type: `eligibleBatches` → `eligibleLots`.
- `PhantomAlertRow`: replace the batch `<select>` with a single **lot** `<select>`
  (`— pick keg lot —` placeholder), each option
  `` `${variationName} · ${batchCode} (${onHand} on hand)` ``, value encodes
  `variationId + batchId` (e.g. a `variationId|batchId` string split on submit,
  or track both in state). Show **Resolve** when `eligibleLots.length > 0`;
  disabled until a lot is chosen. **Dismiss** always shown.
- Rename local handler `onReconcile`→`onResolve` and button label
  `Reconcile`→`Resolve` for clarity (optional; keep if low-churn).
- `usePhantomAlertMutations`: `reconcile` mutation posts `{ exportTransactionId,
  variationId, batchId }`; invalidates `phantomAlerts()` + `exportBayInventory()`
  (unchanged keys).
- `PhantomAlertsPanel` copy unchanged ("Draft swaps recorded without cold-storage
  stock").

### Excise / correctness

Same-size is enforced server-side, so `volume_bbl` and the child
`export_transaction_taxes` rows remain correct with **no recompute**. Reconcile
never re-runs `writeColdStorageShipment` (which would double-book excise); it
depletes directly and backfills the existing phantom row, exactly as today.

## Testing

- `lib/production/reconcilePhantom.test.ts` (extend):
  - resolve with the **same** variation (posthumous) — depletes chosen batch,
    sets `batch_id`, acknowledges, completes batch, does **not** change
    `variant_label`, does **not** flip `is_phantom`;
  - resolve with a **different** same-size variation — additionally updates
    `packaging_item_id` / `packaging_format` / `variant_label`;
  - reject a **different-size** lot;
  - reject **insufficient on-hand**;
  - existing not-found / not-phantom / already-resolved rejections still pass;
  - `dismiss` unchanged.
- `lib/production/phantomExportAlerts.test.ts` (update): `eligibleLots` shape —
  same-size + on-hand filtering, one entry per `(variation, batch)`, excludes
  different-size and zero-stock lots.

## Files

- `lib/production/phantomExportAlerts.ts`
- `lib/production/reconcilePhantom.ts`
- `app/api/production/taproom-consumption/reconcile-phantom/route.ts`
- `app/production/components/ExportBayTab.tsx`
- `lib/production/reconcilePhantom.test.ts`
- `lib/production/phantomExportAlerts.test.ts`

No schema/migration changes — resolve reuses existing columns.

## Out of scope

- Multi-batch / partial-quantity resolve.
- Different-size resolve (excise/volume recompute).
- Fixing the underlying recipe↔variation mislink (separate data cleanup).
