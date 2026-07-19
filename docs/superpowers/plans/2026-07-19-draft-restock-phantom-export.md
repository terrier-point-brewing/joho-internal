# Draft-restock Phantom Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A draft-restock keg swap always books barrel excise (writing a batch-less "phantom" `export_transactions` row on any cold-storage shortfall) instead of silently dropping the export record, and every phantom raises an acknowledgeable alert with a targeted single-batch reconcile action plus a daily email digest.

**Execution Budget:** Mode = subagent-driven-development (4 locality groups). Spawn cap = 6 (`CLAUDE_SPAWN_CAP` override if exceeded — STOP and report first). Token target ≈ 300k.

**Architecture:** The taproom-only `recordTaproomConsumption` orchestrates two writers — the existing physical `writeColdStorageShipment` (depletes cold storage, batch-attributed) for the covered portion, and a new batch-less `writePhantomExport` for the shortfall (excise only, no depletion). The phantom `export_transactions` row (`is_phantom = true`, `alert_acknowledged_at IS NULL`) doubles as a persisted alert, actioned via a targeted single-batch depletion route. The shared `writeColdStorageShipment` and distribution/contract flows are untouched.

**Tech Stack:** Next.js 16 (App Router, TS), Supabase Postgres (raw SQL migrations), Vitest, `lib/resend.ts` for email. Excise via `computeExciseTaxBreakdown`; BBL constant `BBL_TO_FL_OZ = 3968`.

**Spec:** `docs/superpowers/specs/2026-07-19-draft-restock-phantom-export-design.md`

## Global Constraints

- **UI:** token utilities only (no raw `zinc/amber/red/green/blue/gray`); primitives from `app/components/ui/` (`Badge`, `Modal`, `.btn-*`, `.inp`); see `docs/UI_STANDARD.md`. Alert count mirrors Finance `DataQualityPanel`'s "⚑ N to review".
- **API routes:** parse params with `requireDateRange()`/query helpers where applicable, wrap errors with `apiError()` (`lib/utils/api.ts`); auth via `getSessionUser` (`lib/auth.ts`), manager+ for writes; Supabase admin client in route handlers (never the browser client).
- **Tests:** new/changed `lib/` modules ship co-located `*.test.ts` covering pure logic; keep `lib/` coverage above the `vitest.config.ts` floor. `npm run verify` (lint + typecheck + tests) is the per-task DoD.
- **Migrations:** additive new file only, next sequential after `20260804_tax_bank_account.sql`; never hand-edit existing migrations. Do NOT apply to prod — migrations are human-gated.
- **Money/volume:** `volume_bbl = kegs × total_volume_fl_oz / 3968`; excise from `computeExciseTaxBreakdown(volumeBbl)`. Never flat volume×rate.
- **`is_phantom` is a permanent origin marker** — never flipped back to false, including on reconcile.

## Locality Groups & Models

| Group | Tasks | Locality | Model |
|-------|-------|----------|-------|
| G1 — Schema | 1, 2 | `supabase/migrations/`, cross-cutting `batch_id` consumers | Task 1 Haiku · Task 2 Sonnet |
| G2 — lib/production | 3, 4, 5, 6, 7, 8 | `lib/production/**` + co-located tests | Sonnet |
| G3 — app/api | 9, 10, 11 | `app/api/production/**`, `app/api/cron/**` | Sonnet |
| G4 — UI | 12, 13 | `app/taproom/**`, `app/production/components/**` | Sonnet |

Final whole-branch review: **Opus**, once, after all groups land.

---

## Task Table

