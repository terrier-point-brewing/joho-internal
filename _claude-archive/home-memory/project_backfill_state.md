---
name: project-backfill-state
description: "Current state of the production batch backfill project — which batches are done, what's pending, known patterns per recipe, and completed export shipment backfill."
metadata: 
  node_type: memory
  type: project
  originSessionId: c2db035c-8202-42be-a6d2-aeae7cf4e9b3
---

# Production Batch Backfill State

**Why:** Batches are being backfilled across multiple sessions. This tracks what's done so future sessions don't re-do or skip work.

**How to apply:** Check this before starting any backfill session. Verify DB state with a quick query before trusting this list — it was last updated 2026-06-29.

---

## Confirmed complete (schedule entries + transfers + cold storage + status history + actual dates set)

- B-042 (American Amber Ale): 40 bbl, brewed 4/1, Tank 14 → Tank 24, kegged 5/8 and 6/1. Converted 2 bbl to B-043.
- B-043 (Orange Pilsner): 2 bbl conversion from B-042, Tank 34, kegged 5/8. `converted_from_batch_id` set.
- B-041 (batch that immediately preceded B-045 in the timeline)
- B-046 (Hop Roar IPA): 20 bbl brewed 4/11/2026. Tank 22 (fermenting 4/11→5/5, 24 days) → Tank 33 (conditioning 5/5→5/8, 3 days). Kegging 5/8: 20× ½ keg + 50× ⅙ keg = 18.330 bbl. Shrinkage 1.670 bbl (8.35%) on Tank22→Tank33 transfer. Tank 14 was occupied by B-042 so Tank 22 was used instead. Timeline from B-032 reference.
- B-047 (Vienna Lager): 20 bbl brewed 5/5/2025. Tank 14 fermenting+conditioning (same vessel, lager pattern) 5/5→5/26 / 5/26→5/26. Single kegging run 5/26: 20× ½ keg + 50× ⅙ keg = 18.330 bbl. Shrinkage 1.670 bbl (8.35%) on ½ keg transfer. Brew date backed into from B-039 (21-day fermentation).
- B-044 (Carolina Pale Ale): 20 bbl brewed 4/24/2025. Tank 21 (fermenting 4/24→5/5) → Tank 34 (conditioning 5/5→5/7). Packaging 5/7: kegging (20× ½ + 30× ⅙) + canning (46× 12oz case). Total product 18.337 bbl, shrinkage 1.663 bbl (8.3%). No fermentation shrinkage (CPA pattern). Timeline backed into from B-022 (11-day fermentation, 2-day conditioning).
- B-045 (Epic Hazy IPA): 40 bbl brewed 4/16/2025. Tank 23 (fermenting 4/16→5/6) → Tank 24 (conditioning 5/6→6/1). Packaging: 5/8 kegging (17× ½ + 20× ⅙) + canning (60 cases + 12 loose cans); 6/1 kegging (20× ½ + 3× ¼ + 27× ⅙). Total product 32.934 bbl. Brew date backed into from B-029 timeline (22 days brew→first pack). Brew date derived 4/16, planned_brew_date stored as 4/17 (convention: +1 day).
- B-049 (Coffee Epic): 1 bbl conversion from B-029, received in Tank 21 on 6/23/2026. Same-day conditioning + kegging: 1× ½ keg + 3× ⅙ keg → cold storage. Status: complete. `converted_from_batch_id` set, `batch_conversions.converted_at = 2026-06-23`, bogus brewhouse entry cancelled.

---

## In progress / incomplete

- B-029 (Epic Hazy IPA): 40 bbl brewed 5/27/2026. Tank 23 (fermenting 5/27→6/22) → Tank 24 (conditioning, still active). Packaging runs: 6/18 kegging (9.83 bbl), 6/23 conversion to B-049 (1 bbl), 6/24 canning (2.371 bbl), 6/25 kegging (4 bbl). 18.799 bbl still in Tank 24 — conditioning entry actual_end is null, volume_bbl = 18.799. Status: conditioning. CSI (B-029): 13× ½ keg, 4× ¼ keg, 38× ⅙ keg, 24× 16oz case, 12× 16oz loose can.

---

## Export Shipment Backfill — COMPLETE through inv 000023 + QB 1001/1002 (2026-06-29)

Invoices 000009–000023 fully backfilled into `export_transactions` with FIFO allocation credits and `cold_storage_inventory` depletion.

