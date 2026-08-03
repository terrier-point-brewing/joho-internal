# Square ↔ cold storage inventory sync — spec

**Status:** proposed · **Date:** 2026-08-03

## Purpose

Square's inventory answers one question for the taproom: *what do we have available
to sell, as cans or kegs, through the taproom or through wholesale/distribution?*

Cold storage is the app's record of the same physical goods. This spec defines
which system owns which movement, what has to be built, and what has to be
repaired.

## Ownership model

Each movement is decremented **once**, by whichever system observes it first. The
app does not push decrements Square already applies itself.

| Movement | Cold storage | Square | Sync direction |
|---|---|---|---|
| Packaging run (canning / kegging) | app writes it | knows nothing | **app → Square** (push) |
| Taproom POS sale | from consumption sync | Square decrements at sale | **Square → app** |
| Draft pour | at keg swap | Square decrements draft SKU (fl oz) | **Square → app** |
| Wholesale / distribution invoice | at Export Bay ship | Square decrements at payment | none — each decrements once |
| Contract brewing invoice | at Export Bay ship | fee lines only, no inventory | none |
| Square-native invoice (not via app) | nothing today | Square decrements at payment | **Square → app** (writeback, missing) |
| Waste / adjustments | app writes it | knows nothing | **app → Square** (push) |

Only variations with a live `recipe_square_links` row are in scope. No link, no
push, no writeback — the link *is* the declaration that a SKU is sellable. A new
packaging variation will not reach Square until someone maps it; that is a known
human step.

### Why there is no push on export

An app-generated wholesale/distribution invoice carries real inventory-tracked
product SKUs, so Square decrements itself when the invoice is paid. Cold storage
already decremented at ship. Both move once and stay in step. Adding a push here
would double-count.

Verified: 264 keg units across 23 lines on 10 invoices resolve to mapped keg SKUs
via `invoice_line_items.square_catalog_variation_id`.

**Timing note for the drift view:** between ship and invoice payment, cold storage
is legitimately lower than Square. That window is expected and must not be
reported as drift.

---

## Current state — verified findings

### Cross-cutting defects

| # | Defect |
|---|---|
| X1 | **18 of 108 mapped variation IDs no longer exist in Square** (404). Nothing detects it. |
| X2 | **The catalog mirror never prunes.** `/catalog/list` returns only live objects; sync upserts and never deletes, so `square_catalog_variations` retains ghost rows that read as authoritative. |
| X3 | **A missing count reads as zero.** `counts.get(id) ?? 0` cannot distinguish "Square has no such object" from "Square says empty". |
| X4 | **Writes are never verified.** Only the response error field is checked; Square accepts a physical-count against an unknown object without error. |
| X5 | **Unmapped SKUs fail silently both ways.** An unlinked sale is skipped with no discrepancy; a push to a dead ID is journaled as applied. |
| X6 | **No alerting.** 1,040 no-op writes over nine days, every one recorded as a success. |

### Worked example — Epic Hazy IPA

| Fact | Value |
|---|---|
| Mapped "Regular" variation | `TXAJUNFBKSQZEKXTJGGWXOXE` → **404, deleted** |
| Live "Regular" variation | `GMK2WKODP3P7UWSML6VYGP5X` → **111 cans** |
| Live "Be Like Mike" variation | `YVBLEMILG2JURZZBNLFGOKD4` → 194 cans (mapping correct, ties exactly to cold storage) |
| Cold storage, Regular family | 158 cans (2 loose + 3 four-packs + 6 cases) |
| Taproom sales on the live ID, never recorded | 23 four-packs + 1 single ≈ **93 cans** |

Both ledgers drifted from the same root cause in opposite directions: pushes went
to a dead ID, and sales arrived on an ID with no link row.

### Dead links with stock behind them

| Beer | Packaging | Cold storage |
|---|---|---|
| Epic Hazy IPA | Regular — loose / 4-pack / case | 2 / 3 / 6 |
| Wiggo! IPA | Regular — loose / 6-pack / case | 3 / 2 / 13 |
| Groundhog Imperial Stout | Regular — loose / case | 1 / 1 |

Nine further dead links are draft and keg SKUs for Imperial Pilsner, Spring Bock,
and BBA Groundhog — all at zero stock.

---

## Workstreams

### W1 — Mapping integrity and deletion handling

1. **Mark deletions on sync.** Add `last_seen_at` (and/or `is_deleted`) to
   `square_catalog_variations`. `/catalog/list` returns live objects only, so any
   row not seen in a full sync pass is gone from Square.
2. **Validate links.** A scheduled check resolves every
   `recipe_square_links.square_variation_id` against Square and flags the dead
   ones. Batch via `/catalog/batch-retrieve`.
