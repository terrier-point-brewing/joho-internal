# TPB Square Reports — Handoff

## What This Is

A Next.js 16 app for **Terrier Point Brewing** — custom Square-API reports and a full production-tracking module backed by Supabase. Single location: **Holly Springs Taproom** (`LZ8TH4A632YW0`). Dark mode UI, publicly accessible.

**Live URL:** https://tpb-square-reports.vercel.app  
**Repo:** `/Users/will-liao/Desktop/Coding/Git/tpb-square-reports`  
**Deploy:** `vercel deploy --prod` from repo root

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
- **Square API** `2025-04-16` — called via `fetch`, no SDK
- **Supabase** (`@supabase/supabase-js`) — Postgres for production data; project ID `drlsazatrcrdwaihjmex`
- **Recharts** — Shrinkage chart
- **Vercel** — hosting

---

## Project Structure

```
app/
  layout.tsx / page.tsx / globals.css
  components/NavBar.tsx

  reports/
    page.tsx                        ← report selector + date range
    components/
      ReportControls.tsx / SortControls.tsx
      CocktailSalesReport / KegSalesReport / TaproomModelReport
      GiftCardReport / ContractBrewingReport / DistributionReport
      BBLTrackerReport / ShrinkageReport

  production/
    page.tsx                        ← 6-tab shell, data loaded by useProductionData
    types.ts                        ← all shared TypeScript types
    equipmentMeta.ts                ← EQ map (label, colors, default grid size per type)
    hooks/
      useProductionData.ts          ← all fetch loaders + state (ingredients, batches, tanks…)
      useEquipmentCrud.ts           ← add/edit/delete equipment modal state + handlers
      useTankDragDrop.ts            ← drag-and-drop grid state + handlers
      useBatchAssign.ts             ← assign-batch modal state + handlers
    components/
      shared.tsx                    ← Modal, Field, ModalActions, StatusBadge, constants
      BrewStatusTab.tsx             ← grid view, uses all three hooks + TransferModal
      TransferModal.tsx             ← standalone transfer modal component
      BatchLogTab.tsx               ← batch CRUD + transfer log per batch
      IngredientsTab.tsx            ← ingredient CRUD + stock adjustments + log
      RecipesTab.tsx                ← recipe CRUD + per-BBL ingredient bill
      WorkflowsTab.tsx              ← workflow templates + batch workflow timelines
      PackagingTab.tsx              ← packaging inventory (kegs, cans, lids, etc.)

  api/
    bbl-tracker / cocktail-sales / combo-sales / contract-brewing /
    distribution / gift-cards / keg-sales / shrinkage / taproom-model

    production/
      batches / batches/[id]
      equipment / equipment/[id]        ← renamed from tanks/
      ingredients / ingredients/[id]
      packaging / packaging/[id]
      recipes / recipes/[id]
      stock-adjustments
      tank-assignments / tank-assignments/[id]
      transfers
      workflow-templates / workflow-templates/[id]
      batch-workflows / batch-workflows/[id]

lib/
  supabase/client.ts
  square/client.ts + catalog / orders / customers / refunds / inventory
  constants/categories.ts             ← Square catalog category IDs
  constants/production.ts             ← GALLONS_PER_BBL, BBL_TO_FL_OZ, grid constants
  utils/api.ts                        ← requireDateRange(), apiError()
  utils/formatting.ts                 ← fmt(), cents(), fmtDate/Long/DateTime(), fmtBbl()
  utils/orders.ts                     ← mapDiscountsByUid()
  reports/                            ← report-building logic (bbl-tracker, kegs, etc.)
```

---

## Reports Module

Date range in `reports/page.tsx`. All tables have sortable headers via `SortTh`.

| Category | Reports |
|---|---|
| Net Sales | Taproom Model, Contract Brewing, Distribution |
| Sales | Cocktail Sales, Keg Sales, Gift Card Sales |
| Production | BBL Tracker |
| Inventory | Shrinkage |

All API routes share `requireDateRange` / `apiError` from `lib/utils/api.ts` and `cents` / `fmt` from `lib/utils/formatting.ts`.

---

## Production Module

Supabase project `drlsazatrcrdwaihjmex`. Six tabs: **Brew Status**, **Batch Log**, **Ingredients**, **Recipes**, **Workflows**, **Packaging**.

### Supabase Schema (current)

