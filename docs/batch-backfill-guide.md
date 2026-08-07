# Batch Log Backfill Guide

This document is the authoritative reference for cleaning up batch log data in the production DB. It captures every rule learned from prior backfill sessions and describes exactly how the app updates the database, so that a new session can proceed without repeating past errors.

---

## Context

Several older brew batches were created before the batch-log UI was fully in place. Their `batch_schedule_entries`, `batch_transfers`, `batch_tank_assignments`, `batch_conversions`, and `cold_storage_inventory` rows are missing, wrong, or both. The goal is to reconstruct accurate records **exactly as the live app routes would have written them** — not as the backup CSVs describe them (the backup data has errors). The user provides the authoritative physical history.

---

## Backup Data Location

Three CSVs at `backups/` (dated 2026-06-26 — treat as starting-point reference only, not ground truth):

| File | Columns of interest |
|------|---------------------|
| `batch_schedule_entries_backup_20260626.csv` | `batch_id, equipment_id, stage, planned_start, planned_end, actual_start, actual_end, volume_bbl, downstream_entry_id, step_order` |
| `batch_transfers_backup_20260626.csv` | `batch_id, from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl, transfer_type, transferred_at, to_batch_id, variation_id, quantity` |
| `batch_tank_assignments_backup_20260626.csv` | `batch_id, tank_id, assigned_at, released_at` |

**Always verify backup values against the user's stated physical history.** Past errors found in the backup: wrong fermenting tank (Tank 21 listed; actual was Tank 12), wrong conversion path (Tank 12→23→33 listed; actual was Tank 12→33 direct), combined kegging rows without `variation_id`/`quantity`.

---

## Database Tables and Their Purpose

### `brew_batches`
Master batch record. Key columns: `id`, `batch_number`, `beer_name`, `volume_bbl` (original brew size), `status`, `converted_from_batch_id`.

### `batch_schedule_entries`
One row per stage in the batch's life: `brewing`, `fermenting`, `conditioning`, `kegging`/`canning`, etc. Chained via `downstream_entry_id`. Key columns:
- `equipment_id` — the tank/vessel for this stage
- `stage` — the stage name
- `planned_start`, `planned_end`, `actual_start`, `actual_end`, `completed_at`
- `volume_bbl` — volume that **arrived** into this stage (closed entry) or is **remaining** (open entry)
- `downstream_entry_id` — UUID of the next entry in the chain (NULL for the terminal entry)
- `step_order` — integer ordering within the batch

Chain structure: `brewing` → `fermenting` → `conditioning` → `kegging`/`canning` → NULL

### `batch_transfers`
**One row per physical transfer. For kegging/canning: one row per packaging variation.** Key columns:
- `batch_id`, `from_tank_id`, `to_tank_id`
- `volume_bbl` — volume that MOVED (not including shrinkage)
- `shrinkage_bbl` — volume lost/written off at this transfer
- `transfer_type` — `'brewing'`, `'transfer'`, `'kegging'`, `'canning'`, `'conversion'`
- `transferred_at` — timestamp
- `to_batch_id` — set ONLY for conversion transfers (points to child batch)
- `variation_id` — set ONLY for kegging/canning (UUID of the packaging variation)
- `quantity` — set ONLY for kegging/canning (number of vessels filled)

### `batch_tank_assignments`
Active tank occupancy. Columns: `batch_id`, `tank_id`, `assigned_at`, `released_at` (NULL = currently assigned). **Only created for equipment types: `fermenter`, `brite`, `brewhouse`.** Not created for kegging, canning, cold_storage, export_bay.

### `batch_conversions`
Links source batch to target (child) batch. Created when a conversion is planned via ConvertPanel. Key columns: `source_batch_id`, `target_batch_id`, `source_equipment_id`, `volume_bbl`, `planned_date`, `converted_at` (set when actual transfer executed). Unique on `(source_batch_id, target_batch_id)`.

### `cold_storage_inventory`
Current packaged inventory. Key: `(batch_id, variation_id)`. Column: `quantity_on_hand`. **Updated by upsert from the JS route, not via `batch_transfers`.** No `batch_transfers` row is ever created for the Kegging→Cold Storage leg.

---

## How Each App Route ACTUALLY Updates the Database

### Transfer route: `POST /api/production/transfers`

This is the most critical route. It handles **all** tank-to-tank transfers including kegging and canning.