| Inv | Partner | TXs | Units | BBL | Excise | Status |
|---|---|---|---|---|---|---|
| 000009 | Fortnight (~5/26) | 2 | 10 | 5.0000 | $113.60 | paid |
| 000010 | Argus (~5/29) | 4 | 97 | 16.1088 | $365.99 | paid |
| 000013 | Argus (~6/1) | 4 | 58 | 17.3306 | $393.76 | paid |
| 000014 | Argus (~6/4) | 3 | 90 | 14.3532 | $326.11 | paid |
| 000015 | Fortnight (~6/5) | 3 | 64 | 17.0963 | $388.43 | paid |
| 000016 | Fortnight (~6/12) | 2 | 32 | 16.0000 | $363.52 | paid |
| 000017 | Argus (~6/18) | 2 | 63 | 17.1630 | $389.94 | unpaid |
| 000018 | Fortnight (~6/12) | 4 | 20 | 10.0000 | $227.20 | paid |
| 000019 | Argus (~6/18) | 2 | 64 | 7.7296 | $175.62 | unpaid |
| 000020 | Fortnight (~6/18) | 1 | 8 | 4.0000 | $90.88 | unpaid |
| 000021 | Fortnight (~6/25) | 2 | 8 | 4.0000 | $90.88 | unpaid |
| 000022 | Argus (~6/25) | 4 | 71 | 9.8685 | $224.21 | unpaid |
| 000023 | Fortnight (~6/25) | 3 | 80 | 17.6069 | $400.03 | unpaid |
| QB 1001 | Argus (~5/8) | 11 | 231 | 41.6889 | $947.18 | paid |
| QB 1002 | Argus (~5/8) | 2 | 38 | 8.9975 | $204.42 | paid |

Note: inv 000022 corrected post-session — loose cans 12→8 (0.0484→0.0323 bbl, $1.10→$0.73 excise); B-045 loose can CSI restored at qty 4 then depleted by QB 1001.

**CSI state after all shipments incl. QB 1001/1002 (2026-06-29):**
- B-047 VL: 1×½ Keg, 34×⅙ Keg
- B-046 HRI: 8×½ Keg, 20×⅙ Keg
- B-040 Gose: 15×⅙ Keg, 5×16oz Cases (½ Keg and Cans deleted)
- B-021 MPL: all deleted
- B-028 CBA: 8×⅙ Keg (½ Keg and Case deleted)
- B-042 PYP: 8×½ Keg, 20×⅙ Keg (both allocs partially used)
- B-029 EHI: 15×⅙ Keg, 4×¼ Keg, 4×16oz Cans (½ Keg, Cases, most Cans deleted)
- B-045 EHI: 3×¼ Keg only (½, ⅙, Case, loose all deleted)
- B-022 CPA: all deleted
- B-044 CPA: 4×½ Keg, 10×⅙ Keg (12oz Cases deleted)
- B-043 OP: all deleted
- B-030 BLW: 19×⅙ Keg (½ Keg deleted)
- B-023 CWW: 12×⅙ Keg (½ Keg deleted)
- B-041 BCI: all deleted

**packaging_item_id reference (export_transactions FK → packaging_items):**
- Generic ½ Keg: `b1acfd81` | Generic ⅙ Keg: `64d0ddbb` | Generic ¼ Keg: `a6b1ba4c`
- Fortnight ½ Keg: `294efed2` | Fortnight ⅙ Keg: `a64bfe7b` (for contract_brewing channel)
- EHI 16oz Can: `e310d5a0` (Argus-specific) | CPA 16oz Can: `b7b9fbc2` (Argus-specific)
- Generic 16oz Blank: `8921dfe9` (used for CBA cases, MPL cases, Gose, etc.)
- Rule: use partner-specific can item if one exists in packaging_items; otherwise generic 16oz blank

