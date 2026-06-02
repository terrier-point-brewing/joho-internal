# TPB Square Reports — Handoff

## What This Is

A Next.js 16 app deployed to Vercel that generates custom reports for **Terrier Point Brewing** by hitting the Square API, and manages production tracking via Supabase. Single location: **Holly Springs Taproom** (`LZ8TH4A632YW0`). Dark mode UI, publicly accessible.

**Live URL:** https://tpb-square-reports.vercel.app  
**Repo:** `/Users/will-liao/Desktop/Coding/Git/tpb-square-reports`  
**Deploy:** `vercel deploy --prod` from the repo root

---

## Environment Variables

`.env.local` (local) and Vercel project settings (production).

```
SQUARE_ACCESS_TOKEN=...
SQUARE_LOCATION_ID=LZ8TH4A632YW0
SUPABASE_URL=https://drlsazatrcrdwaihjmex.supabase.co
SUPABASE_ANON_KEY=...
```

---

## Tech Stack

- **Next.js 16.2.6** — App Router, TypeScript, Tailwind v4
- **Square API** `2025-04-16` — called directly via `fetch`, no SDK
- **Supabase** (`@supabase/supabase-js`) — Postgres for production module data
- **Recharts** — Shrinkage report line chart
- **Vercel** — hosting

---

## Project Structure

Two top-level modules: **Reports** and **Production**. Each is a route under `app/`. Add a new module by creating `app/<module>/page.tsx` and one entry in `app/components/NavBar.tsx`.

```
app/
  layout.tsx / page.tsx / globals.css
  components/NavBar.tsx

  reports/
    page.tsx                        ← report selector, renders active report
    components/
      ReportControls.tsx
      SortControls.tsx
      CocktailSalesReport / KegSalesReport / TaproomModelReport
      GiftCardReport / ContractBrewingReport / DistributionReport
      BBLTrackerReport / ShrinkageReport

  production/
    page.tsx                        ← 6-tab shell + data loading
    types.ts                        ← all shared TypeScript types
    components/
      shared.tsx                    ← Modal, Field, ModalActions, StatusBadge
      BrewStatusTab.tsx
      BatchLogTab.tsx
      IngredientsTab.tsx
      RecipesTab.tsx
      WorkflowsTab.tsx
      PackagingTab.tsx

  api/
    cocktail-sales / keg-sales / taproom-model / gift-cards /
    contract-brewing / distribution / bbl-tracker / shrinkage /

    production/
      batches / batches/[id]
      ingredients / ingredients/[id]
      recipes / recipes/[id]
      stock-adjustments
      tanks / tanks/[id]
      tank-assignments / tank-assignments/[id]
      workflow-templates / workflow-templates/[id]
      batch-workflows / batch-workflows/[id]
      packaging / packaging/[id]
      transfers

lib/
  supabase/client.ts
  square/client.ts + catalog / orders / customers / refunds / inventory
  constants/categories.ts
  reports/ (combos / cocktails / kegs / taproom-model / …)
```

---

## Reports Module

Category → report selector. Date range in `reports/page.tsx`. All tables have sortable headers via `SortTh`.

| Category | Reports |
|---|---|
| Net Sales | Taproom Model, Contract Brewing, Distribution |
| Sales | Cocktail Sales, Keg Sales, Gift Card Sales |
| Production | BBL Tracker |
| Inventory | Shrinkage |

---

## Production Module

Supabase-backed. Six tabs (in order): **Brew Status**, **Batch Log**, **Ingredients**, **Recipes**, **Workflows**, **Packaging**.

### Supabase Schema

