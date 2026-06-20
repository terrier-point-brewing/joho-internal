# Production Module — Supabase Schema Reference

Supabase project `drlsazatrcrdwaihjmex`. Read this before touching `app/production/**`, `app/api/production/**`, or `lib/production/**`.

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

> Schema may have drifted since this was written — cross-check against `supabase/migrations/` before relying on column names.

## Equipment Types

| Type | Capacity | Holds batch assignment | Status implied |
|---|---|---|---|
| fermenter | Yes | Yes | fermenting |
| brite | Yes | Yes | conditioning |
| brewhouse | Yes | Yes | brewing |
| cold_storage | No | No | archived |
| kegging | No | No | ready_to_package |
| canning | No | No | ready_to_package |

**Auto-status rule**: when a transfer is saved or a batch is assigned, the server looks up the destination equipment type and calls `PATCH /api/production/batches/:id` with the implied status — no manual status editing in the UI.

**Transfer restrictions**: cold storage only reachable from kegging or canning.

**Full transfer + shrinkage**: draw = `batchVol − shrinkage` (balance always zeroes).

## Known Limitations / To Do

1. **Batch current volume** — `brew_batches.volume_bbl` is the original planned volume; in-tank current volume must be inferred from `batch_transfers` history (draw − shrinkage running total).
2. **Combo detection** (`lib/reports`) — misses combos where component price equals standalone price.
3. **Brewery field on recipes** — free text; intended to become dropdown for known contract partners.
4. **`/api/combo-sales`** — legacy route, not wired to any UI report.
5. **Transfer to cold storage** marks batch "archived" — verify this matches the intended workflow for cold-stored packaged product.