**Schema pitfalls learned during export backfill:**
- No `export_transaction_excise_taxes` table — excise stored as single `total_excise_tax_usd` on the row
- `packaging_format` allowed values: `'loose'` | `'case'` | `'4-pack'` | `'6-pack'` (NOT 'keg')
- Invoice table is `invoices` (NOT `export_invoices`)
- `status` must be set explicitly: 'paid', 'unpaid', or 'invoice_required' (default)
- Fortnight contract brews (MPL, BCI) use Fortnight-specific variation IDs and packaging_item_ids; Fortnight distribution uses generic ones
- FIFO allocation credit and physical CSI depletion are independent (credit goes to batch owning the allocation; physical depletion is oldest-first regardless)
- `export_transactions.shipment_id` is NOT NULL with NO FK constraint — it is a grouping UUID shared by all TXs of the same invoice. Use `WITH gen_sid AS (SELECT gen_random_uuid() AS sid)` and reference `(SELECT sid FROM gen_sid)` in each TX insert
- `export_transactions.created_at` is the ship date displayed in the app — defaults to NOW() at insert time. For backfills, always UPDATE created_at to match invoice_date after insertion (or set it explicitly in the CTE via `SET created_at = '<date>'::timestamptz`)
- `export_transactions.recipient_id` → FK to `contract_brewing_partners.id` (NOT `export_partners` — that table doesn't exist)
- QB/non-Square invoices: source='quickbooks', square_invoice_id=NULL, status='open' or 'paid' directly (no draft phase); requires `invoice_line_items` insert alongside invoice
- Partner UUIDs: Argus = `ddc85be3-9835-4ba6-9a9a-d71d7109b215` (contract_brewing channel) | Fortnight = `4cb56ba6-ad94-4717-b9d3-974088e92f64` (distribution channel)

---

## Equipment IDs

| Equipment | UUID |
|---|---|
| B-1 (brewhouse) | fa3e8982-663f-416b-8de2-bab0bc8b477e |
| Backlog | d1008695-23cc-4887-bd14-fac1ed60e2ea |
| Tank 14 (fermenter, 40 bbl) | 1f701c58-d8f0-4458-8817-4e71eeb1ce98 |
| Tank 23 (fermenter, 40 bbl) | a59956d9-e33f-42ec-8a74-3e97e782ca88 |
| Tank 24 (brite, 60 bbl) | de573d09-d748-4a55-90ee-318428eded25 |
| Tank 33 (brite, 40 bbl) | 931d2282-29bb-4840-8a2b-7e2565b56ab5 |
| Tank 21 (fermenter, 20 bbl CPA) | 7ce08f14-c87f-4d91-ac78-e419b1b0ef5a |
| Tank 22 (fermenter) | df70232f-e4ab-4ec4-8f70-7b34f31fe905 |
| Tank 34 (brite, 80 bbl) | 7a7595ab-9a05-4e9e-9398-27c98c2d7d42 |
| Canning | 0adaf265-bfb7-45da-88bd-d3da10cfb8ea |
| Kegging | 87da1155-d1a8-41ff-a1a4-dd94715f6027 |

## Packaging variation IDs

| Variation | UUID | fl oz | bbl/unit |
|---|---|---|---|
| 1/2 Keg | ac4f3b17-d827-4e45-a823-ae80eb4dbbbc | 1,984 | 0.5000 |
| 1/4 Keg | b5e96203-15a9-41fb-9314-160ed73c9a87 | 992 | 0.2500 |
| 1/6 Keg | 4ddbce98-7970-44c7-9dc2-97d5e489509c | 661 | 0.1666 |
| 16oz Blank Case (generic) | 19732e1b-ea57-4ea0-b915-0106ff54fa97 | 384 | 0.0968 |
| CBC Carolina Pale Ale - 12oz Printed Can Case | 7467b7ae-bc20-432c-b810-dfbb6041aa45 | 288 | 0.0726 |
| CBC Carolina Pale Ale - 12oz Printed Can (loose) | 4b82627b-e6a6-490b-b50f-ad2628ce1eee | 12 | 0.0030 |
| CBC Epic Hazy IPA - 16oz Printed Can Case | 036084c2-6e65-459e-b1b4-8c7fc9f99d97 | 384 | 0.0968 |
| CBC Epic Hazy IPA - 16oz Printed Can (loose) | d2dad5e5-5918-488c-8b87-a0c426f87ae6 | 16 | 0.0040 |

---

## Recipe patterns

**Epic Hazy IPA**: Always Tank 23 (fermenting) → Tank 24 (conditioning). Brews 40 bbl, loses 4 bbl to fermentation shrinkage, enters Tank 23 as 36 bbl. Tank 24 "keeps getting replenished" across Epic batches.

---

## Workflow per batch

1. Query current brew_batches record for actual volume and any existing data
2. Confirm tank availability (conflict check for each tank)
3. Present volume math + timeline plan — await user confirmation
4. Split loose cans and cases into separate transfer log records
5. INSERT: downstream schedule entry first, then upstream (FK order)
6. SET actual_start/actual_end on all entries = planned dates
7. UPDATE cold_storage_inventory (don't double-INSERT same variation)
8. INSERT batch_status_history with `note` and `changed_at` columns
9. For conversions: UPDATE child batch's converted_from_batch_id