3. **Set aside, don't delete.** A link whose variation disappeared is flagged for
   re-map and excluded from push/writeback until resolved — consistent with how
   this codebase handles feed-vs-operator conflicts. Never silently drop it.
4. **Surface it.** Dead links appear in the mapping UI
   (`app/settings/catalog`) and on the taproom Inventory tab (W5).
5. **Stop inferring structure from names.** `inventory_unit` and
   `volume_fl_oz_per_unit` are regex guesses off the variation name
   ([catalogUnits.ts](../lib/square/catalogUnits.ts)), not Square data.
   `volume_fl_oz_per_unit` is load-bearing — `pickBaseVariation` uses `== null` to
   identify the stock variation — so a rename in Square silently changes
   behaviour. Square's own `stockable` flag is already synced and is the honest
   signal: on Epic Hazy, `Regular` is `stockable=true` and the pack tiers are
   `stockable=false`. `inventory_unit` has no consumers; delete it or populate it
   from Square.
6. **Handle two variant families per item.** One Square item can carry both
   "Regular" and "Be Like Mike". Disambiguation is by name stem and currently
   returns null on ambiguity, silently skipping the family — it must raise
   instead.
7. One draft link has no catalog mirror row at all; reconcile mirror coverage.

### W2 — Push on production creation (app → Square)

Nothing writes to Square on any cold-storage creation path today.

1. **Own job, not a side effect.** The only push that exists runs inside the
   taproom consumption sync and only for recipes that had a **can sale** that run
   ([taproomConsumptionSync.ts:630](../lib/production/taproomConsumptionSync.ts:630)).
   Production increases never trigger it. Extract it into its own reconciler over
   all mapped keg/can SKUs.
2. **Trigger on:** canning/kegging transfers
   ([transfers/route.ts:629](../app/api/production/transfers/route.ts:629)), pack
   breakdowns ([applyBreakDown.ts](../lib/production/applyBreakDown.ts)), stock
   adjustments, and a periodic sweep as the backstop.
3. **Cover kegs.** 55 keg links have no writeback at all; the reconciler filters
   to container type `can`.
4. **Write absolute counts** (`PHYSICAL_COUNT`) so the push is idempotent and
   immune to whatever Square did on its own.
5. **Verify every write** (fixes X4): re-read after writing, compare, and journal
   `applied` only on a match. Mismatch raises a discrepancy.
6. **Distinguish absent from zero** (fixes X3) before computing any drift.
7. **Surface rounding.** Loose-equivalent totals are rounded to whole cans with a
   warning nothing currently displays.

### W3 — Invoice-driven writeback (Square → app)

App-generated invoices need nothing (see ownership model). The gap is an invoice
created **directly in Square** carrying mapped keg/can SKUs: Square deducts, the
app never hears about it.

1. Nothing implements this today. `writeColdStorageShipment` has exactly three
   callers — Export Bay ship, ship-adhoc, and taproom consumption — none
   invoice-driven.
2. The taproom consumption sync **explicitly excludes invoice orders**
   (`isInvoiceOrder`), so it will never pick them up. That exclusion is correct
   for taproom sales and must stay; the writeback is a separate path.
3. Read from `invoice_line_items.square_catalog_variation_id`, not
   `pos_line_items` — invoice-backed orders are routed to the former.
4. **Only write back invoices with no originating shipment.** An invoice built
   from export transactions already has its cold-storage depletion; writing back
   would double-count. Key off the invoice's link to `export_transactions`.
5. Write through `writeColdStorageShipment` so it lands in the same
   `export_transactions` ledger, with a `source_ref` that makes it idempotent.

### W4 — Taproom sales writeback (Square → app)

This direction exists and works; the mapping layer is what's broken.

1. **Raise a discrepancy for unmapped sales.** `assembleConsumption` currently
   skips them with a bare `continue`
   ([taproomConsumption.ts:156](../lib/square/taproomConsumption.ts:156)). This is
   how ~93 cans of Epic Hazy left the building unrecorded.
2. Same for keg/can links with a null `variation_id`, skipped at
   [taproomConsumption.ts:309](../lib/square/taproomConsumption.ts:309).
3. Both discrepancies surface on the Inventory tab (W5) and in `cron_runs.detail`.

### W5 — Taproom Inventory tab as the drift indicator

**This tab is the primary signal that Square and cold storage have diverged.** It
cannot currently show that, because it never reads Square's keg/can on-hand.

Today ([app/api/taproom/inventory/route.ts](../app/api/taproom/inventory/route.ts))
it returns cold-storage on-hand, draft fl oz from Square sell-through, and the
last 50 `square_inventory_reconciliations` rows. The grid renders cold storage
only, with a one-line "N SKUs adjusted to match cold storage" footnote. Three
problems:

- No Square keg/can figure, so no drift is computable.
- The reconciliation feed is currently 1,040 rows of the same failed write, which
  swamps the last-50 window and reports the failure as a success.
- `buildInventoryGrid` drops unmapped variations by design, so the tab hides
  exactly the rows most likely to be wrong.

Changes:

1. **Fetch Square's on-hand** for every mapped keg/can SKU and carry it into the
   grid alongside cold storage.
2. **Show both numbers and the delta per SKU**, with a clear zero state. Follow
   the reconciliation-column rule in `docs/UI_STANDARD.md`: a variance must
   decompose into the slices that sum to it.
3. **Exclude the ship-to-payment window** from drift, or label it distinctly —
   see the timing note above. A shipped-but-unpaid distribution order is not
   drift.
4. **Show dead links as their own state**, not as zero stock. "Not mapped in
   Square" and "0 on hand" must never render the same.
5. **Show unmapped-sale discrepancies** from W4 — beer that sold with nowhere to
   book it.
6. **Replace the reconciliation footnote** with something honest: last successful
   push per SKU, and any failed or unverified writes. Once W2's verification
   lands, `applied` means the value actually stuck.
7. Keep the tab read-only. Corrections belong in Stock Adjustments, per the
   settings-vs-finance separation.

---

## Data repairs

Decisions taken 2026-08-03.

1. ~~**Re-map all 18 dead links.**~~ **Done 2026-08-03.** All 108 links now
   resolve against Square (verified: 108 alive, 0 dead). Six were re-pointed at
   surviving variations; the remaining twelve were re-pointed after the missing
   Square items were recreated. Note two renames to watch for: Wiggo!'s
   "Regular - 12oz Can" is now "Regular", and BBA Groundhog's draft item is now
   "BBA Groundhog Imperial Stout (Russell's Reserve 8-Year)".
2. ~~**Re-map the retired beers too.**~~ Done in the same pass.
3. **Catalog mirror still needs a sync + prune.** The twelve newly recreated
   variations are not in `square_catalog_variations` (their `catalog_variation_id`
   / `catalog_item_id` FKs are deliberately NULL), and ghost rows for the deleted
   ones remain. Wiggo! is the clearest case: the mirror holds three dead
   variations and is missing two live ones. This is X2 and is the first task of
   W1.
4. **Epic Hazy IPA: Square's 111 is authoritative.** Cold storage is corrected
   down from 158. **Still outstanding.**

   ⚠️ 111 is not reachable by removing whole packages from 2 loose / 3 four-packs
   / 6 cases — 47 cans is neither a whole number of cases nor of available
   four-packs. The correction needs either a pack breakdown first or a decision to
   land on the nearest whole-unit figure. It should go through Stock Adjustments
   with a stated reason, by a person, not by a script.

5. After re-mapping, back out the Epic Hazy sales that were dropped (≈93 cans) or
   accept them as absorbed by the 158 → 111 correction — these are the same beer
   counted twice, so do **not** apply both. Note the three figures do not
   reconcile to one story (158 − 93 = 65, not 111), which is itself a reason to
   count the beer rather than book a derived number.

### The app never writes to the Square catalog

Confirmed 2026-08-03, relevant to how deletions should be handled. The app's only
Square mutations are `POST /orders`, `POST /invoices`, `DELETE /invoices/{id}`
(draft invoices only), and `POST /inventory/changes/batch-create`. Every
`/catalog` call is `squareGetAll("/catalog/list", …)` — read-only. There is no
`batch-upsert`, no `batch-delete`, no `POST /catalog/object`.

Retiring a beer writes `taproom_recipe_settings.is_retired` in Supabase and
nothing else ([retireRecipe.ts](../lib/taproom/retireRecipe.ts)); unmapping a link
deletes the `recipe_square_links` row, not the Square object. So catalog
deletions always originate from a person acting in Square, and the app's job is
to *notice* them — never to mirror them back.

---

## Sequencing

1. **W1 + X3/X4** — mapping integrity, absent-vs-zero, write verification. Every
   other workstream reads or writes through this layer, and all of them fail
   silently when it's stale.
2. **Data repairs** — re-map, then correct Epic Hazy.
3. **W5** — the drift view, so the remaining work is observable while it's built.
4. **W4** — unmapped-sale discrepancies.
5. **W2** — production push, kegs included.
6. **W3** — invoice writeback.

## Open questions

- Does the `stockable` convention hold across every mapped item, or only the ones
  checked? Needs a full pass before W2 relies on it.
- Should the drift view have a tolerance band, or is any non-zero delta worth
  showing?
- Who is notified when a link goes dead — the cron digest, or the tab alone?
