---
name: feedback-backfill-rules
description: "Hard rules and error-prevention checklist for backfilling production batch records (schedule entries, transfers, cold storage, status history). Every rule below was learned from a real mistake."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c2db035c-8202-42be-a6d2-aeae7cf4e9b3
---

# Batch Backfill Rules

**Why:** Multiple errors required rework across several sessions. Follow this list exactly before every insert.

---

## Valid stage values (check constraint)

`batch_schedule_entries.stage` only accepts:
`'brewhouse'` | `'fermenting'` | `'conditioning'` | `'kegging'` | `'canning'` | `'cold_storage'` | `'planned_conversion'`

**Never use `'packaging'`** — it will violate the check constraint.

---

## brew_batches.status valid values

`'planning'` | `'brewing'` | `'fermenting'` | `'conditioning'` | `'packaging'` | `'complete'`

**Use `'complete'` not `'completed'`** — the check constraint rejects the longer form.

---

## batch_status_history columns

- `note` (singular, NOT `notes`)
- `changed_at` (NOT `created_at`)
- Columns: `id`, `batch_id`, `status`, `note`, `changed_at`, `changed_by`

---

## FK insert order for downstream_entry_id

You cannot UPDATE an existing entry to point to a new entry that doesn't exist yet.
**Always: INSERT the downstream entry first, then UPDATE the upstream entry's `downstream_entry_id`.**

---

## cold_storage_inventory unique constraint

There is a unique index on `(batch_id, variation_id)`. If a batch has two packaging runs of the same variation:
- **UPDATE** `quantity_on_hand` on the existing row (accumulate)
- **INSERT** only rows for truly new variation types

---

## Schedule entry volume_bbl

- `volume_bbl` = product volume only. Never include shrinkage.
- Shrinkage goes on `batch_transfers.shrinkage_bbl`, not on schedule entries.

---

## Same-day packaging entries

Use `planned_start = planned_end` (not planned_start + 1 day). Kegging and canning on the same calendar day both use the same date for both fields.

---

## Conditioning planned_end

Must not close until the batch is fully exhausted by packaging. The planned_end date = the date of the LAST packaging run, not the first.

---

## CRITICAL: actual_start and actual_end MUST be set for completed batches

**How to apply:** Every schedule entry for a completed (backfilled) batch MUST have `actual_start` and `actual_end` set. Use the planned dates as actuals for backfill.

**Why:** `buildGraphData.ts`'s `arrivedVolume()` function fires when `actual_end IS NULL`. It assumes the entry's `volume_bbl` has been reduced to "currently remaining" and adds back all departed transfers to reconstruct the original. For a backfilled entry where `volume_bbl` = original arrived amount, this doubles the displayed volume (e.g. 40 + 40 = 80 bbl). This also causes the conditioning node to show a partial-drain overlay, making the batch look incomplete.

Set actuals = planned for every entry:
```sql
UPDATE batch_schedule_entries SET
  actual_start = planned_start,
  actual_end   = planned_end
WHERE batch_id = '<id>' AND cancelled_at IS NULL;
```

---

## Brew dates must be updated on both batches

For every backfilled batch, update `planned_brew_date` and `expected_delivery_date` in `brew_batches`:
- `planned_brew_date` = actual brew date (or conversion date for converted batches)
- `expected_delivery_date` = date of the LAST packaging run

The DB often has stale placeholder values for these — always explicitly set them during backfill.

---

## Multiple packaging runs to same equipment: shrinkage is date-scoped in code

`buildGraphData.ts` uses date-range filtering to assign shrinkage to the correct kegging/canning entry when there are multiple runs to the same equipment (e.g. two kegging sessions). This requires `actual_start`/`actual_end` to be set on the schedule entry — another reason those fields are mandatory for completed batches.

No data workaround needed; the code handles it correctly once actual dates are set.

---

## Conversion batches: three required writes

1. **Transfer**: `transfer_type = 'conversion'`, `to_batch_id = <child_batch_id>` on the `batch_transfers` row
2. **brew_batches**: set `converted_from_batch_id = <parent_batch_id>` on the child batch (for equipment schedule graph)
3. **batch_conversions**: INSERT a row with `source_batch_id`, `target_batch_id`, `source_equipment_id`, `volume_bbl`, `planned_date`, and `converted_at` set to the conversion date (for allocation plan display)

Without (2), `buildGraphData.ts` cannot find the child batch in its conversion-node rendering loop.
Without (3), the allocation plan shows 0% consumed by the conversion — the conversion is completely invisible to the parent batch's allocation view.

**How to apply:** After inserting a conversion transfer, always also UPDATE the child batch's `converted_from_batch_id`.

---

## Volume math

`volume_bbl = quantity × total_volume_fl_oz / 3968`  (1 bbl = 3,968 fl oz)

Key variation sizes:
- 1/2 keg: 1,984 fl oz → 0.500 bbl/unit
- 1/4 keg: 992 fl oz → 0.250 bbl/unit
- 1/6 keg: 661 fl oz → 0.1666 bbl/unit
- 16oz Blank Case (24 cans): 384 fl oz → 0.0968 bbl/unit

---

## Conflict check formula

Strict inequalities: `planned_start < :end AND planned_end > :start`

Same-day boundaries (start of one = end of other) **never** conflict.

---

## Year to use for backfill dates

All backfill records are in **2026**, not 2025. The system year is 2026. When backing into brew dates from packaging dates like "5/8" or "4/24", always use 2026 unless explicitly told otherwise. Using 2025 was an error caught on B-044, B-045, and B-047.

---

## Pre-insert checklist

Before every batch of inserts, confirm:
1. Volume math verified (quantity × fl_oz / 3968)
2. Conflict check run on B-1, fermenter tank, and brite tank
3. Conditioning planned_end = date of last packaging run
4. Same-day packaging uses same date for planned_start and planned_end
5. Shrinkage is on transfer records only
6. FK order: downstream entry inserted before upstream references it
7. actual_start/actual_end set on all entries (use planned dates)
8. For conversions: child batch has converted_from_batch_id set
9. For second packaging run of same variation: UPDATE cold_storage_inventory, don't INSERT
