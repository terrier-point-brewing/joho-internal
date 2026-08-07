---
name: project_inventory_square_reconciliation
description: 2026-07-08 — plan for cold-storage↔Square can inventory reconciliation + fixing fractional-cans display on Performance>Inventory
metadata: 
  node_type: memory
  type: project
  originSessionId: 947bd2d4-6b98-4787-a5af-67cbf89f225f
---

**Trigger:** User saw "2.7 cans" of a 12oz case + "18.8 cans" of 16oz loose on taproom Performance > Inventory (`/taproom/performance/inventory` → `InventoryTab`).

**Root cause (confirmed):** The grid reads **Square** per-format IN_STOCK via `fetchSellThrough`→`fetchCurrentCounts`, not cold storage. Square tracks cans as **one base loose-can count on the parent/"Regular" variation**; its "16oz 4-Pack"/"Case" quantities are unit-conversion derivations (`base ÷ pack-size`), inherently fractional. The report mistook those derived numbers for real per-format counts. (Model confirmed by owner via Pace Yourself Pilsner: 61 loose base → 15 four-packs, 3 cases displayed.)

**Intended architecture (owner's 6 points):** cold_storage_inventory = source of truth for can/keg; Square must merely reflect it; on a Square POS sale the existing webhook already deducts cold storage (with case→pack→loose break-down); cold storage trumps Square on drift → **write cold storage's loose-can total back onto the base Square variation**. Reconcile grain = (recipe × can-identity family), family = packaging_variations sharing (container_id, lid_id, label_id, partner_id) null-safe; **label_id** separates Regular vs "Be Like Mike" (Epic Hazy). Family tuple is only unique within a recipe.

**Decisions:** full architecture in ONE plan; write-back runs **automatically** on reconcile with a **clear notice on the Inventory subtab**.

**Plan:** `docs/superpowers/plans/2026-07-08-cold-storage-square-inventory-reconciliation.md` — 9 tasks, 3 phases (A read-side grid from cold storage + format labels; B reconciler `reconcileSquareCanInventory` at tail of `runTaproomConsumptionSync`; C subtab notice). **EXECUTED via subagent-driven-development → PR #126** (branch claude/inventory-fractional-cans-84b3c2). 711 tests pass, tsc/build/lint clean, whole-branch review addressed.

**Probe outcome (verified live, read-only):** all sampled beers already reconcile (cold-storage loose-equiv == Square base: Pace 61, BBA Groundhog 64, Groundhog IS 43, Blackberry 75) → fractional cans were PURELY a display bug. IMPORTANT correction: base = Square item's parent "Regular" variation (`volume_fl_oz_per_unit IS NULL`; the mirror labels it inventory_unit=fl_oz, NOT 'each' — the 'each' units are the per-format sale units). Reconciler resolves base via item+variant-stem+`track_inventory=true`, skips untracked "Be Like Mike" (track_inventory=false in Square).

**PENDING MANUAL PROD APPLY (after backup):** `20260722_square_inventory_reconciliations` (hard gate — reconciler journal + subtab notice depend on it) and `20260723_fix_mislinked_loose_can_links` (audit found 3 loose links — Blackberry/Spring Bock/Vienna — pointing at the 4-Pack sale unit; repoints them to base Regular; data cleanliness, reconciler already immune). Owed: manual browser pass on /taproom/performance/inventory (prod reads gated in build env).

Related: [[project_cold_storage_breakdown]] (PR #122 break-down), [[feedback_prod_db_migration_authorization]], [[project_migration_drift_brew_activities]].
