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

Two top-level modules: **Reports** and **Production**. Each is a route under `app/`. Add a new module by creating `app/<module>/page.tsx` and adding one entry to `MODULES` in `app/components/NavBar.tsx`.

```
app/
  layout.tsx / page.tsx / globals.css
  components/NavBar.tsx

  reports/
    page.tsx                        ← report selector, renders active report
    components/
      ReportControls.tsx            ← date range + group-by + run/export
      SortControls.tsx              ← useSort<T> hook + SortTh component
      CocktailSalesReport.tsx
      KegSalesReport.tsx
      TaproomModelReport.tsx
      GiftCardReport.tsx
      ContractBrewingReport.tsx
      DistributionReport.tsx
      BBLTrackerReport.tsx
      ShrinkageReport.tsx

  production/
    page.tsx                        ← 5-tab shell + data loading
    types.ts                        ← all shared TypeScript types
    components/
      shared.tsx                    ← Modal, Field, ModalActions, StatusBadge, BATCH_STATUSES
      BatchLogTab.tsx
      IngredientsTab.tsx
      RecipesTab.tsx
      BrewStatusTab.tsx
      WorkflowsTab.tsx

  api/
    cocktail-sales / keg-sales / taproom-model / gift-cards /
    contract-brewing / distribution / bbl-tracker / shrinkage /
    combo-sales (legacy, kept for compat)

    production/
      batches / batches/[id]
      ingredients / ingredients/[id]
      recipes / recipes/[id]
      stock-adjustments
      tanks / tanks/[id]
      tank-assignments / tank-assignments/[id]
      workflow-templates / workflow-templates/[id]
      batch-workflows / batch-workflows/[id]

lib/
  supabase/client.ts               ← createClient (anon key, server-side only)
  square/
    client.ts                      ← squareGet/Post/GetAll/PostAll
    catalog.ts / orders.ts / customers.ts / refunds.ts / inventory.ts
  constants/categories.ts
  reports/
    combos / cocktails / kegs / taproom-model /
    contract-brewing / distribution / bbl-tracker / shrinkage
```

---

## Reports Module

Category → Report selector. Date range lives in `reports/page.tsx` and is passed as props. All reports have sortable column headers via `SortTh`.

| Category | Reports |
|---|---|
| Net Sales | Taproom Model, Contract Brewing, Distribution |
| Sales | Cocktail Sales, Keg Sales, Gift Card Sales |
| Production | BBL Tracker |
| Inventory | Shrinkage |

Key nuances documented in the original codebase comments — COMBO detection, keg transfers, invoice-order exclusions, etc. See `lib/reports/` for implementation.

---

## Production Module

Supabase-backed. Five tabs: **Batch Log**, **Ingredients**, **Recipes**, **Brew Status**, **Workflows**.

### Supabase Schema

```
brew_batches
  id, beer_name, batch_number (auto: B-001…), planned_brew_date,
  volume_bbl, turns, status, notes, recipe_id, created_at

  status: planning | brewing | fermenting | conditioning | ready_to_package | archived

batch_status_history
  id, batch_id, status, note, changed_at
  → logged automatically on every status change; seeded on batch creation

ingredients
  id, name, supplier, unit, cost_per_unit, stock_quantity, created_at

stock_adjustments
  id, ingredient_id, quantity (signed), type, note, batch_id, created_at
  type: received | used | waste | inventory_count | batch_use

recipes
  id, beer_name, brewery, expected_yield_bbl, steps, notes, created_at

recipe_ingredients
  id, recipe_id, ingredient_id, quantity_per_bbl, created_at

tanks (also used for brewhouses, cold storage, etc.)
  id, name, type, capacity_bbl, grid_row, grid_col, grid_width, grid_height, notes, created_at
  type: fermenter | brite | unitank | serving | brewhouse | cold_storage
  grid_width/height default by type; position set by drag-and-drop

batch_tank_assignments
  id, batch_id, tank_id, assigned_at, released_at (null = currently assigned), notes

workflow_templates
  id, name, description, created_at

workflow_template_steps
  id, template_id, step_order, equipment_id (→ tanks), duration_days, notes, created_at

batch_workflow_steps
  id, batch_id, step_order, equipment_id (→ tanks),
  scheduled_date, completed_at, notes, created_at
```

DB helpers: `adjust_ingredient_stock(p_id, p_delta)` RPC, `set_batch_number()` trigger (auto-generates batch #).

### Tab Behaviour

**Batch Log** — Batches must be created from a recipe. Recipe selection pre-populates beer name and volume. Turns auto-computed (`⌈vol / 20⌉`). Status changes via inline dropdown log to `batch_status_history`. Row expand (▶) shows status timeline.

**Ingredients** — "Adjust" button opens a modal (Received / Used / Waste / Inventory Count). Live preview of resulting stock. Adjustment log at bottom (filterable by ingredient). Creating a batch auto-logs `batch_use` adjustments for all recipe ingredients.

**Recipes** — Ingredient bill in per-BBL quantities with cost rollup. Expected Yield = per-turn yield for 20 BBL brewhouse. Brew Steps field (freetext). Brewery field for contract brewing partner (future: dropdown).

**Brew Status** — 24×16 grid (48px cells) with absolute-positioned equipment cards. Toggle **🔒 Edit Layout** to enter drag mode: ghost preview + collision detection prevent overlaps. Drop equipment on the unplaced tray to un-grid it. In lock mode, assign/release batches from tank cards. Six equipment types with distinct colors and size defaults.

**Workflows** — Two sub-tabs:
- *Equipment Templates*: named sequences of equipment stops with per-step durations and up/down reordering.
- *Batch Workflows*: per-batch vertical timeline. Click a date to edit inline, click the circle to mark complete. "Apply Template" replaces all steps with dates calculated from cumulative template durations.

---

## Square Catalog Category IDs

All in `lib/constants/categories.ts`. Key IDs:

| Category | IDs |
|---|---|
| Draft | `567KQPEBRBZHG7ATHQFRCRWZ`, `DCPYMNVDYNX4JAFI22DMVKLN` |
| Kegs | `FXHTXXAICGRPMGJAHGJZ34MY`, `L47I4EF3LKJOSWUH47C5JNDA` |
| Cans | `Q5BMUOAOCBOUS4JNDRAAXA4Q`, `TSRMBVP2CWAHLZO4DFTXAQ7Q` |
| Cocktails | `IPD6T7FOCCZBXG2HOPOVFB4J`, `UE65PMYDYAA3GZVZZE2QXTEF` |
| Contract Brewing | `CDX2UMLF35B4I3F7ILYLMWMF` |
| Bourbon/Whiskey/Tequila/Rum/Vodka/Gin | see categories.ts |

---

## Known Limitations / Next Steps

1. **Shrinkage chart sparse** — only 2 dates of fl oz data. Populates as staff log weekly counts.
2. **Draft shrinkage** — kegs tracked in whole units. Picks up automatically if Square switches to fl oz.
3. **Combo detection** — misses combos where component price equals combo price.
4. **Brewery field** — currently free text; planned to become a dropdown for contract brewing partners.
5. **Batch dragging on grid** — groundwork laid; dragging batches directly between tanks on the floor view is a future feature.
6. **`/api/combo-sales`** — legacy route kept for backwards compat, not wired to UI.