| # | Task | Files (primary) | Model |
|---|------|-----------------|-------|
| 1 | Migration: phantom columns + `batch_id` nullable | `supabase/migrations/<next>_export_transactions_phantom.sql` | Haiku |
| 2 | `batch_id`-nullable consumer audit + guards | audit `lib/finance/**`, `lib/reports/**`, `lib/production/**` | Sonnet |
| 3 | `writeExportTransaction`: nullable batch + `isPhantom` | `lib/production/exportTransactionWriter.ts` | Sonnet |
| 4 | `writePhantomExport` module | `lib/production/writePhantomExport.ts` | Sonnet |
| 5 | `recordTaproomConsumption` orchestration | `lib/production/recordTaproomConsumption.ts` | Sonnet |
| 6 | `taproomConsumptionSync` recount gate | `lib/production/taproomConsumptionSync.ts` | Sonnet |
| 7 | `depleteColdStorageInventory` targeted-batch variant | `lib/production/coldStorageDepletion.ts` | Sonnet |
| 8 | `phantomExportAlerts` query/email helpers + `phantomAlertEmail` | `lib/production/phantomExportAlerts.ts`, `lib/production/phantomAlertEmail.ts` | Sonnet |
| 9 | Reconcile + dismiss routes | `app/api/production/taproom-consumption/reconcile-phantom/route.ts`, `.../dismiss-phantom/route.ts` | Sonnet |
| 10 | Open-alerts read endpoint + recipe-keg selector source | `app/api/production/taproom-consumption/phantom-alerts/route.ts`, `app/api/production/recipe-packaging-variations/route.ts` | Sonnet |
| 11 | Cron daily digest wiring | `app/api/cron/taproom-consumption-sync/route.ts` | Sonnet |
| 12 | Selector repoint in Draft Stats | `app/taproom/components/DraftStatsTab.tsx` | Sonnet |
| 13 | Export Bay alert list UI | `app/production/components/ExportBayTab.tsx` | Sonnet |

---

## Task 1: Migration — phantom columns + `batch_id` nullable

**Files:**
- Create: `supabase/migrations/<next>_export_transactions_phantom.sql` (next sequential after `20260804_tax_bank_account.sql`)

**Produces:** `export_transactions.is_phantom boolean NOT NULL DEFAULT false`, `alert_acknowledged_at timestamptz NULL`, `alert_emailed_at timestamptz NULL`; `batch_id` nullable.

**SQL (complete — this is the non-obvious part):**
```sql
alter table public.export_transactions alter column batch_id drop not null;
alter table public.export_transactions
  add column if not exists is_phantom boolean not null default false,
  add column if not exists alert_acknowledged_at timestamptz,
  add column if not exists alert_emailed_at timestamptz;
-- partial index for the open-alert list + digest selection
create index if not exists export_transactions_open_phantom_idx
  on public.export_transactions (created_at)
  where is_phantom and alert_acknowledged_at is null;
```

