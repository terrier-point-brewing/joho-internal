---
name: project_b035_wiggo_packaging_double_entry
description: "B-035 Wiggo! packaging double-entry fix (PR #296) + the cold_storage_inventory aggregation trap that makes source_transfer_id unsafe to key an undo on"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0b5f14c5-6f0e-4c9a-b392-5df475c40c6a
  modified: 2026-07-29T21:08:32.698Z
---

2026-07-29, **PR #296**, migration `20260901_fix_b035_wiggo_packaging_double_entry.sql`, **APPLIED to prod by the user before the PR was opened**.

B-035 (Wiggo!, batch `c02b77c8`) had each of its two packaging runs entered twice with the **first line repeated** instead of the intended second line: canning went `33 × Can Case` twice (second should have been `3 × loose 12oz Can`), kegging went `18 × 1/2 Keg` twice (second should have been `24 × 1/6 Keg`). Recorded draw 22.79 BBL vs the 18 BBL in brite tank 33 → `batch_exhaustion.remaining_bbl = −4.79`, which force-completed the batch via `checkAndCompleteBatch`. Post-fix: consumed exactly 20.0000, remaining 0.000000, tank 33 derives to 0.

**Why:** the durable value here is not the fix but the trap it exposed, which the earlier B-038 correction got away with only by luck.

**How to apply:**

- ⚠️ **`cold_storage_inventory` is keyed `(batch_id, variation_id)` and AGGREGATES across every transfer.** `source_transfer_id` is overwritten on every write — it means "last transfer that touched this row", NOT "the transfer that created it". So `20260807_remove_b038_erroneous_4pack_canning.sql`'s `delete from cold_storage_inventory where source_transfer_id = <bad transfer>` is only correct when that transfer was the *sole* one for that batch+variation. When two runs share a variation, you must **re-quantify and re-point** the row, never delete it. Verify row counts per batch+variation before reusing that pattern.
- **Don't reverse downstream synced history to make an upstream correction tidy.** A real Square taproom sale had already broken 2 cases into six-packs, so corrected cases land at 31 + 2 six-packs, not the 33 the operator counted. Ask which number the human means (run output vs shelf count) — it changes whether run #1 also needs editing.
- **Derive the residual, don't hardcode it.** Setting the leftover as `shrinkage_bbl = 18 - (select sum(volume_bbl) ... where from_tank_id = <tank>)` makes the tank balance to zero by construction and stays idempotent. `batch_exhaustion.is_exhausted` tests `remaining <= 0.001`, so float dust is harmless.
- Packaging stock is negative brewery-wide (12oz Blank, labels, both keg sizes) from under-recorded receipts. Move items by the correct delta; do **not** try to rebase those baselines inside a correction migration.

See [[feedback_prod_data_correction_dryrun]] for how this was verified before applying, and [[feedback_prod_db_migration_authorization]] for the authorization gate.
