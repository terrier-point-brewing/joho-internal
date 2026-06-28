# Spec: Batch Conversions Redesign

**Date:** 2026-06-26  
**Status:** Ready for implementation  
**Scope:** `supabase/migrations/`, `lib/production/`, `app/api/production/`, `app/production/components/`

---

## Why

The current system represents a conversion (e.g. Carolina Wheat Wave → Blackberry Lemon Wheat) as a `batch_allocations` row with `channel = 'conversion'` and a `conversion_target_recipe_id`. This is structurally wrong:

- A conversion allocation references only the *recipe* being converted into, not the actual child batch — so it breaks as soon as the child batch exists.
- A `planned_conversion` schedule entry on the source batch encodes the child batch's ID in a JSON `notes` field, which is brittle and hard to query.
- The `CommitmentsTab` invoicing flow gates on `allocation.channel === 'contract_brewing'`, so a conversion-backed commitment never surfaces an invoice.
- The allocation balance bar on the source batch doesn't account for converted BBL correctly once the conversion is separated from allocations.

**The correct model:** a conversion is a *production relationship* between two batches, tracked separately from allocations. Each batch has its own commitments and allocations. The conversion link is a first-class table row.

---

## User workflow (new)

1. **Create Batch A** normally (e.g. Carolina Wheat Wave, 40 BBL). Add its commitments and allocations.
2. **Create Batch B** normally (e.g. Blackberry Lemon Wheat, 8 BBL, sourced from Batch A conversion). Add its own commitments and allocations — at the Blackberry Lemon Wheat deposit rate, accounting for extra conversion ingredients.
3. **In Batch A's equipment schedule**, click **→ Convert** on a fermenting or conditioning node. The `ConvertPanel` opens.
4. In `ConvertPanel`, **select Batch B from a dropdown** of existing planning-status batches (instead of creating a new batch). Specify volume, receiving tank, and planned date. Click **Plan Conversion**.
5. The app creates a `batch_conversions` row linking A → B. Batch A's allocation bar shows a read-only "→ Conversion to Blackberry Lemon Wheat: 8 BBL" row. The flow graph shows a conversion node branching off A's conditioning stage.
6. When the physical conversion happens, the user clicks **Convert** in the Up Next banner (sourced from pending `batch_conversions`). The transfer modal records the conversion transfer. Batch B appears on the floorplan in its conditioning tank. Both schedules close out correctly.

---

## Database

### New table: `batch_conversions`

```sql
create table batch_conversions (
  id                  uuid primary key default gen_random_uuid(),
  source_batch_id     uuid not null references brew_batches(id),
  target_batch_id     uuid not null references brew_batches(id),
  source_equipment_id uuid references equipment(id),   -- tank conversion draws FROM
  volume_bbl          numeric(8,3) not null,            -- planned conversion volume
  planned_date        date,                             -- aligns child batch conditioning start
  converted_at        timestamptz,                      -- null = planned, not null = executed
  notes               text,
  created_at          timestamptz not null default now(),
  unique (source_batch_id, target_batch_id)
);
```

### Columns to DROP

| Table | Column | Reason |
|---|---|---|
| `batch_allocations` | `conversion_target_recipe_id` | Replaced by `batch_conversions.target_batch_id` |
| `batch_schedule_entries` | *(no column drop, but `stage = 'planned_conversion'` rows are migrated away)* | Replaced by `batch_conversions` rows |

### `AllocationChannel` type change

Remove `'conversion'` from the `AllocationChannel` union. Valid channels after: `'taproom' | 'distribution' | 'contract_brewing' | 'safety_stock'`.

### Columns that STAY

- `brew_batches.converted_from_batch_id` — kept as a denormalized FK on child batch; `buildGraphData.ts` reads it to skip brewhouse/fermenting stages. Still set by `ConvertPanel` when linking.
- `batch_transfers.to_batch_id` — kept; the physical conversion transfer still uses this to prevent the volume from being credited back to the source batch's ledger.

### Migration for existing data

1. For each `batch_schedule_entries` row with `stage = 'planned_conversion'`:
   - Parse `notes` JSON to get `child_batch_id` and (optionally) beer name.
   - Insert a `batch_conversions` row: `source_batch_id = entry.batch_id`, `target_batch_id = child_batch_id`, `source_equipment_id = entry.equipment_id`, `volume_bbl = entry.volume_bbl`, `planned_date = entry.planned_start::date`.
   - Delete the `batch_schedule_entries` row.
2. Delete all `batch_allocations` rows where `channel = 'conversion'`. (These are replaced by the `batch_conversions` rows above.)
3. Drop `batch_allocations.conversion_target_recipe_id` column.