**For a normal (non-packaging) transfer** (e.g. brewhouse→fermenter, fermenter→brite):
1. Calls the `record_batch_transfer` Postgres RPC once.
2. RPC inserts ONE `batch_transfers` row (`volume_bbl`, `shrinkage_bbl`, `transfer_type`, `transferred_at`, `from_tank_id`, `to_tank_id`, `batch_id`). `variation_id` and `quantity` are NULL.
3. RPC releases all open `batch_tank_assignments` for the batch.
4. RPC creates a new `batch_tank_assignments` row ONLY if `to_tank` equipment type is in `{fermenter, brite, brewhouse}`.
5. RPC updates `brew_batches.status` based on destination equipment type.

**For a kegging or canning transfer:**
The request body contains a `packaging_lines` array — one entry per variation. The route loops over `packaging_lines` and calls `record_batch_transfer` RPC **once per line**. After each RPC call, if `variation_id && quantity` are set, it calls `upsertColdStorageInventory(batch_id, variation_id, quantity)`.

Result:
- **N `batch_transfers` rows** (one per variation), each with `variation_id`, `quantity`, `volume_bbl`, `shrinkage_bbl`, `transfer_type='kegging'`
- **N upserts** into `cold_storage_inventory(batch_id, variation_id)` adding `quantity` to `quantity_on_hand`
- **NO** Kegging→Cold Storage `batch_transfers` row is ever created — this is the single most common backfill error to avoid

**Shrinkage distribution across packaging lines:**
```
shrinkShare(line) = round((lineVolume / totalVolume) * totalShrinkage * 1000) / 1000
lastLineShrink = totalShrinkage - sum(all previous shrinkShares)
```
Last line absorbs any rounding remainder.

**Volume formula per variation line:**
```
volume_bbl = quantity × variation.total_volume_fl_oz / 3968
```
Common values: ½ keg = 1984 fl oz → 0.500 bbl each; ⅙ keg = 661 fl oz → 0.16649... bbl each (rounds to 0.166–0.167 per keg).

### Conversion route: `POST /api/production/batch-conversions`

Called when planning a conversion via ConvertPanel.
1. Inserts a `batch_conversions` row (`source_batch_id`, `target_batch_id`, `source_equipment_id`, `volume_bbl`, `planned_date`).
2. Sets `brew_batches.converted_from_batch_id = source_batch_id` on the target batch.

The actual execution of the conversion volume movement uses the transfers route, which creates a `batch_transfers` row with `transfer_type='conversion'` and `to_batch_id` set to the target batch.

### `record_batch_transfer` RPC (Postgres)

- Inserts exactly ONE `batch_transfers` row.
- Releases all open (released_at IS NULL) `batch_tank_assignments` for `p_batch_id`.
- Creates a NEW `batch_tank_assignments` row only when destination equipment type ∈ `{fermenter, brite, brewhouse}`.
- Does NOT handle cold_storage. Does NOT handle packaging inventory.

---

## volumeLedger Rules (for verification)

