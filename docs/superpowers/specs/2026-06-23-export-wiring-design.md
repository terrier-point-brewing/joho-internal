# Spec 11: Export Wiring — Packaging Fee Container-Only Mapping

## Context

Spec 9 (merged, PR #25) added `packaging_variations` and tightened `packaging_items.type` to a checked set (`'keg', 'can', 'lid', 'paktech', 'tray', 'label'`). It left a known bug for a follow-on spec: `ExportSettingsPanel.tsx`'s `PackagingFeeSection` (around line 248) builds one default mapping row per `packaging_items` row with **no type filter**, so it lists components (lids, PakTechs, trays, labels) as if they were independently fee-able shipped units, alongside the actual containers. This is Spec 11.

## Investigation findings

Traced the full Packaging Fee data flow before designing the fix:

- `export_transactions.packaging_item_id` (set by `lib/production/exportTransactionWriter.ts:65` from the Ship flow's container picker against `cold_storage_inventory`) is **already always a container** in practice — cold storage today only tracks containers, components are consumed earlier at kegging/canning time, not at export/ship time.
- `lib/production/exportInvoicePreview.ts`'s `findMapping("packaging_fee", tx.packaging_item_id)` (line 115) therefore already only ever looks up a mapping by a real container id. The lookup path itself is not buggy.
- The fragmentation bug is isolated entirely to `ExportSettingsPanel.tsx`'s `PackagingFeeSection` (Settings UI), which iterates **all** `packagingItems` (containers + components) to render default mapping rows.
- Live DB check (`drlsazatrcrdwaihjmex`): exactly 5 canonical containers exist (`1/2 Keg`, `1/4 Keg`, `1/6 Keg`, `12oz Blank`, `16oz Blank`, types `keg`/`can`), and **zero** `export_service_mappings` rows of `service_type = 'packaging_fee'` exist yet. No backfill or migration of existing data is needed — this ships into a clean slate.
- No duplicate-volume/distinct-physical-stock containers exist today (e.g. no house-owned vs. partner-owned keg of the same size as separate rows). If that ever arises, the existing model already handles it correctly without change: each gets its own `packaging_items` row and its own independent Packaging Fee Settings row (not a `partner_id` override of one row — `partner_id` overrides are reserved for genuine billing exceptions on the *same* trackable container).

## Decision: no schema change

`export_service_mappings.packaging_item_id` is **not** renamed to `container_id`. It already matches the semantics of `export_transactions.packaging_item_id` and `cold_storage_inventory`'s same-named column — both of which already only ever hold a container id in this codebase's current data flow. Renaming one column in isolation would be cosmetic, inconsistent with its sibling tables, and would require a migration for zero functional benefit. The fix is UI- and validation-only.

## Changes

### 1. `app/production/components/ExportSettingsPanel.tsx` — `PackagingFeeSection`

Filter `packagingItems` to containers only before building default mapping rows, mirroring the existing precedent in `PackagingVariationsPanel.tsx:39` (`packaging.filter((p) => p.type === "keg" || p.type === "can")`):

```ts
const containerItems = packagingItems.filter((p) => p.type === "keg" || p.type === "can");
```

Replace `packagingItems.map((pkg) => ...)` (current line 248) with `containerItems.map((pkg) => ...)`. No other logic in `PackagingFeeSection` changes — the partner-override row rendering (`feeRows.filter((m) => m.partner_id !== null)`) is untouched (there's no existing partner-override-picker control to add or remove here; that's bug-bundle item 5.2, explicitly Spec 8's scope, not Spec 11's).

### 2. `lib/production/exportInvoicePreview.ts` — fail loudly on missing mapping

Current behavior (line 114-128) silently skips the Packaging Fee line item when no mapping is configured for a transaction's container:

```ts
const mapping = findMapping("packaging_fee", tx.packaging_item_id);
if (!mapping?.square_catalog_variation_id) continue;
```

This means a real shipped container with no fee mapping configured produces a silently under-billed invoice — no error, no line item, nothing visibly wrong until someone notices the total looks low. Per this project's established convention of failing loudly on missing required configuration (see Spec 2b's export-bay-equipment-missing fix), this becomes a thrown error instead:

```ts
const mapping = findMapping("packaging_fee", tx.packaging_item_id);
if (!mapping?.square_catalog_variation_id) {
  const containerName = pkgTypeById.has(tx.packaging_item_id)
    ? (pkgNameById.get(tx.packaging_item_id) ?? "unknown container")
    : "unknown container";
  throw new Error(
    `Packaging Fee is not configured for "${containerName}" — set it in Export Settings before generating this invoice.`
  );
}
```

This requires also loading `name` alongside `type` in the existing packaging-items query (line 83-86), and adding a `pkgNameById` map alongside the existing `pkgTypeById` map. The thrown error propagates up through the existing `buildInvoicePreview` call chain to whichever API route calls it (`app/api/production/export/invoice/route.ts`'s `generate` action), which already returns thrown-error messages as the JSON error response — no route-level change needed, this is purely an `exportInvoicePreview.ts` internal change that surfaces through existing error handling.

## Out of scope (explicitly deferred)

- Bug-bundle item 5.1 (Excise Tax Rates missing edit controls for `name`/`receiving_party`/`unit`/`rate_usd`) — Spec 8.
- Bug-bundle item 5.2 (no partner-override-picker UI on any mapping section) — Spec 8.
- `ExportBayTab.tsx`'s ship/inventory-line picker still reading/writing free-text `variant_label` against `cold_storage_inventory` — deferred to Spec 10 (cold storage rekey); whether it's fixed for free by Spec 10 or needs its own task is to be determined when Spec 10 is speced, per the Roadmap's existing note on this.
- Any `packaging_variations`/`recipe_packaging_variations` consumption — Spec 11 does not touch the variation model at all; Packaging Fee mapping is, and remains, volume/container-only and independent of which specific variation was used to fulfill a shipment.

## Testing

No test runner exists in this repo (per Roadmap Lesson #1). Verification is `npm run lint` + `npm run build` + direct code review of both changed files, plus a manual check in the running app: Export Settings' Packaging Fee section should list exactly 5 rows (the 5 live containers) with no lid/PakTech/tray/label rows present.