---

## API

### New endpoint: `POST /api/production/batch-conversions`

Creates a `batch_conversions` row and links the two batches.

**Request body:**
```ts
{
  source_batch_id:     string;   // uuid
  target_batch_id:     string;   // uuid — must already exist, status = 'planning'
  source_equipment_id: string;   // uuid — which tank the conversion draws from
  volume_bbl:          number;
  planned_date:        string;   // YYYY-MM-DD
  notes?:              string;
}
```

**Side effects:**
1. Insert `batch_conversions` row.
2. PATCH `brew_batches` on `target_batch_id`: set `converted_from_batch_id = source_batch_id` if not already set.
3. If target batch has no existing conditioning schedule entry: create one at `source_equipment_id`'s stage equivalent, using `planned_date` as `planned_start` and `planned_date + defaultDays` as `planned_end`, `volume_bbl` from the conversion.

**Auth:** brewer+

### Modified endpoint: `POST /api/production/transfers` (conversion execution)

When `transfer_type === 'conversion'`, the body must include `to_batch_id`. The route currently accepts this implicitly via the RPC but doesn't explicitly handle the child batch's side effects. Add:

1. After the source transfer is written, write a second `batch_transfers` row on the **target batch**:
   ```ts
   {
     batch_id:      to_batch_id,
     from_tank_id:  null,
     to_tank_id:    <receiving tank id>,
     volume_bbl:    volume_bbl - shrinkage_bbl,
     shrinkage_bbl: 0,
     transfer_type: 'conversion',
   }
   ```
   This seeds the target batch's volume ledger with the actual received amount.

2. Create a `batch_tank_assignments` row for the target batch on the receiving tank.

3. Call `reconcileSchedule` a second time with `batch_id = to_batch_id` and `to_tank_id = receiving_tank_id` to stamp the child batch's conditioning entry with `actual_start`.

4. PATCH `batch_conversions` where `source_batch_id = batch_id AND target_batch_id = to_batch_id`: set `converted_at = now()`.

### Modified endpoint: `GET /api/production/allocations?batch_id=`

