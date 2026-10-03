---
name: project_phantom_export_variation_resolve
description: "2026-07-22: Export Bay phantom draft-swap alert gained a variation-aware \"Resolve\" (pick correct cold-storage lot = variation+batch), not just Dismiss. Fixes alerts stuck because the auto-derived variation was a mislink."
metadata: 
  node_type: memory
  type: project
  originSessionId: 6c6da304-bb3f-49f8-a969-6b5d4ab5e48c
  modified: 2026-07-22T21:11:50.463Z
---

2026-07-22: The Export Bay **"draft swaps recorded without cold-storage stock"** alert (phantom exports) previously only surfaced its **Reconcile** action when a cold-storage batch existed for the phantom's *auto-derived* variation (from recipe_packaging_variations on recipe+container+format) in a single batch covering the full swap. When that variation was a recipe↔keg mislink (e.g. Vienna Lager booked against "Fortnight - 1/6 Keg" while only generic "1/6 Keg" was on hand), no batch qualified → only **Dismiss** showed, no safe resolution.

**Feature (PR #241 OPEN, branch claude/phantom-resolve-variation-aware, off merged main):** added a variation-aware **Resolve** — a lot picker (`variation · batch (N on hand)`) listing every **same-size keg lot** of the recipe (generic + partner). On resolve: deplete the chosen (recipe, variation, batch) lot, backfill batch_id, acknowledge, and correct the export row's packaging_item_id/packaging_format/variant_label ONLY when the chosen variation differs from booked. **Same-size guard is server-enforced** (per-keg volume within `SWAP_VOLUME_TOLERANCE_FL_OZ=5` fl oz; keg sizes 661/992/1984 are well separated) so volume_bbl + export_transaction_taxes (excise) are NEVER recomputed. `is_phantom` never flipped. Covers both use cases: wrong-variation (mislink) and forgotten-stock (posthumous, brewer forgot to enter the keg).

**Key files:** `lib/production/phantomExportAlerts.ts` (`swapPerKegFlOz`, `SWAP_VOLUME_TOLERANCE_FL_OZ`, `EligibleLot`, `fetchEligibleLots` — replaces `fetchEligibleBatches`); `lib/production/reconcilePhantom.ts` (`reconcilePhantomExport({exportTransactionId, variationId, batchId})`); the two `taproom-consumption/{phantom-alerts,reconcile-phantom}` routes; `ExportBayTab.tsx` lot picker. **v1 scope:** single lot per resolve (no multi-batch/partial), same-size only, no migration.

**Durable facts:** (1) `export_transactions` stores NO variation_id — variation is derived from recipe_packaging_variations on (recipe_id, container_id=packaging_item_id, format); a phantom row is `is_phantom=true` + `batch_id NULL`; reconcile/dismiss both set `alert_acknowledged_at`, reconcile additionally sets batch_id. (2) `cold_storage_inventory` embeds packaging_variations via `packaging_variations!packaging_variations_container_id_fkey` for container type; on-hand is per (recipe, variation, batch). (3) Excise is volume-based & frozen on the phantom row — same-size resolve keeps it valid without recompute.

**Still open / not fixed here:** the underlying recipe↔variation mislink (Vienna Lager ↔ Fortnight keg) — separate data cleanup; this feature just lets you resolve around it. Spec/plan in docs/superpowers/{specs,plans}/2026-07-22-phantom-export-variation-aware-resolve*. Verify green (1816). Browser E2E of the modal blocked by manager-login requirement. Related: [[project_draft_restock_phantom_export]], [[project_draft_swap_keg_generic_options]], [[project_ghost_duplicate_packaging_variation_links]].
