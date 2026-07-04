# Allocation Reserve Model & Channel-Aware Shipping Warnings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Export Bay's single hard "exceeds allocation" block with a channel-aware model that (a) treats contract-brewing deposits as hard, pre-paid guarantees and wholesale/distribution as soft reservations, (b) protects deposit guarantees with a produced-vs-guaranteed *reserve* warning, and (c) records over-delivery explicitly instead of inflating an allocation past 100%.

**Background / why:** Contract-brewing partners pay a deposit up front to book a percentage of a batch (e.g. 75% of a planned 20 bbl = 15 bbl "booked"). Shrinkage means the batch never yields the full planned volume, so the *definite* amount owed is `percentage × actual produced` (e.g. 75% × 17 = 12.75 bbl), and the difference is a deposit refund. Because kegging/canning happens incrementally as shipments are needed, we routinely ship before a batch is fully packaged — so we can accidentally ship soft (wholesale/distribution) beer, or over-serve one partner, and strand another partner's guaranteed volume. Wholesale/distribution allocations carry no deposit (confirmed in `lib/production/exportInvoicePreview.ts`: contract invoices bill *service fees* + deposit reconciliation; distribution/wholesale invoices bill *product at catalog price* for whatever actually shipped), so over-allocating them is financially a non-event.

**Architecture:** All allocation math and warning evaluation moves into a pure, Vitest-tested module `lib/production/allocationReserve.ts`. The ship routes and the allocations API consume it; no business logic stays inline in the route handlers. A new preview endpoint lets the Ship modal show warnings *before* committing. Over-delivery is recorded as distinct `export_transactions` rows flagged `over_allocation = true`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, Supabase Postgres, React Query v5, Vitest (pure-function tests).

## Global Constraints

- Business logic lives in `lib/`, not in `app/api/` route handlers — the ship routes call the pure module.
- API route handlers use `requireRole` from `lib/auth.ts`; `createSupabaseServerClient` for DB; `export const dynamic = "force-dynamic"`.
- New/modified `lib/` modules ship with co-located `*.test.ts`; do not drop `lib/` coverage below the `vitest.config.ts` floor.
- Schema changes go in a **new** migration file under `supabase/migrations/`; never edit existing migrations.
- Money/volume formatting via existing helpers; no raw color utilities in UI (token utilities per `docs/UI_STANDARD.md`); reuse `<Badge>`, `<Banner>`, `.btn-*`, `.inp` primitives.
- New query keys registered in `lib/query-keys.ts`.
- Physical cold-storage availability stays a **hard** guard (`getAvailableColdStorageQuantity`); everything new is **advisory** (warnings), never a block.

---

## Domain Model & Definitions

Per **allocation** `i` on batch `b` (channel-tagged):

| Symbol | Name | Definition | Source |
|---|---|---|---|
| `B_i` | Booked | pre-paid deposit volume | `commitments.volume_bbl` (contract only; `null` for soft) |
| `pct_i` | Locked share | percentage of batch | `batch_allocations.percentage` |
| `S_i` | Realizable so far | `pct_i × produced_b` | computed |
| `A_i` | Final entitlement | `pct_i × produced_b` once `batch.status='complete'` | computed (null until complete) |
| `E_i` | Exported | credited shipments to `i` | `export_transactions` |
| `depositBacked` | — | `channel === 'contract_brewing'` | — |

Per **batch** `b`:
- `produced_b` = Σ net packaged volume of kegging/canning transfers. **Decision: use `sum(volume_bbl)` (already net of fill), matching `allocations/route.ts`; do NOT also subtract `shrinkage_bbl`.** Note `commitmentFulfillment.ts` currently subtracts shrinkage — align it to this definition in Task 2 (single source of truth in the pure module).
- `onHand_b` = `produced_b − Σ exported_from_b` (all channels).
- `reservedForContract_b` = `Σ over contract allocations max(0, S_i − E_i)` — beer that must stay put for deposit holders.
- `freeToShip_b` = `max(0, onHand_b − reservedForContract_b)` — genuinely unclaimed surplus.
- `underCovered_b` = `produced_b < Σ B_i (contract)` — production has not yet reached the guaranteed total.

### Warning taxonomy

| Check | Basis | Behavior | Applies to |
|---|---|---|---|
| Physical availability | cold-storage on hand (recipe+variation) | **hard block** (unchanged) | all |
| `guarantee_coverage` | shipment draw vs `freeToShip_b` on drawn batches | **warn** | soft shipments + front-loaded contract |
| `under_production` | `produced_b < Σ B_i` | **warn / badge** | contract batches |
| `over_booked` | contract `E_i + q_i > B_i` | **warn** | contract only |