**Acceptance:**
- [ ] Migration file created with the SQL above.
- [ ] `npx supabase gen types typescript` (or the repo's type-gen command) regenerated types include the three new columns and nullable `batch_id`. If types are checked in, update the generated types file.
- [ ] `npm run verify` passes (typecheck sees new columns).
- [ ] Commit: `feat(db): export_transactions phantom columns + nullable batch_id`.

**Do NOT apply to prod.** Note in the commit body that this migration is human-gated.

---

## Task 2: `batch_id`-nullable consumer audit + guards

**Files:** audit-only across `lib/finance/**`, `lib/reports/**`, `lib/production/**`, `app/api/**`; modify any consumer that would drop phantom rows.

**Context:** `batch_id` was `NOT NULL`; some queries may INNER-JOIN `brew_batches` or assume a non-null `batch_id`, which would silently exclude phantom exports from financials/excise.

**Acceptance:**
- [ ] Grep for `export_transactions` consumers that join `brew_batches` / reference `batch_id`: `rg -n "export_transactions" lib app | rg -i "batch"`. Record each hit and whether it uses an INNER join or assumes non-null.
- [ ] Confirm B-C-710 excise gallon sourcing reads `volume_bbl`/`total_excise_tax_usd` directly (expected safe) — cite the file:line in the commit body.
- [ ] For any consumer that would drop phantom rows via INNER join, switch to LEFT join (or `batch_id`-null-tolerant logic) and add/extend a test asserting a phantom row (null `batch_id`, `is_phantom = true`) is included.
- [ ] Confirm `checkAndCompleteBatch` (`shipmentWriter.ts:140`) is only ever called with a real `batchId` (never for phantom writes) — no change expected, note the confirmation.
- [ ] Write a short findings note in the commit body (which consumers checked, which changed, which safe).
- [ ] `npm run verify` passes. Commit: `fix: keep phantom (null-batch) exports in excise/financials aggregates` (or `chore: audit confirms null-batch exports safe` if no code change).

---

## Task 3: `writeExportTransaction` — nullable batch + `isPhantom`

**Files:**
- Modify: `lib/production/exportTransactionWriter.ts`
- Test: `lib/production/exportTransactionWriter.test.ts` (extend if present, else create)

**Interfaces:**
- Produces: `writeExportTransaction` params gain `batchId: string | null` (was required string) and `isPhantom?: boolean` (default false). Insert sets `batch_id: params.batchId`, `is_phantom: params.isPhantom ?? false`. All other behavior unchanged.

**Acceptance / test cases:**
- [ ] Test: calling with `batchId: null, isPhantom: true` inserts a row with null `batch_id` and `is_phantom = true`, and still writes `export_transaction_taxes` children for the volume.
- [ ] Test: existing physical call (real `batchId`, no `isPhantom`) inserts `is_phantom = false` — byte-for-byte unchanged from today.
- [ ] `volume_bbl` rounding (4 dp) and excise child rows unchanged.
- [ ] `npm run verify` passes. Commit.

---

## Task 4: `writePhantomExport` module

**Files:**
- Create: `lib/production/writePhantomExport.ts`
- Test: `lib/production/writePhantomExport.test.ts`

**Interfaces:**
- Consumes: `writeExportTransaction` (Task 3, nullable batch + `isPhantom`), `BBL_TO_FL_OZ` (`lib/constants/production.ts`), `packaging_variations` row shape.
- Produces:
  ```ts
  export async function writePhantomExport(
    supabase: SupabaseClient,
    params: { shipmentId?: string; recipeId: string; variationId: string;
              quantityKegs: number; sourceRef: string; notes?: string | null },
  ): Promise<{ exportTransactionId: string; shipmentId: string }>
  ```

**Behavior:** fetch the variation (`total_volume_fl_oz`, `container_id`, `name`, `format`); `volume_bbl = quantityKegs * total_volume_fl_oz / BBL_TO_FL_OZ`; create a shipment row when `shipmentId` is absent (mirror how `writeColdStorageShipment` creates its shipment — reuse that helper if one is extractable, else replicate the minimal insert); call `writeExportTransaction` with `batchId: null`, `isPhantom: true`, `allocationId: null`, `channel: 'taproom'`, `status: 'paid'`, `packaging_item_id = variation.container_id`, `variant_label` from the variation, `quantity = quantityKegs`, `volume_bbl`, `source_ref`, `notes`. **No `cold_storage_inventory` write.**

**Acceptance / test cases:**
- [ ] Test: `quantityKegs = 1`, variation `total_volume_fl_oz = 1984` (½ bbl) → `volume_bbl = 0.5`; row has null `batch_id`, `is_phantom = true`, `channel = 'taproom'`, `status = 'paid'`; excise children present.
- [ ] Test: no `shipmentId` passed → a shipment row is created and its id returned.
- [ ] Test: `shipmentId` passed → reuses it, no new shipment.
- [ ] Test: asserts `cold_storage_inventory` is never written (mock/spy).
- [ ] `npm run verify` passes. Commit.

---

## Task 5: `recordTaproomConsumption` orchestration

**Files:**
- Modify: `lib/production/recordTaproomConsumption.ts` (replace the `if (recordable <= 0) return` early-out at line ~52)
- Test: `lib/production/recordTaproomConsumption.test.ts` (extend/create)

**Interfaces:**
- Consumes: `writeColdStorageShipment` (unchanged), `writePhantomExport` (Task 4).
- Produces: same return shape `{ recordedQty, shortfallQty, exportTransactionIds, breaks, warnings }`. `exportTransactionIds` now includes phantom ids.

**Behavior:** after computing `recordable`/`shortfall`:
1. If `recordable > 0` → `writeColdStorageShipment(recordable)`; capture `shipmentId` + physical export ids.
2. If `shortfall > 0` → `writePhantomExport({ shortfall, shipmentId: <physical shipment id or undefined>, recipeId, variationId, sourceRef, notes })`.
3. Return `recordedQty = recordable`, `shortfallQty = shortfall`, `exportTransactionIds = [...physical, ...phantom]`.

**Acceptance / test cases:**
- [ ] Test (zero stock): `available = 0` → no depletion, one phantom export for full `quantity`, `recordedQty = 0`, `shortfallQty = quantity`.
- [ ] Test (partial): `available = 1`, `quantity = 3` → physical export for 1 (depletes), phantom for 2 (no deplete); physical + phantom `volume_bbl` sum to full 3-keg volume.
- [ ] Test (full stock): `available >= quantity` → unchanged, no phantom row written.
- [ ] Test (break-down still applies before phantom): when `applyBreakDown` tops up stock, the topped-up amount is recorded physically and only the true remainder is phantom.
- [ ] `npm run verify` passes. Commit.

---

## Task 6: `taproomConsumptionSync` recount gate

**Files:**
- Modify: `lib/production/taproomConsumptionSync.ts` (recount/shrinkage block, lines ~176-215)
- Test: `lib/production/taproomConsumptionSync.test.ts` (extend/create)

**Behavior:** change the recount gate from `res.recordedQty > EPS && alreadyRecorded === 0` to fire when the unit was newly recorded this run including phantom: `alreadyRecorded === 0 && (res.recordedQty + res.shortfallQty) > EPS`. **Shrinkage capture stays gated on physical `res.recordedQty > EPS`** (no physical inventory moved on a phantom swap). Idempotency (`recordedByRef` summing `quantity` per `source_ref`) is unchanged and now naturally includes phantom quantity.

**Acceptance / test cases:**
- [ ] Test: a phantom-only swap (`recordedQty = 0`, `shortfallQty > 0`, `alreadyRecorded = 0`) still triggers the Square recount call.
- [ ] Test: shrinkage capture does NOT fire for a phantom-only swap.
- [ ] Test: a fully-recorded restock (`recordedByRef` already covers full `quantity` incl. phantom) → delta 0 → skipped, no duplicate write.
- [ ] Test: `short_stock` discrepancy still pushed with `requestedQty`/`recordedQty`/`shortfallQty` when `shortfallQty > EPS`.
- [ ] `npm run verify` passes. Commit. (Confirm the shrinkage default against the real shrinkage logic while implementing; if it must change, note it in the commit body and adjust the test.)

---

## Task 7: `depleteColdStorageInventory` targeted-batch variant

**Files:**
- Modify: `lib/production/coldStorageDepletion.ts`
- Test: `lib/production/coldStorageDepletion.test.ts` (extend/create)

**Interfaces:**
- Produces: `depleteColdStorageInventory` gains an optional `batchId?: string` param. When present, depletion is restricted to that batch's cold-storage lot(s) for the given recipe/variation (instead of oldest-first across all batches). When absent, behavior is exactly as today.

**Acceptance / test cases:**
- [ ] Test: with `batchId` set, only that batch's lot is decremented; other batches' lots untouched.
- [ ] Test: refuses to deplete more than the batch's on-hand (never negative) — returns depleted amount / signals shortfall consistent with the existing contract.
- [ ] Test: without `batchId`, oldest-first behavior byte-for-byte unchanged.
- [ ] `npm run verify` passes. Commit.

---

## Task 8: `phantomExportAlerts` + `phantomAlertEmail` helpers

**Files:**
- Create: `lib/production/phantomExportAlerts.ts`
- Create: `lib/production/phantomAlertEmail.ts`
- Test: `lib/production/phantomExportAlerts.test.ts`

**Interfaces (produces):**
```ts
export interface PhantomAlert {
  exportTransactionId: string; recipeId: string; beerName: string;
  tapNumber: number | null; variationId: string; variationName: string;
  quantityKegs: number; volumeBbl: number; exciseUsd: number; occurredAt: string;
}
export interface EligibleBatch { batchId: string; batchCode: string; onHand: number }

export async function fetchOpenPhantomAlerts(supabase): Promise<PhantomAlert[]>;      // is_phantom && alert_acknowledged_at IS NULL
export async function fetchEligibleBatches(supabase, alert: PhantomAlert): Promise<EligibleBatch[]>; // same recipe, on-hand >= quantityKegs in variation
export async function fetchUnemailedPhantomAlerts(supabase): Promise<PhantomAlert[]>; // ...&& alert_emailed_at IS NULL
export async function markPhantomAlertsEmailed(supabase, ids: string[]): Promise<void>;
export function renderPhantomAlertEmail(alerts: PhantomAlert[]): { subject: string; html: string }; // in phantomAlertEmail.ts
```

**Acceptance / test cases:**
- [ ] Test: `fetchOpenPhantomAlerts` returns only `is_phantom && alert_acknowledged_at IS NULL` rows, joined to beer/tap/variation names.
- [ ] Test: `fetchEligibleBatches` returns only same-recipe batches with on-hand `>= quantityKegs` in the alert's variation; excludes under-stocked batches.
- [ ] Test: `fetchUnemailedPhantomAlerts` additionally requires `alert_emailed_at IS NULL`.
- [ ] Test: `renderPhantomAlertEmail` lists beer/tap/date/kegs/volume/excise; stable subject.
- [ ] `npm run verify` passes. Commit.

---

## Task 9: Reconcile + dismiss routes

**Files:**
- Create: `app/api/production/taproom-consumption/reconcile-phantom/route.ts`
- Create: `app/api/production/taproom-consumption/dismiss-phantom/route.ts`

**Interfaces:**
- Consumes: `depleteColdStorageInventory({ batchId })` (Task 7), `checkAndCompleteBatch`, `getSessionUser`, `apiError`.
- `POST reconcile-phantom` body `{ exportTransactionId: string; batchId: string }`.
- `POST dismiss-phantom` body `{ exportTransactionId: string }`.

**reconcile behavior:** load the phantom export → `recipe_id`, `variation_id`, `quantity`; reject (400) if not `is_phantom` or already acknowledged; validate `batchId` is same recipe and has `>= quantity` on-hand in the variation (else 400); targeted-deplete `quantity` from that batch; set the row's `batch_id = batchId` and `alert_acknowledged_at = now()` (keep `is_phantom = true`); run `checkAndCompleteBatch(batchId)`. No new export/excise.

**dismiss behavior:** set `alert_acknowledged_at = now()`, no depletion; reject if not `is_phantom` or already acknowledged.

**Acceptance:**
- [ ] manager+ role enforced via `getSessionUser`; admin Supabase client.
- [ ] Reconcile happy path: depletes the batch, backfills `batch_id`, acknowledges, `is_phantom` stays true.
- [ ] Reconcile rejects: non-phantom id, already-acknowledged, wrong recipe, insufficient on-hand — each 400 via `apiError`.
- [ ] Dismiss acknowledges without depletion; rejects already-acknowledged.
- [ ] `npm run verify` passes. Commit.

---

## Task 10: Open-alerts read endpoint + recipe-keg selector source

**Files:**
- Create: `app/api/production/taproom-consumption/phantom-alerts/route.ts`
- Modify: `app/api/production/recipe-packaging-variations/route.ts`

**Behavior:**
- `GET phantom-alerts`: returns `{ alerts: (PhantomAlert & { eligibleBatches: EligibleBatch[] })[] }` using `fetchOpenPhantomAlerts` + `fetchEligibleBatches` (Task 8). Admin client, manager+ read.
- `recipe-packaging-variations`: accept an optional `recipe_id` query param (`requireDateRange` not applicable — plain param) and, when present, filter to that recipe. Confirm it returns `total_volume_fl_oz` + `container.type` so the selector can keep kegs only. (If a `recipe_id` filter already exists, no change beyond confirming keg fields — note it.)

**Acceptance:**
- [ ] `phantom-alerts` returns open alerts each with their eligible batches.
- [ ] `recipe-packaging-variations?recipe_id=…` returns only that recipe's active variations incl. keg volume + container type.
- [ ] `npm run verify` passes. Commit.

---

## Task 11: Cron daily digest wiring

**Files:**
- Modify: `app/api/cron/taproom-consumption-sync/route.ts`

**Behavior:** after `runTaproomConsumptionSync`, within the same `runCronJob` wrapper: `fetchUnemailedPhantomAlerts` → if any, `renderPhantomAlertEmail` → `sendEmail` to `ADMIN_EMAIL` (`lib/resend.ts`) → `markPhantomAlertsEmailed(ids)`. Best-effort: email failure must not fail the cron (log + continue), mirroring the tax-tasks pattern.

**Acceptance:**
- [ ] With unemailed phantom alerts present, one digest email is sent and those ids are stamped `alert_emailed_at`.
- [ ] With none, no email sent.
- [ ] Email send failure is swallowed (cron still records success for the sync portion).
- [ ] `npm run verify` passes. Commit.

---

## Task 12: Selector repoint in Draft Stats

**Files:**
- Modify: `app/taproom/components/DraftStatsTab.tsx` (`kegOptionsByRecipe`, lines ~131-145, and the swap `<select>` ~556-586)

**Behavior:** build the swap dropdown from `/api/production/recipe-packaging-variations` (all active keg variations for the tap's recipe) instead of `/api/production/export-bay/inventory`. Keep the cold-storage query for the "(N on hand)" hint only — cross-reference by `variation_id`; when a variation has no on-hand row, show it with no hint (still selectable). `swap_volume_fl_oz` still derived from the selected variation's `total_volume_fl_oz`. "Needs a swap keg" (`needsKeg`) now means "no keg variation configured", independent of stock.

**Acceptance:**
- [ ] A recipe with zero cold-storage stock still shows its keg variation(s) as selectable options.
- [ ] On-hand hint still appears for in-stock variations.
- [ ] Selecting a variation sets `swap_variation_id` + `swap_volume_fl_oz` from coded volume (unchanged behavior).
- [ ] Token utilities / `.inp` classes only; no raw colors.
- [ ] `npm run verify` passes. Commit.

---

## Task 13: Export Bay alert list UI

**Files:**
- Modify: `app/production/components/ExportBayTab.tsx`

**Behavior:** add a "N draft swaps recorded without cold-storage stock" indicator (count from `GET phantom-alerts`), mirroring `DataQualityPanel`'s "⚑ N to review" (hidden / "all reconciled" when zero). Opens a list; each row shows beer / tap / date / kegs / volume, a **batch picker** (`eligibleBatches` from the endpoint), a **Reconcile** button (enabled only when a batch is selected; POST `reconcile-phantom`), and a **Dismiss** button (POST `dismiss-phantom`). Rows with no eligible batch show only Dismiss. Refetch the list + cold-storage inventory on success (invalidate the relevant query keys). Existing ephemeral `short_stock` render in the sync modal is left unchanged.

**Acceptance:**
- [ ] Count indicator reflects open phantom alerts; "all reconciled" state when zero.
- [ ] Reconcile with a selected batch calls the route and removes the row on success; cold-storage inventory query invalidated.
- [ ] Dismiss removes the row on success.
- [ ] Rows without eligible batches disable Reconcile, allow Dismiss.
- [ ] `Badge`/`Modal`/`.btn-*` primitives + token utilities only; no raw colors or hand-rolled buttons.
- [ ] `npm run verify` passes. Commit.

---

## Final Review

After all four groups land: **one Opus whole-branch review** covering the `batch_id`-nullable blast radius (financials/excise parity), the phantom write path (volume/excise correctness, idempotency), reconcile safety (never-negative, recipe/on-hand validation), and UI-standard conformance. Then `finishing-a-development-branch`.

## Self-Review (author)

- **Spec coverage:** Selector (Task 12/10) · phantom write path (3,4,5) · recount gate (6) · schema incl. `alert_emailed_at` (1) · consumer audit (2) · reconcile/dismiss + targeted depletion (7,9) · alert helpers (8) · read endpoint (10) · email digest (11) · alert UI (13). All spec sections mapped.
- **Type consistency:** `writePhantomExport` params/return used identically in Tasks 4→5; `PhantomAlert`/`EligibleBatch` defined in Task 8, consumed in 9/10/13; `depleteColdStorageInventory({ batchId })` defined in 7, consumed in 9.
- **Non-goals honored:** no multi-batch partial reconcile; no nav badge; `writeColdStorageShipment`/distribution flows untouched; `is_phantom` never flipped.