No schema change. The response no longer includes `channel = 'conversion'` rows (they've been deleted). The `AllocationManager` reads `batch_conversions` separately.

### New endpoint: `GET /api/production/batch-conversions?source_batch_id=` (or `?target_batch_id=`)

Returns `batch_conversions` rows with joined `brew_batches` on both sides. Used by `AllocationManager` and `buildGraphData`.

---

## Frontend

### `ConvertPanel.tsx` — full rewrite of the form and save logic

**Remove:**
- `beerName` state and field
- `recipeId` state and recipe dropdown
- The `POST /api/production/batches` call (child batch now pre-exists)
- The `planned_conversion` marker creation (the `POST /api/production/batch-schedule` for the source batch)
- The allocation migration block (lines 162–192 in the current file) — Batch B already has its own allocations

**Add:**
- `allBatches: BrewBatch[]` prop (pass from the parent `index.tsx`)
- `targetBatchId` state, with a dropdown of `allBatches.filter(b => b.status === 'planning' && !b.converted_from_batch_id && b.id !== batchId)`, sorted by batch number
- When target batch is selected: auto-fill `volBbl` from `targetBatch.volume_bbl`

**Save logic (new):**
1. Validate: target batch selected, vol > 0, tank selected, dates valid.
2. `POST /api/production/batch-conversions` with `{ source_batch_id, target_batch_id, source_equipment_id: sourceEntry.equipment_id, volume_bbl, planned_date: convertDate, notes }`.
3. Proportionally rescale source batch's downstream un-started entries — same logic as lines 143–158, unchanged.
4. Call `onSaved()` and `onClose()`.

The panel's date fields, tank dropdown, conflict detection, and conflict suggestion logic are all unchanged.

### `buildGraphData.ts`

**Function signature:**
```ts
export function buildGraphData(
  entries: ScheduleEntry[],
  allBatches: BrewBatch[],
  batch: BrewBatch | undefined,
  allTransfers: BatchTransfer[],
  allScheduleEntries: ScheduleEntry[],
  allBatchConversions: BatchConversion[],   // NEW
): { nodes: Node[]; edges: Edge[] }
```

**Replace in `conversionVolumeBySourceEquipmentId` block (lines 244–268):**

Old: scans `active.filter(e => e.stage === 'planned_conversion')` for marker entries, parses JSON notes.

New:
```ts
const pendingConversions = allBatchConversions.filter(
  c => c.source_batch_id === batch.id && !c.converted_at
);
for (const conv of pendingConversions) {
  if (!conv.source_equipment_id) continue;
  conversionVolumeBySourceEquipmentId.set(
    conv.source_equipment_id,
    (conversionVolumeBySourceEquipmentId.get(conv.source_equipment_id) ?? 0) + conv.volume_bbl,
  );
}
```
The executed-transfer path (scanning `allTransfers` for `transfer_type === 'conversion' && to_batch_id`) is unchanged.

**Replace in conversion node rendering block (lines 333–381):**

Old: finds the marker entry by JSON `child_batch_id`, reads `marker.equipment_id` and `marker.volume_bbl`.

New: finds the matching `BatchConversion` record by `target_batch_id === cb.id`, reads `conv.source_equipment_id` and `conv.volume_bbl`.
The actual-transfer path (via `sourceTx`) is unchanged and takes priority when the conversion has been executed.

**Remove:**
```ts
const plannedConvEntries = active.filter(e => e.stage === 'planned_conversion');
```
This variable is no longer referenced anywhere.

### `constants.ts` — `computeBranchPackagingStatus`

**Function signature addition:**
```ts
export function computeBranchPackagingStatus(
  entries: ScheduleEntry[],
  batch?: { id: string },
  allTransfers: ...[],
  batchConversions: BatchConversion[] = [],   // NEW
): BranchPackagingStatus[]
```

**Replace lines 161–164:**

Old:
```ts
const plannedConversionAway = active
  .filter(e => e.stage === 'planned_conversion' && e.equipment_id === ferment.equipment_id)
  .reduce((s, e) => s + Number(e.volume_bbl ?? 0), 0);
```

New:
```ts
const plannedConversionAway = batchConversions
  .filter(c => c.source_batch_id === batch?.id && c.source_equipment_id === ferment.equipment_id && !c.converted_at)
  .reduce((s, c) => s + Number(c.volume_bbl), 0);
```

All callers of `computeBranchPackagingStatus` must pass `batchConversions`.

### `BatchLogTab.tsx` — `AllocationManager`

**Add a `batch_conversions` query:**
```ts
const { data: batchConversions = [] } = useQuery({
  queryKey: ['batch-conversions', batch.id],
  queryFn: () => fetchJson(`/api/production/batch-conversions?source_batch_id=${batch.id}`),
});
```

**Include conversion volume in `totalPct`:**
```ts
const conversionPct = batchConversions.reduce(
  (s, c) => s + (batchVol > 0 ? (Number(c.volume_bbl) / batchVol) * 100 : 0),
  0,
);
// totalPct is now: allocations pct + conversionPct
const totalPct = allocations.reduce((s, a) => s + Number(a.percentage), 0) + conversionPct;
```

**Render conversion rows in the stacked bar** (amber, between the allocation segments and the unallocated remainder):
```tsx
{batchConversions.map(c => {
  const pct = batchVol > 0 ? (c.volume_bbl / batchVol) * 100 : 0;
  return <div key={c.id} style={{ width: `${pct}%`, background: '#f59e0b' }} title={`Conversion: ${pct.toFixed(1)}%`} />;
})}
```

**Render read-only conversion rows in the allocation list** (below the existing allocation rows, before the "+ Add allocation" form):
```tsx
{batchConversions.map(c => (
  <div key={c.id} className="px-3 py-2.5 border-t border-zinc-800/60 flex items-center justify-between gap-3">
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border border-white/5 bg-amber-900/50 text-amber-300">
        Conversion
      </span>
      <span className="text-xs text-amber-400">
        → {c.target_batch?.beer_name ?? 'Unknown batch'}
        {c.target_batch?.batch_number && ` (#${c.target_batch.batch_number})`}
      </span>
      {c.converted_at && (
        <span className="text-[10px] text-emerald-400">Executed</span>
      )}
      {!c.converted_at && c.planned_date && (
        <span className="text-[10px] text-zinc-500">Planned {fmtDate(c.planned_date)}</span>
      )}
    </div>
    <span className="text-xs tabular-nums text-zinc-400 text-right">
      {Number(c.volume_bbl).toFixed(1)} BBL
    </span>
  </div>
))}
```

**Remove from `CHANNEL_OPTIONS`:** `{ value: 'conversion', label: 'Conversion' }`.  
**Remove from `CHANNEL_COLOR`:** `conversion` entry.  
**Remove** `newConversionRecipeId` state, `isConversionChannel`, `conversionRecipeCommitments`, `handleNewConversionRecipeChange`, all conversion-recipe UI in the add-allocation form.

### `BrewStatusTab.tsx` — `openUpNextAction`

The Up Next banner currently checks `e.stage === 'planned_conversion'` (line ~307) to open TransferModal in convert mode. Since those entries no longer exist, add a separate data source:

**Add query:**
```ts
const { data: pendingConversions = [] } = useQuery({
  queryKey: ['pending-batch-conversions'],
  queryFn: () => fetchJson('/api/production/batch-conversions?converted_at=null'),
});
```

**In `upcomingTasks` rendering**, merge pending conversions as synthetic task items (or handle separately in the Up Next banner). Each pending conversion where the source batch is currently in `conv.source_equipment_id` is shown as a "Convert" action item.

**In `openUpNextAction`**, when processing a pending conversion (not a schedule entry):
```ts
const conv = pendingConversions.find(c => c.source_batch_id === batchId && c.source_equipment_id === currentTank.id);
if (conv) {
  const childBatch = batchById[conv.target_batch_id];
  setTransferTankId(currentTank.id);
  setTransferBatchId(conv.source_batch_id);
  setTransferInitialMode('convert');
  setTransferInitialConvert({
    toBatchId: conv.target_batch_id,
    beerName:  childBatch?.beer_name ?? '',
    bbl:       String(conv.volume_bbl),
  });
}
```

### `constants.ts` — `STAGE_LABELS`

Remove: `planned_conversion: 'Conversion'`

### `types.ts`

- Remove `'conversion'` from `AllocationChannel` union.
- Remove `conversion_target_recipe_id` from `BatchAllocation` interface.
- Add new `BatchConversion` interface:
```ts
export interface BatchConversion {
  id:                  string;
  source_batch_id:     string;
  target_batch_id:     string;
  source_equipment_id: string | null;
  volume_bbl:          number;
  planned_date:        string | null;
  converted_at:        string | null;
  notes:               string | null;
  created_at:          string;
  // joined
  target_batch?:  { id: string; beer_name: string; batch_number: string | null };
  source_batch?:  { id: string; beer_name: string; batch_number: string | null };
}
```

---

## What does NOT change

| Thing | Why it stays |
|---|---|
| `brew_batches.converted_from_batch_id` | `buildGraphData.ts` reads this to skip brewhouse/fermenting for child batches. Set by `ConvertPanel` when linking. |
| `batch_transfers.to_batch_id` | Physical conversion ledger — prevents source batch from double-counting volume. |
| `computeTankVolumes` in `volumeLedger.ts` | The `!t.to_batch_id` check at line 44 stays exactly as-is. |
| `→ Convert` button in `nodes.tsx` | Same location, same trigger, same `CONVERTIBLE_STAGES` gate. |
| `ConvertPanel` date/tank/conflict UI | All field layout, conflict detection, and suggestion logic unchanged. |
| Downstream volume rescaling in `ConvertPanel` | Lines 143–158 logic is correct and model-independent. |
| `reconcileSchedule` in transfers route | Source-side handling (draining source tank, closing schedule entry) unchanged. |
| Child batch conditioning entry creation | Still happens in `ConvertPanel` save if the target batch has no existing conditioning entry. |
| Deposit/invoicing on Batch B | Completely unchanged — Batch B has its own `contract_brewing` allocations and invoice flow. |

---

## Checklist for the implementing session

- [ ] Write migration: `batch_conversions` table, drop `conversion_target_recipe_id`, migrate `planned_conversion` entries, delete existing `conversion`-channel allocations
- [ ] New API route: `POST /api/production/batch-conversions`
- [ ] New API route: `GET /api/production/batch-conversions`
- [ ] Modify `POST /api/production/transfers`: dual-write for conversion (child intake transfer + assignment + `reconcileSchedule` second call + stamp `converted_at`)
- [ ] `types.ts`: add `BatchConversion`, update `AllocationChannel`, remove `conversion_target_recipe_id` from `BatchAllocation`
- [ ] `ConvertPanel.tsx`: replace create-batch form with select-existing-batch dropdown; replace `planned_conversion` write with `batch_conversions` POST; remove allocation migration block
- [ ] `buildGraphData.ts`: add `allBatchConversions` param; replace `plannedConvEntries` reads with `batch_conversions` lookup
- [ ] `computeBranchPackagingStatus`: add `batchConversions` param; replace `planned_conversion` filter
- [ ] `AllocationManager` in `BatchLogTab.tsx`: add conversion query; include in `totalPct`; render read-only conversion rows; remove `conversion` channel from add-allocation form
- [ ] `BrewStatusTab.tsx`: source pending conversions from `batch_conversions`; update `openUpNextAction` convert branch
- [ ] `constants.ts`: remove `planned_conversion` from `STAGE_LABELS`
- [ ] Update all callers of `buildGraphData` and `computeBranchPackagingStatus` to pass the new params
- [ ] Update `docs/production-schema.md` to reflect new table
