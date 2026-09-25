---
name: project_b027_miscan_fix
description: 2026-07-16 B-027 canning mis-entry fix — 252×Standard 6-Pack should be 38×Fortnight Carolina Amber case
metadata: 
  node_type: memory
  type: project
  originSessionId: d05554b4-d4a7-4a79-b7b4-0ce5dcbf3ddf
---

2026-07-16: On 2026-07-15 a canning run on **B-027** (Vienna Lager, batch `5d7ade22`, recipe `78b42b64`, status still `conditioning`) was recorded as **252× "Standard 16oz 6-Pack"** (variation `7cb71188`, 6.0968 BBL) but should have been **38× "Fortnight Carolina Amber Ale - 16oz Labeled Can Case"** (variation `e715b49e`, 3.6774 BBL). Same base beer — recipe `78b42b64` is dual-labeled (CBC Vienna Lager **and** Fortnight Carolina Amber Ale both link to it via `recipe_packaging_variations`; confirmed target variation IS linked).

Bad-state footprint (all on batch `5d7ade22`): `batch_transfers` `70e13910`; `cold_storage_inventory` `33fa8177` (252 on hand); `batch_schedule_entries` canning `b7fc9403` (6.097) + conditioning `79e54344` remaining 25.24; `packaging_stock_adjustments` `1af762d9` (−1512 cans) + `163df9bf` (−252 six-pack paktech). NOT shipped/allocated/broken/exported → cleanly reversible. Canning touches **no Square API**.

Physical truth (user-confirmed): 38 cases = 912 cans = 3.6774 BBL → **2.4194 BBL returns to conditioning brite**. BBL_TO_FL_OZ = 3968.

Net packaging_items stock deltas (fix): 16oz Blank `8921dfe9` +600; 6-Pack paktech `8ac8c228` +252; 4-Pack paktech `e5c18bd1` −228; Aluminum lid `fe7d0cea` −912; Blank Tray `2faf1e44` −38; Fortnight Carolina Amber Label `f0d549ee` −912 (goes negative — loose label tracking, pre-existing, several labels already <0).

Fix = single guarded migration `20260716_fix_b027_miscan.sql` (mirrors `20260713_restore_vienna_b027_kegs.sql` precedent): correct transfer variation/qty/volume, cold-storage SKU+qty, packaging stock deltas + replace adjustment rows, schedule actuals. **APPLIED by user 2026-07-16 & verified green** (verify_b027.mjs — transfer/cold-storage/6 stocks/5 adj rows/schedule all PASS).

Latent-bug follow-up (user asked): (1) **Lids not deducted** on the 7-15 run = NOT a code bug — deduction block has always included lids (confirmed at run-time commit `c05830f` and current); it silently skips components whose id is null, so the generic "Standard 16oz 6-Pack" simply had `lid_id` null then (added later; packaging_variations isn't audited so no trail). (2) **Paktechs on CASES WAS a real bug**, fixed by PR #202 `0289cd8` (2026-07-16 11:21 PDT) via `getPaktechUnitsPerPackage` = tray.can_count/paktech.can_count; before it a case deducted only `quantity` (1/case) not `quantity×(24/4=6)`. Current code correct. **Historical fallout: ~10 case-format canning transfers BEFORE #202 (May–Jun 2026) under-deducted paktech carriers** (Castle Ruins ×42, Epic Hazy ×24/×60, Mash Pit ×39, Blank Coast ×32, Carolina Pale ×76/×46, Local Time Vienna ×83, Watermelon Gose ×50) — separate data-cleanup, not yet done. (3) Soft risk remains: deduction block is wrapped in a swallowing try/catch (no rollback) + no validation that a labeled/lidded variation has components set → silent inventory under-deduction. How `7cb71188` passed the strict gate still unexplained.