```
brew_batches
  id, beer_name, batch_number (auto: B-001…), planned_brew_date,
  volume_bbl, turns, status, notes, recipe_id, created_at
  status: planning | brewing | fermenting | conditioning | ready_to_package | archived

batch_status_history
  id, batch_id, status, note, changed_at

ingredients
  id, name, supplier, unit, cost_per_unit, stock_quantity, created_at

stock_adjustments
  id, ingredient_id, quantity (signed), type, note, batch_id, created_at
  type: received | used | waste | inventory_count | batch_use

recipes
  id, beer_name, brewery, expected_yield_bbl, steps, notes, created_at

recipe_ingredients
  id, recipe_id, ingredient_id, quantity_per_bbl, created_at

tanks (equipment — fermenters, brites, brewhouse, packaging lines, etc.)
  id, name, type, capacity_bbl, grid_row, grid_col, grid_width, grid_height, notes, created_at
  type: fermenter | brite | unitank | serving | brewhouse | cold_storage | kegging | canning
  grid position set by drag-and-drop; null = unplaced

batch_tank_assignments
  id, batch_id, tank_id, assigned_at, released_at (null = active), notes

workflow_templates / workflow_template_steps
  templates: id, name, description
  steps: template_id, step_order, equipment_id (→ tanks), duration_days, notes

batch_workflow_steps
  id, batch_id, step_order, equipment_id (→ tanks),
  scheduled_date, completed_at, notes

packaging_items
  id, type, name, supplier, unit_cost, brewery, volume_fl_oz, can_count, created_at
  type: keg | can | lid | paktech | tray
  volume_fl_oz: set for keg and can (1 BBL = 3968 fl oz)
  can_count: set for paktech and tray

batch_transfers
  id, batch_id, from_tank_id, to_tank_id,
  volume_bbl, shrinkage_bbl, transfer_type, notes,
  kegging_detail (jsonb), canning_detail (jsonb), transferred_at
  transfer_type: transfer | kegging | canning
```

DB helpers: `adjust_ingredient_stock(p_id, p_delta)` RPC, `set_batch_number()` trigger.

### Tab Behaviour

**Brew Status** — 24×16 drag-and-drop grid (48px cells). Toggle 🔒 Edit Layout to reposition equipment. In lock mode:
- Empty tanks show **Assign** button
- Occupied tanks show **Transfer** and **Release**
- Transfer modal detects destination type:
  - *Kegging tank*: select keg types from Packaging, quantities → calculates BBL draw (qty × fl_oz / 3968)
  - *Canning tank*: select can/lid/paktech/tray; input cases + loose cans; tray can_count = cans/case → BBL draw
  - *Other tank*: full or partial (BBL) transfer
  - All flows have a shrinkage field and show remaining volume
  - Transfer logged to `batch_transfers`

**Batch Log** — Create from recipe; status changes log to `batch_status_history`. Row expand shows timeline.

**Ingredients** — Adjust stock (received/used/waste/count). Batch creation auto-logs `batch_use` per recipe bill.

**Recipes** — Per-BBL ingredient bill with cost rollup. Brew steps freetext. Brewery = contract partner.

**Workflows** — Single frame with two sections stacked: *Workflow Templates* (named equipment sequences) and *Batch Workflows* (per-batch vertical timeline with "Apply Template").

**Packaging** — Inventory of kegs, cans, lids, PakTechs, and trays. Filter pills by type. Required fields per type:
- Keg / Can: volume in fl oz
- PakTech / Tray: can count
- All: name, supplier, unit cost, brewery

---

## Square Catalog Category IDs

All in `lib/constants/categories.ts`.

| Category | IDs |
|---|---|
| Draft | `567KQPEBRBZHG7ATHQFRCRWZ`, `DCPYMNVDYNX4JAFI22DMVKLN` |
| Kegs | `FXHTXXAICGRPMGJAHGJZ34MY`, `L47I4EF3LKJOSWUH47C5JNDA` |
| Cans | `Q5BMUOAOCBOUS4JNDRAAXA4Q`, `TSRMBVP2CWAHLZO4DFTXAQ7Q` |
| Cocktails | `IPD6T7FOCCZBXG2HOPOVFB4J`, `UE65PMYDYAA3GZVZZE2QXTEF` |
| Contract Brewing | `CDX2UMLF35B4I3F7ILYLMWMF` |

---

## Known Limitations / Next Steps

1. **Shrinkage chart sparse** — only 2 dates of fl oz data; populates as staff log weekly counts.
2. **Batch volume tracking** — `volume_bbl` on `brew_batches` is the original planned volume; current in-tank volume must be inferred from `batch_transfers` history.
3. **Combo detection** — misses combos where component price equals combo price.
4. **Brewery field** — free text; planned to become a dropdown for contract partners.
5. **`/api/combo-sales`** — legacy route kept for backwards compat, not wired to UI.