Soft (wholesale/distribution) shipments get **no** allocation-based cap — only `guarantee_coverage` (protecting *other* partners' deposits) and the physical guard.

### Crediting & recording rules (per shipment, oldest batch first)

1. Credit **contract** allocations first, up to `B_i` (paid obligations).
2. Then soft allocations (advisory; no cap).
3. Any quantity beyond all bookable claims → **over-delivery** rows: `allocation_id = null`, `over_allocation = true`, attributed to the batches the cold-storage FIFO actually drew from. Do **not** inflate the last allocation past its booked amount (the current `ship/route.ts` behavior and the interim warning patch both do this — replace it).

### Completion reconciliation (contract only)

On `batch.status → complete`: `A_i` becomes final. `E_i vs A_i` = over/under **beer** delivered; `B_i − A_i` = shrinkage **refund** owed → feed the existing `app/api/production/allocations/[id]/adjust` deposit-adjust path. `fulfilled` is judged against `A_i` (never `S_i`).

---

## File Map

**New files:**
- `lib/production/allocationReserve.ts` — pure model: per-allocation view, per-batch reserve, warning evaluation, credit/over-delivery planning.
- `lib/production/allocationReserve.test.ts` — Vitest coverage of every formula + warning branch.
- `app/api/production/export-bay/ship/preview/route.ts` — POST; returns warnings for a prospective shipment without committing.
- `supabase/migrations/20260713_export_over_allocation_flag.sql` — adds `export_transactions.over_allocation`.

**Modified files:**
- `app/api/production/export-bay/ship/route.ts` — use the module for crediting, over-delivery rows, and `warnings[]` response (replaces the interim single `warning`).
- `app/api/production/export-bay/ship-adhoc/route.ts` — run the `guarantee_coverage` check (ad-hoc soft shipments can strand deposits too).
- `lib/production/commitmentFulfillment.ts` — use the module's `produced_b` definition; judge fulfillment against `A_i`.
- `app/api/production/allocations/route.ts` — enrich each allocation with `booked_bbl`, `realizable_bbl`, `final_entitlement_bbl`, `deposit_backed`, plus per-batch `reserved_for_contract_bbl` / `free_to_ship_bbl` / `under_covered`.
- `app/production/types.ts` — extend `BatchAllocation` and add `ShipmentWarning`.
- `app/production/components/ExportBayTab.tsx` — Ship modal: preview warnings before submit, render `warnings[]`; allocation cards: booked vs realizable vs final, deposit-backed vs soft, under-production badge.
- `lib/query-keys.ts` — add ship-preview key if cached.

---

## Task 1: Pure allocation/reserve model + tests

**Files:** Create `lib/production/allocationReserve.ts`, `lib/production/allocationReserve.test.ts`

**Interfaces produced (consumed by Tasks 2, 4, 5):**

```ts
export type AllocationChannel = "contract_brewing" | "distribution" | "wholesale" | "safety_stock";

export interface AllocationInput {
  id: string;
  batchId: string;
  channel: AllocationChannel;
  percentage: number;      // 0–100
  bookedBbl: number | null; // commitments.volume_bbl; null for soft
  exportedBbl: number;
}
export interface BatchInput {
  batchId: string;
  producedBbl: number;     // sum(volume_bbl) of kegging/canning, net fill
  status: string;          // brew_batches.status
  allocations: AllocationInput[];
}

export interface AllocationView {
  bookedBbl: number | null;      // B_i
  realizableBbl: number;         // S_i = pct × produced
  finalEntitlementBbl: number | null; // A_i (null until complete)
  exportedBbl: number;           // E_i
  depositBacked: boolean;
  fulfilled: boolean;            // deposit: complete && E>=A ; soft: E>=S (advisory)
}
export interface BatchReserve {
  batchId: string;
  producedBbl: number;
  onHandBbl: number;
  reservedForContractBbl: number;
  freeToShipBbl: number;
  underCovered: boolean;
}
export type ShipmentWarning =
  | { type: "guarantee_coverage"; batchId: string; reservedBbl: number; freeToShipBbl: number; requestedBbl: number }
  | { type: "under_production"; batchId: string; producedBbl: number; guaranteedBbl: number }
  | { type: "over_booked"; allocationId: string; bookedBbl: number; wouldExportBbl: number };

export interface ShipmentPlanInput {
  channel: AllocationChannel;      // channel of THIS shipment
  requestedBbl: number;
  perBatchDrawBbl: { batchId: string; drawBbl: number }[]; // from simulated FIFO depletion
  batches: BatchInput[];           // all batches of the recipe (for reserve math)
  targetAllocationId?: string | null; // contract shipment crediting this allocation
}
export interface ShipmentPlan {
  credits: { allocationId: string | null; bbl: number; overAllocation: boolean }[];
  warnings: ShipmentWarning[];
}
```

- [ ] **Step 1: Implement pure functions**
  - `allocationView(alloc, batch): AllocationView`
  - `batchReserve(batch): BatchReserve`
  - `planShipment(input): ShipmentPlan` — applies crediting rules (contract up to `B`, then soft, then over-delivery bucket) and emits the three warning types.
  - All arithmetic tolerant to floating error (`± 1e-4`), consistent with existing route epsilons.
- [ ] **Step 2: Tests** — cover: soft ship within free-to-ship (no warning); soft ship that dips into contract reserve (`guarantee_coverage`); batch under-produced vs guarantees (`under_production`); contract ship beyond `B` (`over_booked` + over-delivery credit split); fully-packaged batch → `A` set and `fulfilled` gates correctly; multi-batch FIFO draw; zero-produced batch (no NaN); soft channel never emits `over_booked`.
- [ ] **Step 3:** `npm run test` green; coverage not below floor.

## Task 2: Wire ship route + align fulfillment

**Files:** Modify `app/api/production/export-bay/ship/route.ts`, `lib/production/commitmentFulfillment.ts`

- [ ] **Step 1:** Fetch each recipe batch's `produced`, allocations (+ `commitments.volume_bbl`), and exports; build `BatchInput[]`.
- [ ] **Step 2:** Simulate the cold-storage FIFO depletion to get `perBatchDrawBbl` (or run depletion first and use its returned rows), then call `planShipment`.
- [ ] **Step 3:** Write `export_transactions` from `plan.credits` — over-delivery rows get `allocation_id = null`, `over_allocation = true`. Remove the interim "over-credit the last candidate" logic.
- [ ] **Step 4:** Return `{ created, warnings }` (replaces interim single `warning`). Guard `checkAndFulfillCommitment` on non-null allocation (already done).
- [ ] **Step 5:** Align `commitmentFulfillment.ts` to the module's `produced_b` definition and fulfill against `A_i`.
- [ ] **Step 6:** Manual verify via `/verify` skill against a seeded contract batch (early ship, over-ship, soft dip-into-reserve).

## Task 3: Over-allocation schema flag

**Files:** Create `supabase/migrations/20260713_export_over_allocation_flag.sql`

- [ ] **Step 1:** `alter table export_transactions add column if not exists over_allocation boolean not null default false;` + partial index if useful for reporting.
- [ ] **Step 2:** Apply via Supabase MCP `apply_migration` (records history); confirm column present.

## Task 4: Allocations API enrichment

**Files:** Modify `app/api/production/allocations/route.ts`, `app/production/types.ts`

- [ ] **Step 1:** Use `allocationView` + `batchReserve` to add `booked_bbl`, `realizable_bbl` (rename of today's `allocated_bbl`), `final_entitlement_bbl`, `deposit_backed`, and per-batch `reserved_for_contract_bbl` / `free_to_ship_bbl` / `under_covered`. Keep `allocated_bbl` as a deprecated alias for one release to avoid breaking consumers.
- [ ] **Step 2:** Extend `BatchAllocation` type; add `ShipmentWarning` type.

## Task 5: Preview endpoint + Export Bay UI

**Files:** Create `app/api/production/export-bay/ship/preview/route.ts`; modify `ExportBayTab.tsx`, `lib/query-keys.ts`

- [ ] **Step 1:** `POST /ship/preview` — same inputs as ship, returns `{ warnings }` only (no writes), via `planShipment`.
- [ ] **Step 2:** Ship modal — call preview on quantity change (debounced); render `warnings[]` inline (amber `<Banner>`/token utilities) *before* submit; keep submit enabled (advisory). After submit, surface any returned `warnings` then close.
- [ ] **Step 3:** Allocation cards — contract: `E / B booked` primary, muted `≈ S realizable · batch NN%` while packaging, `final A · refund B−A` when complete; soft: `E / planned` advisory, no refund line. Add `under_covered` badge on the recipe/batch header.
- [ ] **Step 4:** Base the `fulfilled` badge on completion + `A` for contract; advisory for soft.

## Task 6: Completion reconciliation → deposit refund (largest; may split to a follow-up)

**Files:** Modify `app/api/production/allocations/[id]/adjust/route.ts` (+ its callers), completion hook in `lib/production/batchCompletion.ts`

- [ ] **Step 1:** On batch `complete`, for each contract allocation compute `A_i`, `E_i − A_i` (over/under beer), `B_i − A_i` (refund).
- [ ] **Step 2:** Propose/record the deposit refund via the existing adjust flow; surface over/under-delivery for review. Do **not** auto-issue refunds — queue for confirmation.
- [ ] **Step 3:** Tests for the reconciliation math in `lib/production/allocationReserve.test.ts`.

---

## Rollout & Safety

- **Backward-compat:** the ship response changes `warning: string | null` → `warnings: ShipmentWarning[]`. Update `ExportBayTab.tsx` in the same PR. No other consumers.
- **No new hard blocks:** every added check is advisory. The only hard guard remains physical cold-storage availability.
- **Order of merge:** Tasks 1–2 (backend correctness) can ship first and independently; 3–5 (schema + UI) next; 6 last. Each task is independently revertable.
- **Data:** Task 3 is additive (nullable-default column) — safe. No backfill needed; historical rows read as `over_allocation = false`.

## Open Decisions (resolve before Task 2)

1. **Coverage granularity:** per-batch (precise, uses simulated FIFO draw) vs recipe-level aggregate (simpler, less precise). Plan assumes **per-batch**; confirm.
2. **`produced_b` definition:** standardize on `sum(volume_bbl)` (net fill, no shrinkage subtraction). Confirm and align `commitmentFulfillment.ts`.
3. **Over-delivery billing:** contract over-delivery beyond `B` — bill as extra product, or absorb? Affects whether over-delivery rows are invoiceable. Default: flag only; finance decides at invoice time.