```
equipment                        ← formerly "tanks"
  id, name, type, capacity_bbl (null for unconstrained types),
  grid_row, grid_col, grid_width, grid_height, notes, created_at
  type CHECK: fermenter | brite | brewhouse | cold_storage | kegging | canning
  constraint name: equipment_type_check
  capacity_bbl is NULL for kegging, canning, cold_storage (no capacity constraint)
  grid position null = unplaced

brew_batches
  id, beer_name, batch_number (auto B-001…), planned_brew_date,
  volume_bbl, turns, status, notes, recipe_id, created_at
  status: planning | brewing | fermenting | conditioning | ready_to_package | archived
  status is AUTO-SET by server side when transfers/assignments happen — do not edit directly

batch_status_history
  id, batch_id, status, note, changed_at

batch_tank_assignments           ← column names kept as tank_id (backward compat)
  id, batch_id, tank_id (→ equipment.id), assigned_at, released_at (null=active), notes
  Assignments are auto-released when a transfer is recorded.
  Only created for capacity-constrained equipment (fermenter, brite, brewhouse).

batch_transfers
  id, batch_id, from_tank_id, to_tank_id (→ equipment.id),
  volume_bbl, shrinkage_bbl, transfer_type, notes,
  kegging_detail (jsonb), canning_detail (jsonb), transferred_at
  transfer_type: transfer | kegging | canning
  Cold storage only reachable as destination from kegging or canning.

ingredients
  id, name, supplier, unit, cost_per_unit, stock_quantity, created_at

stock_adjustments
  id, ingredient_id, quantity (signed), type, note, batch_id,
  cost_per_unit, total_value_change, created_at
  type: received | used | waste | inventory_count | batch_use
  "received" type: purchase_cost in POST body → server computes weighted avg cost,
  updates ingredients.cost_per_unit, stores cost_per_unit + total_value_change on adj row

recipes
  id, beer_name, brewery, expected_yield_bbl, steps, notes, created_at

recipe_ingredients
  id, recipe_id, ingredient_id, quantity_per_bbl, created_at

workflow_templates / workflow_template_steps
  steps: equipment_id (→ equipment.id), step_order, duration_days, notes
  Supabase join: equipment(id,name,type)  ← not tanks(...)

batch_workflow_steps
  id, batch_id, step_order, equipment_id (→ equipment.id),
  scheduled_date, completed_at, notes
  Supabase join: equipment(id,name,type)

packaging_items
  id, type, name, supplier, unit_cost, brewery, volume_fl_oz, can_count, created_at
  type: keg | can | lid | paktech | tray
```

DB helpers:
- `adjust_ingredient_stock(p_id uuid, p_delta numeric)` — RPC for atomic stock updates
- `set_batch_number()` — trigger that auto-assigns `B-001`, `B-002`, …

### Equipment Types

| Type | Capacity | Holds batch assignment | Status implied |
|---|---|---|---|
| fermenter | Yes | Yes | fermenting |
| brite | Yes | Yes | conditioning |
| brewhouse | Yes | Yes | brewing |
| cold_storage | No | No | archived |
| kegging | No | No | ready_to_package |
| canning | No | No | ready_to_package |

**Auto-status rule**: when a transfer is saved or a batch is assigned, the server looks up the destination equipment type and calls `PATCH /api/production/batches/:id` with the implied status — no manual status editing in the UI.

### Brew Status Tab Details

24×16 drag-and-drop grid (48 px cells, 3 px gap). Toggle 🔒 Edit Layout.

- **Lock mode**: Assign button (empty, constrained equipment only) · Transfer button (occupied)
- **Edit mode**: drag to reposition · Edit · Unplace · Del
- Equipment header: name on top line, type badge on second line (both tinted)
- Batch name wraps; volume/capacity shown as `X.X BBL / Y BBL` when both known
- **Transfer restrictions**: cold storage only reachable from kegging or canning
- **Full transfer + shrinkage**: draw = `batchVol − shrinkage` (balance always zeroes)
- On transfer POST: releases old assignment, creates new assignment (if constrained destination), updates batch status

### Batch Log Tab Details

- Expand row shows **Transfer Log** (not status timeline, which is deprecated)
- Status is read-only badge — set automatically by Brew Status actions
- Batch form has no status field; status starts as `planning`

### Ingredients Tab Details

- **Total Value** column = `cost_per_unit × stock_quantity`
- **Received** adjustment: enter purchase cost → server computes weighted avg unit cost, previews before/after unit cost and total value in modal
- **Adjustment Log** columns: Date · Ingredient · Type · Change · Unit Cost · Value Δ · Note · Batch

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

## Known Limitations / To Do

1. **Batch current volume** — `brew_batches.volume_bbl` is the original planned volume; in-tank current volume must be inferred from `batch_transfers` history (draw − shrinkage running total).
2. **Shrinkage chart** — sparse until staff log more weekly physical counts.
3. **Combo detection** — misses combos where component price equals standalone price.
4. **Brewery field on recipes** — free text; intended to become dropdown for known contract partners.
5. **`/api/combo-sales`** — legacy route, not wired to any UI report.
6. **Transfer to cold storage** shows batch as "archived" — verify this matches the intended workflow for cold-stored packaged product.