`computeTankVolumes` (in `app/production/lib/volumeLedger.ts`):
1. Sorts transfers by `transferred_at` ascending.
2. Seeds `firstFrom` tank with `originalVol` — but ONLY if no transfer has `to_tank_id = firstFrom` (i.e., the first tank never received a tracked arrival). If a Backlog→Tank1 transfer exists, the seed is skipped.
3. For each transfer: deduct `volume_bbl + shrinkage_bbl` from `from_tank_id`. Credit `volume_bbl` to `to_tank_id` **only if `to_batch_id` is NULL** (conversion transfers do not credit destination in source's ledger).
4. Filters out tanks with vol ≤ 0.001 (floating-point dust from keg size rounding).

`computeLocationBreakdown` classifies remaining net volumes by equipment type:
- `converted` = sum of `volume_bbl` on transfers where `to_batch_id IS NOT NULL`
- `shrinkage` = sum of all `shrinkage_bbl`
- `packaging` = net volume sitting at kegging/canning stations
- `coldStorage` = net volume sitting at cold_storage (almost always 0 — cold storage is tracked via `cold_storage_inventory`, not batch_transfers)

---

## Equipment UUIDs (Holly Springs Taproom, `LZ8TH4A632YW0`)

Look these up from the `equipment` table rather than hardcoding. Key query:
```sql
SELECT id, name, type FROM equipment ORDER BY type, name;
```

Common tanks referenced in prior backfills:
- **Backlog** (`type='backlog'`) — starting point before brew day
- **Brewhouse B-1** (`type='brewhouse'`) — brew day vessel
- **Tank 12** (`type='fermenter'`)
- **Tank 14** (`type='fermenter'`)
- **Tank 21** (`type='fermenter'` or conditioning)
- **Tank 23** (`type='fermenter'`)
- **Tank 31** (`type='fermenter'`) — can host both fermenting and conditioning in-place (same-tank stage change)
- **Tank 33** (`type='brite'`)
- **Kegging** (`type='kegging'`)
- **Canning** (`type='canning'`)

Confirm UUIDs from DB before inserting:
```sql
SELECT id, name, type FROM equipment WHERE name IN ('Backlog','B-1','Tank 12','Tank 14','Tank 21','Tank 23','Tank 33','Kegging','Canning');
```

## Variation UUIDs

Common packaging variations:
- **½ Keg** — `ac4f3b17-d827-4e45-a823-ae80eb4dbbbc` (1984 fl oz, 0.500 bbl)
- **⅙ Keg** — `4ddbce98-7970-44c7-9dc2-97d5e489509c` (661 fl oz, ≈0.1665 bbl)
- **16oz Blank Case** — `19732e1b-ea57-4ea0-b915-0106ff54fa97` (384 fl oz, ≈0.0968 bbl per can; 42 cases = 4.065 bbl)

Verify from the `recipe_packaging_variations` or `catalog_variations` table as needed.

---

## Backfill Process (Step-by-Step per Batch)

### 1. Identify what's missing

```sql
-- What batches have no schedule entries?
SELECT bb.batch_number, bb.beer_name, bb.volume_bbl, bb.status
FROM brew_batches bb
LEFT JOIN batch_schedule_entries bse ON bse.batch_id = bb.id
WHERE bse.id IS NULL
ORDER BY bb.batch_number;

-- What transfers exist for a batch?
SELECT bt.*, e_from.name as from_name, e_to.name as to_name
FROM batch_transfers bt
LEFT JOIN equipment e_from ON e_from.id = bt.from_tank_id
LEFT JOIN equipment e_to ON e_to.id = bt.to_tank_id
WHERE bt.batch_id = '<batch_id>';
```

### 2. Get authoritative history from the user

**Do not insert anything from the backup CSVs without explicit user confirmation.** Ask the user:
- Brew date and brewhouse vessel
- Fermenting tank and date transferred in
- Any conditioning tank and date
- Conversion details if applicable (which batch, which date, how much volume, which source tank, which destination tank)
- Kegging/canning date(s), quantities per variation, and any shrinkage
- Whether the batch is fully closed or still active

### 3. Insert `batch_schedule_entries`

One row per stage, chained via `downstream_entry_id`. Insert from terminal stage backward to get UUIDs, or generate UUIDs upfront and reference them.

- `volume_bbl` on a CLOSED entry = volume that arrived at that stage
- `volume_bbl` on the OPEN (terminal) entry = volume **currently remaining** in the tank. The equipment schedule graph (`buildGraphData.ts → partialDrainInfo`) adds back departed transfer volumes (including shrinkage) to reconstruct the "arrived" total for display — so set the DB value to actual remaining, not original arrived.

**Conditioning entry with partial packaging done:** Set `volume_bbl = (original arrived) - (sum of all packaging transfers volume_bbl+shrinkage_bbl from that tank)`. Illustrative example: 40 arrived, kegged 8.997 + canned 4.065 + 1.938 shrinkage → conditioning `volume_bbl = 40 - 8.997 - 4.065 - 1.938 = 25.000`. The graph then shows "25.00 / 40.00 BBL remaining".

Once that entry CLOSES (`actual_end` set), the rule inverts: `arrivedVolume` in `buildGraphData.ts` reconstructs the arrived total from the ledger only while `actual_end IS NULL`, and reads `volume_bbl` verbatim otherwise. So set a closed entry back to the **arrived** volume — leaving it at the last "remaining" value makes the node claim that little ever arrived.

**`planned_conversion` schedule entries:** The `stage='planned_conversion'` row in `batch_schedule_entries` is filtered out of the equipment schedule graph — it has no visible node. The conversion node is driven entirely by `batch_conversions` and `brew_batches.converted_from_batch_id`. Insert it for completeness, but it has no functional effect on graph rendering.
- `actual_start`/`actual_end`/`completed_at` = real dates when known

Stage chain for a typical batch:
```
brewing (B-1) → fermenting (Tank X) → conditioning (Tank X or Y) → kegging → NULL
```

For a conversion batch (child), the first schedule entry is `conditioning` or `fermenting` at the brite/conditioning tank that received the converted volume.

### 4. Insert `batch_transfers`

**Normal transfers** (one row per hop):
- `transfer_type='brewing'` for Backlog→B-1
- `transfer_type='transfer'` for B-1→fermenter, fermenter→conditioning
- `transfer_type='conversion'` for source→destination with `to_batch_id` set

**Kegging/canning transfers** (one row PER variation):
- `transfer_type='kegging'` or `'canning'`
- `variation_id` = variation UUID
- `quantity` = number of vessels
- `volume_bbl` = quantity × variation_fl_oz / 3968
- `shrinkage_bbl` = proportional share (last line gets remainder)
- Do NOT create a separate Kegging→Cold Storage transfer row

### 5. Insert `batch_tank_assignments`

Only for `fermenter`, `brite`, `brewhouse` equipment types.

- `assigned_at` = transfer-in timestamp
- `released_at` = transfer-out timestamp (NULL if still active)

For a batch that moves through multiple constrained tanks, insert one assignment per tank with appropriate `released_at`.

### 6. Insert `batch_conversions`

For the source batch of a conversion:
```sql
INSERT INTO batch_conversions
  (source_batch_id, target_batch_id, source_equipment_id, volume_bbl, planned_date, converted_at)
VALUES (...);
```
Also set `converted_from_batch_id` on the target `brew_batches` row.

### 7. Upsert `cold_storage_inventory`

After kegging/canning transfers:
```sql
INSERT INTO cold_storage_inventory (batch_id, variation_id, quantity_on_hand)
VALUES (...)
ON CONFLICT (batch_id, variation_id)
DO UPDATE SET quantity_on_hand = cold_storage_inventory.quantity_on_hand + EXCLUDED.quantity_on_hand;
```

Check existing records first — if the live app already ran for this batch, do not double-count.

### 8. Verify

```sql
-- Volume check: all tanks should net to ≤ 0.001 for a closed batch
-- Transfers should sum to original volume (+ shrinkage + converted)
SELECT
  SUM(volume_bbl) as total_moved,
  SUM(shrinkage_bbl) as total_shrinkage,
  SUM(CASE WHEN to_batch_id IS NOT NULL THEN volume_bbl ELSE 0 END) as converted
FROM batch_transfers
WHERE batch_id = '<batch_id>';

-- Schedule entry chain integrity
SELECT stage, volume_bbl, downstream_entry_id, completed_at
FROM batch_schedule_entries
WHERE batch_id = '<batch_id>'
ORDER BY step_order;

-- Cold storage
SELECT variation_id, quantity_on_hand FROM cold_storage_inventory WHERE batch_id = '<batch_id>';

-- Tank assignments
SELECT e.name, bta.assigned_at, bta.released_at
FROM batch_tank_assignments bta JOIN equipment e ON e.id = bta.tank_id
WHERE bta.batch_id = '<batch_id>';
```

---

## Common Errors (Do Not Repeat)

| Error | Correct behavior |
|-------|-----------------|
| Inserting one combined kegging `batch_transfers` row with no `variation_id`/`quantity` | Insert ONE row PER packaging variation with `variation_id`, `quantity`, computed `volume_bbl` |
| Inserting Kegging→Cold Storage `batch_transfers` rows | Do NOT insert these. Cold storage state lives in `cold_storage_inventory` only |
| Using backup CSV tank values without user confirmation | Always get tank confirmation from user — backup had wrong tanks (e.g., Tank 21 instead of Tank 12 for B-023) |
| Using backup CSV conversion path without user confirmation | Backup had multi-hop conversion (Tank 12→23→33); actual was direct (Tank 12→33) |
| Using `transfer_type='transfer'` for kegging rows | Use `'kegging'` or `'canning'` for packaging transfers |
| Seeding `cold_storage_inventory` for batches that went through the live app | Check if records already exist before inserting; live-app batches already have correct CSI rows |
| Creating `batch_tank_assignments` for kegging/canning/cold_storage tanks | Only create for `fermenter`, `brite`, `brewhouse` equipment types |
| Setting `converted_from_batch_id` directly without a `batch_conversions` row | Always insert `batch_conversions` row AND set `converted_from_batch_id` together |
| Using `stage='brewing'` in `batch_schedule_entries` | The check constraint only allows `'brewhouse'` (not `'brewing'`). Valid stages: `'brewhouse'`, `'fermenting'`, `'conditioning'`, `'kegging'`, `'canning'`, `'cold_storage'`, `'planned_conversion'` |
| Inserting a `stage='planned_conversion'` schedule entry for the source batch | Do NOT insert this. The `batch-conversions` route never creates one, so it's dead data — no part of the graph or completeness logic reads it. The conversion node is driven by `batch_conversions` + `brew_batches.converted_from_batch_id` only. |

---

## Correcting a Batch That Was Closed Out Prematurely

A closed batch's ledger sums to exactly its `volume_bbl` (that is what made `batch_exhaustion.is_exhausted` flip). So no correction is ever a single edit: change one number and something else must absorb the difference, or the batch stops balancing and the Volume Breakdown grows a phantom.

Rules learned from the 2026-08-07 B-028 correction:

1. **Physical counts are fixed; shrinkage is the plug.** Keg and case quantities are things a human counted. When volume has to move, move it through `shrinkage_bbl` on the run that emptied the tank — never by inventing or deleting packaged units.
2. **A conversion correction propagates into the child batch.** Reducing a conversion's `volume_bbl` means the child received less, so its `brew_batches.volume_bbl` and `converted_volume_bbl` both drop — and the child's own ledger now over-consumes by the same amount. Absorb it in the child's tank-emptying shrinkage, exactly as in rule 1.
3. **Re-opening a tank means un-cancelling, not re-inserting.** `finalizeConversion` cancels the source's schedule entry and stamps `released_at` on its assignment. To put the batch back in the tank, clear `cancelled_at`/`cancellation_reason` on the existing entry and push `released_at` out to the real empty-out date. `one_active_assignment_per_tank` only bites when `released_at IS NULL`, so confirm no other batch occupied the tank in the reopened window first.
4. **Replay the route's side effects, not just the transfer row.** A kegging run added by hand still owes: one `batch_transfers` row per variation, a `cold_storage_inventory` upsert, a `packaging_items` decrement plus its `packaging_stock_adjustments` row, and one `batch_schedule_entries` row per line (`notes = 'Unscheduled additional kegging'`). Shrinkage splits across lines by the formula above.
5. **Verify against `batch_exhaustion`, not the transfer list.** `remaining_bbl` must land at 0 for every batch you touched, parent and child.

Do the whole thing in one `do $$ ... $$` block so a constraint violation rolls back rather than leaving a half-corrected batch. Record before/after in `audit_log` (`operation` must be `'INSERT'`/`'UPDATE'`/`'DELETE'` — the check constraint rejects anything else) and tag the edited rows' `notes`.

---

## Batches Backfilled (as of 2026-06-27, B-028/B-038 corrected 2026-08-07)

| Batch | Status | Notes |
|-------|--------|-------|
| B-023 (Carolina Wheat Wave, 40 bbl) | ✅ Complete | Brewed 5/14 in B-1 → Tank 12. 30 bbl converted 6/8 to B-030 via Tank 12→Tank 33 direct. 10 bbl moved to Tank 21 for conditioning. Kegged 6/11: 16× ½ keg + 12× ⅙ keg. |
| B-030 (Blackberry Lemon Wheat, 30 bbl) | ✅ Complete | Conversion child of B-023. Tank 33 brite. Kegged 6/11: 33× ½ + 33× ⅙ = 21.997 bbl. Kegged 6/18: 3× ½ + 29× ⅙ = 6.331 bbl, shrinkage 1.672 bbl. Closed. |
| B-021, B-022, B-029 | ✅ Already correct | Live app wrote these; `cold_storage_inventory` and transfers already present and verified. |
| B-028 (Carolina Brown Ale, 40 bbl) | ✅ Complete | **Corrected 2026-08-07 — see below.** Brewed 5/21 in B-1 → Tank 31 (fermenter). Conditioning in same tank (Tank 31) 6/17 → 8/7. Kegged 6/18: 8× ½ keg (4.000 bbl) + 30× ⅙ keg (4.997 bbl). Canned 6/25: 42× 16oz case (4.065 bbl), **no shrinkage**. Converted 7/3: **23.5 bbl** Tank 31 → Tank 33, no shrinkage. Kegged 8/7: 3× ½ keg (1.500 bbl) + 6× ⅙ keg (0.999 bbl), 0.9385 bbl shrinkage — the tank heel that emptied FV 31. |
| B-038 (Pumpkin Ale, 23.5 bbl) | ✅ Complete | Conversion child of B-028, executed 7/3 (Tank 31 → Tank 33, brite). Canned 7/17, kegged 7/20 and 7/22. Its 7/22 kegging shrinkage (0.5025 bbl) is the plug that absorbs the 1 bbl the inbound conversion was corrected down by. |
| B-032 | ⏳ Pending | Brew day 6/5, 20 bbl, Tank 14 fermenter. No transfers inserted yet. Confirm transfer dates with user before inserting. |

---

## Supabase Project

Project ID: `drlsazatrcrdwaihjmex`  
Use the `execute_sql` MCP tool (project `drlsazatrcrdwaihjmex`) for all DB operations.  
All tables are in the `public` schema.
