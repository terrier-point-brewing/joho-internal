# Cold-Storage Pack Break-Down Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a taproom can-sale needs a lower packaging tier (single) than what's stocked in cold storage (only 4/6-packs or cases), automatically "break down" a higher tier one level at a time, record each break in a dedicated journal, and let the sale deplete normally — so the three parallel format counts stay physically accurate instead of drifting.

**Architecture:** A pure planner (`planBreakDown`) decides the minimal sequence of one-level breaks (case→pack, pack→single) needed to top up the target tier, preferring the smallest available higher tier so sealed cases survive for wholesale. A pure tier-size deriver (`deriveCansEach`) computes cans-per-tier from authoritative volumes and flags format/volume mismatches. An IO layer (`applyBreakDown`) resolves the *can-identity family* (same container+lid+label+partner, differing only by tier), loads on-hand, runs the planner, mutates `cold_storage_inventory`, and writes a `cold_storage_breaks` journal row per break. It's wired into `recordTaproomConsumption` only (the taproom fungible path); wholesale/export shipping is untouched (sealed units never auto-break).

**Tech Stack:** Next.js 16 / TypeScript, Supabase Postgres (raw supabase-js), Vitest.

## Global Constraints

- Business logic lives in `lib/`, never in `app/api/**` or components. Each new `lib/` module ships with a co-located `*.test.ts` covering the pure paths. Do not drop `lib/` coverage below the `vitest.config.ts` floor (lines/statements ≥ 86).
- Schema changes are new migration files in `supabase/migrations/`; never hand-edit existing migrations. Migrations must be idempotent (`if not exists` / guarded).
- Reuse existing modules: deplete via `depleteColdStorageInventory`, resolve pack size from volumes (NOT blindly from `packaging_items.can_count` — see Task 3 rationale). Do not add a parallel ledger — the *sale* still lands in `export_transactions`; only the *break* uses the new journal.
- Can-identity grouping key is the null-safe tuple `(container_id, lid_id, label_id, partner_id)` compared with `IS NOT DISTINCT FROM`. Tier is discriminated by `(format, paktech_id, tray_id)`, which is EXCLUDED from identity.
- Break direction is one level at a time and DOWN only: `case → pack → single`. A case never breaks straight to singles. Never re-bundle (singles never become packs).
- Prefer the smallest available higher tier when breaking (crack a loose pack before a case) to preserve sealed cases for wholesale.
- Breaks are scoped to the taproom consumption path (`recordTaproomConsumption`). `writeColdStorageShipment` for wholesale/distribution/contract channels is NOT modified.
- Idempotency: breaks only fire while covering a real, not-yet-recorded depletion delta (the sync already records `target − already_recorded` per `source_ref`). Break state lives in `cold_storage_inventory` on-hand, so a re-run with a zero delta never re-breaks. The journal's `source_ref` is for trace, not dedup.

**Reference files (read before starting):**
- `lib/production/coldStorageDepletion.ts` + `.test.ts` — the deplete pattern and its stub-based test style (mirror it).
- `lib/production/recordTaproomConsumption.ts` — the wire-in target.
- `lib/production/taproomConsumptionSync.ts` — the idempotent caller; surfaces `short_stock`.
- `lib/production/packagingVariations.ts` — `getUnitsPerPackage`, format/paktech/tray rules.
- `supabase/migrations/20260621_cold_storage_inventory.sql`, `20260712_cold_storage_physical_reconciliation.sql` — table shape + reconciliation precedent.

**Live schema (verified 2026-07-07):**
- `cold_storage_inventory` cols: `id, batch_id, recipe_id, variation_id, quantity_on_hand, source_transfer_id, created_at, updated_at`. Depletion keys on `(recipe_id, variation_id)`, oldest `created_at` first, deletes a row at ≤ 0.0001.
- `packaging_variations` cols include: `id, container_id, lid_id, label_id, partner_id, paktech_id, tray_id, format, total_volume_fl_oz, name`. `format ∈ {loose, 4-pack, 6-pack, case}`. Kegs are `format='loose'` with a keg `container_id` and no pack/case siblings (so they resolve to a 1-tier family → no-op).
- `packaging_items` cols include: `id, type, name, volume_fl_oz, can_count`.

---

### Task 1: `cold_storage_breaks` journal table (migration)

**Files:**
- Create: `supabase/migrations/20260707_cold_storage_breaks.sql`

**Interfaces:**
- Produces: table `public.cold_storage_breaks` consumed by Task 4's writer.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260707_cold_storage_breaks.sql`:

```sql
-- Cold-storage pack break-down journal.
--
-- A "break" is an INTERNAL cold-storage reformatting, not a shipment: a sealed
-- case is cracked into packs, or a pack into singles, so a taproom single sale
-- can be fulfilled from packaged stock. Nothing leaves cold storage and no
-- packaging is consumed (that cost was booked at production), so a break must
-- NOT land in export_transactions (outbound ledger) or batch_transfers
-- (production inbound — would inflate produced-volume). It gets its own journal.
--
-- Invariant: every break conserves cans — from_units * (to_units/from_units)
-- cans in == cans out. to_units = cans_per(from_variation) / cans_per(to_variation)
-- target-tier units produced per broken parent. Breaks are one level at a time
-- (case→pack→single) and stay within a single batch (a cracked B-040 case yields
-- B-040 packs), preserving batch attribution.

create table if not exists public.cold_storage_breaks (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid not null references public.brew_batches(id) on delete cascade,
  recipe_id          uuid references public.recipes(id) on delete set null,
  from_variation_id  uuid not null references public.packaging_variations(id) on delete restrict,
  to_variation_id    uuid not null references public.packaging_variations(id) on delete restrict,
  from_units         numeric not null,   -- parent units cracked (1 per break op)
  to_units           numeric not null,   -- child units produced per op (cans_from/cans_to)
  source_ref         text,               -- triggering sale's idempotency/trace key; null for manual breaks
  occurred_at        timestamptz not null default now(),
  created_at         timestamptz not null default now()
);

create index if not exists cold_storage_breaks_batch_idx
  on public.cold_storage_breaks(batch_id);
create index if not exists cold_storage_breaks_source_ref_idx
  on public.cold_storage_breaks(source_ref)
  where source_ref is not null;
```

- [ ] **Step 2: Verify SQL parses / applies cleanly against a scratch branch**

Run (do NOT touch prod; use a Supabase dev branch or local): apply the file and confirm the table + indexes exist.
Expected: `cold_storage_breaks` present with the 9 columns above; re-applying is a no-op (all `if not exists`).

> Prod application follows the repo rule: orchestrator applies to live prod only after explicit user OK + backup snapshot. Do not apply to prod in this task.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260707_cold_storage_breaks.sql
git commit -m "feat(cold-storage): add cold_storage_breaks journal table"
```

---

### Task 2: Pure break planner `planBreakDown`

**Files:**
- Create: `lib/production/coldStorageBreak.ts`
- Test: `lib/production/coldStorageBreak.test.ts`

**Interfaces:**
- Produces:
  - `interface Tier { variationId: string; format: string; cansEach: number; onHand: number }`
  - `interface BreakOp { fromVariationId: string; toVariationId: string; fromUnits: number; toUnits: number }`
  - `interface BreakPlan { ops: BreakOp[]; resultingOnHand: Record<string, number>; shortfall: number }`
  - `function planBreakDown(input: { tiers: Tier[]; targetVariationId: string; needed: number }): BreakPlan`
- Consumed by: Task 4 (`applyBreakDown`).

- [ ] **Step 1: Write the failing test**

Create `lib/production/coldStorageBreak.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { planBreakDown, type Tier } from "./coldStorageBreak";

// 16oz family: single=1 can, 4-pack=4, case=24.
const fam = (single: number, pack: number, kase: number): Tier[] => [
  { variationId: "single", format: "loose", cansEach: 1, onHand: single },
  { variationId: "pack", format: "4-pack", cansEach: 4, onHand: pack },
  { variationId: "case", format: "case", cansEach: 24, onHand: kase },
];

describe("planBreakDown", () => {
  it("no-ops when the target tier already covers the need", () => {
    const p = planBreakDown({ tiers: fam(5, 0, 0), targetVariationId: "single", needed: 3 });
    expect(p.ops).toEqual([]);
    expect(p.shortfall).toBe(0);
    expect(p.resultingOnHand.single).toBe(5);
  });

  it("cracks one 4-pack to cover a single sale, leaving the remainder loose", () => {
    const p = planBreakDown({ tiers: fam(0, 1, 0), targetVariationId: "single", needed: 3 });
    expect(p.ops).toEqual([{ fromVariationId: "pack", toVariationId: "single", fromUnits: 1, toUnits: 4 }]);
    expect(p.resultingOnHand.single).toBe(4); // 1 leftover after the eventual 3-can sale
    expect(p.shortfall).toBe(0);
  });

  it("prefers cracking a loose pack over a sealed case (protects wholesale cases)", () => {
    const p = planBreakDown({ tiers: fam(0, 1, 2), targetVariationId: "single", needed: 2 });
    expect(p.ops).toEqual([{ fromVariationId: "pack", toVariationId: "single", fromUnits: 1, toUnits: 4 }]);
    expect(p.resultingOnHand.case).toBe(2); // cases untouched
  });

  it("cascades case->pack->single when no loose packs exist (case never breaks straight to singles)", () => {
    const p = planBreakDown({ tiers: fam(0, 0, 1), targetVariationId: "single", needed: 3 });
    expect(p.ops).toEqual([
      { fromVariationId: "case", toVariationId: "pack", fromUnits: 1, toUnits: 6 },
      { fromVariationId: "pack", toVariationId: "single", fromUnits: 1, toUnits: 4 },
    ]);
    expect(p.resultingOnHand.case).toBe(0);
    expect(p.resultingOnHand.pack).toBe(5); // 6 produced - 1 cracked
    expect(p.resultingOnHand.single).toBe(4);
    expect(p.shortfall).toBe(0);
  });

  it("breaks a case into packs to fulfill a 4-pack sale", () => {
    const p = planBreakDown({ tiers: fam(0, 0, 1), targetVariationId: "pack", needed: 2 });
    expect(p.ops).toEqual([{ fromVariationId: "case", toVariationId: "pack", fromUnits: 1, toUnits: 6 }]);
    expect(p.resultingOnHand.pack).toBe(6);
  });

  it("reports a shortfall when even all higher tiers can't cover the need", () => {
    const p = planBreakDown({ tiers: fam(0, 1, 0), targetVariationId: "single", needed: 10 });
    // 1 pack -> 4 singles, still short 6.
    expect(p.ops).toEqual([{ fromVariationId: "pack", toVariationId: "single", fromUnits: 1, toUnits: 4 }]);
    expect(p.shortfall).toBe(6);
  });

  it("handles a 6-pack family (case=24 -> 4 six-packs, six-pack -> 6 singles)", () => {
    const sixFam: Tier[] = [
      { variationId: "s", format: "loose", cansEach: 1, onHand: 0 },
      { variationId: "p", format: "6-pack", cansEach: 6, onHand: 0 },
      { variationId: "c", format: "case", cansEach: 24, onHand: 1 },
    ];
    const p = planBreakDown({ tiers: sixFam, targetVariationId: "s", needed: 5 });
    expect(p.ops).toEqual([
      { fromVariationId: "c", toVariationId: "p", fromUnits: 1, toUnits: 4 },
      { fromVariationId: "p", toVariationId: "s", fromUnits: 1, toUnits: 6 },
    ]);
    expect(p.resultingOnHand.s).toBe(6);
    expect(p.shortfall).toBe(0);
  });

  it("throws when the target variation is not among the tiers", () => {
    expect(() => planBreakDown({ tiers: fam(0, 0, 0), targetVariationId: "ghost", needed: 1 }))
      .toThrow(/not in tiers/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- coldStorageBreak`
Expected: FAIL — `Cannot find module './coldStorageBreak'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/production/coldStorageBreak.ts`:

```ts
// lib/production/coldStorageBreak.ts
//
// Pure planner for cold-storage pack break-downs. Given the can-identity family's
// tiers (single < pack < case) with current on-hand and cans-per-tier, decide the
// minimal sequence of ONE-LEVEL breaks needed to raise the target tier's on-hand
// to `needed`. Greedy + smallest-first: always crack the LOWEST higher tier that
// has stock, so sealed cases survive for wholesale, and a case only breaks into
// packs (never straight to singles). No IO — callers supply the loaded state.

export interface Tier {
  variationId: string;
  format: string;   // 'loose' | '4-pack' | '6-pack' | 'case'
  cansEach: number; // cans in one unit of this tier (single=1, pack=4|6, case=24)
  onHand: number;   // current cold-storage units of this tier
}

export interface BreakOp {
  fromVariationId: string; // the tier cracked (parent)
  toVariationId: string;   // the tier produced, one level down (child)
  fromUnits: number;       // always 1 (one parent per op)
  toUnits: number;         // children produced = cansEach[parent] / cansEach[child]
}

export interface BreakPlan {
  ops: BreakOp[];
  resultingOnHand: Record<string, number>; // variationId -> units after breaks
  shortfall: number;                        // target units still uncovered
}

const EPS = 1e-9;
const MAX_ITERS = 100_000;

export function planBreakDown(input: { tiers: Tier[]; targetVariationId: string; needed: number }): BreakPlan {
  const { targetVariationId, needed } = input;
  const sorted = [...input.tiers].sort((a, b) => a.cansEach - b.cansEach);

  const onHand: Record<string, number> = {};
  for (const t of sorted) onHand[t.variationId] = t.onHand;

  const targetIndex = sorted.findIndex((t) => t.variationId === targetVariationId);
  if (targetIndex === -1) throw new Error(`planBreakDown: target variation ${targetVariationId} not in tiers`);

  const ops: BreakOp[] = [];
  let guard = 0;
  while (onHand[targetVariationId] < needed - EPS) {
    if (++guard > MAX_ITERS) throw new Error("planBreakDown: did not converge");

    // Lowest tier strictly above the target that has at least one unit on hand.
    let src = -1;
    for (let i = targetIndex + 1; i < sorted.length; i++) {
      if (onHand[sorted[i].variationId] >= 1 - EPS) { src = i; break; }
    }
    if (src === -1) break; // nothing left to crack -> shortfall

    const parent = sorted[src];
    const child = sorted[src - 1]; // exactly one level down
    const toUnits = parent.cansEach / child.cansEach;
    onHand[parent.variationId] -= 1;
    onHand[child.variationId] += toUnits;
    ops.push({ fromVariationId: parent.variationId, toVariationId: child.variationId, fromUnits: 1, toUnits });
  }

  const shortfall = Math.max(0, needed - onHand[targetVariationId]);
  return { ops, resultingOnHand: onHand, shortfall };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- coldStorageBreak`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/production/coldStorageBreak.ts lib/production/coldStorageBreak.test.ts
git commit -m "feat(cold-storage): pure planBreakDown for one-level pack break-downs"
```

---

### Task 3: Pure tier-size deriver `deriveCansEach` (units validation)

**Files:**
- Modify: `lib/production/coldStorageBreak.ts` (append)
- Test: `lib/production/coldStorageBreak.test.ts` (append)

**Interfaces:**
- Consumes: nothing from other tasks (pure).
- Produces:
  - `interface FamilyVariation { variationId: string; format: string; totalVolumeFlOz: number }`
  - `interface DerivedTier { variationId: string; format: string; cansEach: number }`
  - `function deriveCansEach(input: { variations: FamilyVariation[] }): { tiers: DerivedTier[]; warnings: string[] }`
- Consumed by: Task 4.

Rationale: pack size is derived from authoritative volume (`total_volume_fl_oz ÷ base-can volume`), NOT `packaging_items.can_count`, because a single PakTech row is shared across 4-pack and 6-pack variations (verified: 12oz 6-Pack and 16oz 4-Pack share `paktech_id`), so `can_count` can't distinguish them. The deriver additionally cross-checks the volume-derived count against the count implied by `format` (`4-pack`→4, `6-pack`→6) and emits a warning on mismatch — this catches the known 12oz "6-Pack" data bug (its volume is 48 fl oz = 4×12oz, not 6).

- [ ] **Step 1: Write the failing test (append to `coldStorageBreak.test.ts`)**

```ts
import { deriveCansEach } from "./coldStorageBreak";

describe("deriveCansEach", () => {
  const v = (variationId: string, format: string, totalVolumeFlOz: number) => ({ variationId, format, totalVolumeFlOz });

  it("derives cans-per-tier from volume relative to the loose can", () => {
    const { tiers, warnings } = deriveCansEach({ variations: [
      v("single", "loose", 16), v("pack", "4-pack", 64), v("case", "case", 384),
    ] });
    expect(tiers).toEqual([
      { variationId: "single", format: "loose", cansEach: 1 },
      { variationId: "pack", format: "4-pack", cansEach: 4 },
      { variationId: "case", format: "case", cansEach: 24 },
    ]);
    expect(warnings).toEqual([]);
  });

  it("derives a 6-pack family correctly when volume agrees with format", () => {
    const { tiers, warnings } = deriveCansEach({ variations: [
      v("s", "loose", 12), v("p", "6-pack", 72), v("c", "case", 288),
    ] });
    expect(tiers.find((t) => t.variationId === "p")!.cansEach).toBe(6);
    expect(warnings).toEqual([]);
  });

  it("warns when a pack's volume disagrees with the count implied by its format", () => {
    // 12oz '6-pack' whose volume is 48 (=4 cans), not 72 — the known data bug.
    const { tiers, warnings } = deriveCansEach({ variations: [
      v("s", "loose", 12), v("p", "6-pack", 48),
    ] });
    expect(tiers.find((t) => t.variationId === "p")!.cansEach).toBe(4); // volume is authoritative
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/6-pack/);
    expect(warnings[0]).toMatch(/expected 6/);
  });

  it("throws when there is no loose base-can variation to normalize against", () => {
    expect(() => deriveCansEach({ variations: [v("p", "4-pack", 64)] }))
      .toThrow(/no loose/i);
  });

  it("warns when a derived can count is not a whole number", () => {
    const { warnings } = deriveCansEach({ variations: [
      v("s", "loose", 16), v("pack", "4-pack", 70), // 70/16 = 4.375
    ] });
    expect(warnings.some((w) => /whole number/i.test(w))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- coldStorageBreak`
Expected: FAIL — `deriveCansEach is not a function`.

- [ ] **Step 3: Append implementation to `lib/production/coldStorageBreak.ts`**

```ts
// ── Tier-size derivation (units validation) ──────────────────────────────────

export interface FamilyVariation {
  variationId: string;
  format: string;           // 'loose' | '4-pack' | '6-pack' | 'case'
  totalVolumeFlOz: number;
}

export interface DerivedTier {
  variationId: string;
  format: string;
  cansEach: number;
}

// Whole cans a format is DEFINED to hold, for cross-checking against volume.
// 'case' sizes vary, so it has no fixed expectation — volume is trusted.
const FORMAT_EXPECTED_CANS: Record<string, number> = { loose: 1, "4-pack": 4, "6-pack": 6 };

/**
 * Derive cans-per-tier from authoritative volumes (each tier's total_volume_fl_oz
 * divided by the loose base can's volume). Emits warnings when a derived count is
 * non-integer or disagrees with the count its `format` implies — surfacing packaging
 * data bugs (e.g. a '6-pack' whose volume is really 4 cans) without trusting the
 * shared paktech/tray can_count.
 */
export function deriveCansEach(input: { variations: FamilyVariation[] }): { tiers: DerivedTier[]; warnings: string[] } {
  const base = input.variations.find((v) => v.format === "loose");
  if (!base) throw new Error("deriveCansEach: family has no loose base-can variation to normalize against");
  const baseVol = base.totalVolumeFlOz;
  if (!(baseVol > 0)) throw new Error("deriveCansEach: loose base-can volume must be positive");

  const warnings: string[] = [];
  const tiers: DerivedTier[] = input.variations.map((v) => {
    const raw = v.totalVolumeFlOz / baseVol;
    const cansEach = Math.round(raw);
    if (Math.abs(raw - cansEach) > 1e-6) {
      warnings.push(`${v.format} variation ${v.variationId}: volume-derived can count ${raw.toFixed(3)} is not a whole number`);
    }
    const expected = FORMAT_EXPECTED_CANS[v.format];
    if (expected !== undefined && cansEach !== expected) {
      warnings.push(`${v.format} variation ${v.variationId}: volume implies ${cansEach} cans, expected ${expected} for format '${v.format}'`);
    }
    return { variationId: v.variationId, format: v.format, cansEach };
  });

  return { tiers, warnings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- coldStorageBreak`
Expected: PASS (all Task 2 + Task 3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/production/coldStorageBreak.ts lib/production/coldStorageBreak.test.ts
git commit -m "feat(cold-storage): deriveCansEach with format/volume mismatch validation"
```

---

### Task 4: IO break executor `applyBreakDown`

**Files:**
- Create: `lib/production/applyBreakDown.ts`
- Test: `lib/production/applyBreakDown.test.ts`

**Interfaces:**
- Consumes: `planBreakDown`, `deriveCansEach`, `Tier` (Task 2/3).
- Produces:
  - `interface AppliedBreak { batchId: string; fromVariationId: string; toVariationId: string; toUnits: number }`
  - `interface ApplyBreakResult { applied: AppliedBreak[]; shortfall: number; warnings: string[] }`
  - `async function applyBreakDown(supabase, params: { recipeId: string; variationId: string; needed: number; sourceRef?: string | null }): Promise<ApplyBreakResult>`
- Consumed by: Task 5 (`recordTaproomConsumption`).

Behavior:
1. Load the target variation's identity columns (`container_id, lid_id, label_id, partner_id`).
2. Fetch sibling variations where identity `IS NOT DISTINCT FROM` the target's (via an RPC-free approach: fetch candidates by `container_id` then filter the remaining three columns in JS with null-safe equality — `container_id` is indexed and narrows hard; the JS filter enforces the full tuple). Keep only `format ∈ {loose,4-pack,6-pack,case}`.
3. If fewer than 2 tiers (e.g. kegs, or a can with no higher tier), return `{ applied: [], shortfall: 0, warnings: [] }` — nothing to break; the caller's own availability check handles any shortfall.
4. `deriveCansEach` → tiers + warnings.
5. Load on-hand per sibling variation for this recipe from `cold_storage_inventory` (sum `quantity_on_hand`), keeping oldest-row-per-variation for batch selection.
6. `planBreakDown`.
7. Execute each op in order, within a single batch: take the oldest `cold_storage_inventory` row of `fromVariationId` (for this recipe) → its `batch_id = B`; decrement it by 1 (delete at ≤ 0.0001); upsert `(batch_id=B, recipe_id, variation_id=toVariationId)` adding `toUnits`; insert a `cold_storage_breaks` row `{batch_id: B, recipe_id, from_variation_id, to_variation_id, from_units: 1, to_units, source_ref}`.
8. Return applied ops + `plan.shortfall` + warnings.

- [ ] **Step 1: Write the failing test**

Create `lib/production/applyBreakDown.test.ts` (stub client in the style of `coldStorageDepletion.test.ts`, recording writes):

```ts
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyBreakDown } from "./applyBreakDown";

// ── Fake Supabase covering exactly the calls applyBreakDown makes ────────────
// Tables:
//  packaging_variations: identity lookup (.eq(id).single) + family fetch (.eq(container_id))
//  cold_storage_inventory: on-hand read (.eq(recipe_id).in(variation_id) ... ) + oldest row
//    (.eq(recipe_id).eq(variation_id).order(created_at).limit(1)) + update/delete/insert
//  cold_storage_breaks: insert
interface CsiRow { id: string; batch_id: string; recipe_id: string; variation_id: string; quantity_on_hand: number; created_at: string }

function makeClient(opts: {
  target: { id: string; container_id: string; lid_id: string | null; label_id: string | null; partner_id: string | null };
  family: Array<{ id: string; format: string; total_volume_fl_oz: number; container_id: string; lid_id: string | null; label_id: string | null; partner_id: string | null }>;
  csi: CsiRow[];
}) {
  const csi = opts.csi.map((r) => ({ ...r }));
  const effects: Array<Record<string, unknown>> = [];

  const from = (table: string): any => {
    if (table === "packaging_variations") {
      const q: any = { _filters: {} };
      q.select = () => q;
      q.eq = (col: string, val: unknown) => { q._filters[col] = val; return q; };
      q.single = async () => {
        // identity lookup by id
        if (q._filters.id) {
          const t = opts.target;
          return { data: { container_id: t.container_id, lid_id: t.lid_id, label_id: t.label_id, partner_id: t.partner_id }, error: null };
        }
        return { data: null, error: null };
      };
      // family fetch: .select().eq('container_id', x) awaited directly
      q.then = (res: (v: { data: unknown; error: unknown }) => unknown) => {
        const rows = opts.family.filter((f) => f.container_id === q._filters.container_id);
        return Promise.resolve({ data: rows, error: null }).then(res);
      };
      return q;
    }
    if (table === "cold_storage_inventory") {
      const q: any = { _f: {}, _mode: "read", _order: false, _limit: 0, _payload: undefined as unknown };
      q.select = () => q;
      q.insert = (payload: unknown) => { effects.push({ table, op: "insert", payload }); q._mode = "insert"; return Promise.resolve({ error: null }); };
      q.update = (payload: { quantity_on_hand: number }) => { q._mode = "update"; q._payload = payload; return q; };
      q.delete = () => { q._mode = "delete"; return q; };
      q.eq = (col: string, val: unknown) => {
        if (q._mode === "update") {
          const row = csi.find((r) => r.id === val); if (row) row.quantity_on_hand = (q._payload as any).quantity_on_hand;
          effects.push({ table, op: "update", id: val, quantity_on_hand: (q._payload as any).quantity_on_hand });
          return Promise.resolve({ error: null });
        }
        if (q._mode === "delete") {
          const i = csi.findIndex((r) => r.id === val); if (i >= 0) csi.splice(i, 1);
          effects.push({ table, op: "delete", id: val });
          return Promise.resolve({ error: null });
        }
        q._f[col] = val; return q;
      };
      q.in = (col: string, vals: unknown[]) => { q._f[col] = vals; return q; };
      q.order = () => { q._order = true; return q; };
      q.limit = (n: number) => { q._limit = n; return q; };
      q.then = (res: (v: { data: unknown; error: unknown }) => unknown) => {
        let rows = csi.filter((r) => r.recipe_id === q._f.recipe_id);
        if (Array.isArray(q._f.variation_id)) rows = rows.filter((r) => (q._f.variation_id as string[]).includes(r.variation_id));
        else if (q._f.variation_id) rows = rows.filter((r) => r.variation_id === q._f.variation_id);
        if (q._order) rows = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
        if (q._limit) rows = rows.slice(0, q._limit);
        return Promise.resolve({ data: rows, error: null }).then(res);
      };
      return q;
    }
    if (table === "cold_storage_breaks") {
      return { insert: (payload: unknown) => { effects.push({ table, op: "insert", payload }); return Promise.resolve({ error: null }); } };
    }
    throw new Error(`unexpected table ${table}`);
  };

  return { client: { from } as unknown as SupabaseClient, effects, csi };
}

const ID = { single: "v-single", pack: "v-pack", case: "v-case" };
const family16 = [
  { id: ID.single, format: "loose", total_volume_fl_oz: 16, container_id: "can16", lid_id: "lid", label_id: "lbl", partner_id: "cbc" },
  { id: ID.pack, format: "4-pack", total_volume_fl_oz: 64, container_id: "can16", lid_id: "lid", label_id: "lbl", partner_id: "cbc" },
  { id: ID.case, format: "case", total_volume_fl_oz: 384, container_id: "can16", lid_id: "lid", label_id: "lbl", partner_id: "cbc" },
];
const target = { id: ID.single, container_id: "can16", lid_id: "lid", label_id: "lbl", partner_id: "cbc" };

describe("applyBreakDown", () => {
  it("cracks a 4-pack into singles within its batch and journals the break", async () => {
    const { client, effects, csi } = makeClient({
      target, family: family16,
      csi: [{ id: "row-pack", batch_id: "B-040", recipe_id: "r1", variation_id: ID.pack, quantity_on_hand: 1, created_at: "2026-01-01" }],
    });
    const res = await applyBreakDown(client, { recipeId: "r1", variationId: ID.single, needed: 3, sourceRef: "sqsale:x:2026-07-07" });

    expect(res.shortfall).toBe(0);
    expect(res.applied).toEqual([{ batchId: "B-040", fromVariationId: ID.pack, toVariationId: ID.single, toUnits: 4 }]);
    // pack row fully consumed -> deleted; single row created with +4 in batch B-040
    expect(effects).toContainEqual({ table: "cold_storage_inventory", op: "delete", id: "row-pack" });
    expect(effects).toContainEqual({ table: "cold_storage_inventory", op: "insert", payload: expect.objectContaining({ batch_id: "B-040", recipe_id: "r1", variation_id: ID.single, quantity_on_hand: 4 }) });
    expect(effects).toContainEqual({ table: "cold_storage_breaks", op: "insert", payload: expect.objectContaining({ batch_id: "B-040", from_variation_id: ID.pack, to_variation_id: ID.single, from_units: 1, to_units: 4, source_ref: "sqsale:x:2026-07-07" }) });
    // final on-hand: single=4, pack=0
    expect(csi.find((r) => r.variation_id === ID.single)?.quantity_on_hand ?? (csi.length ? undefined : 4)).toBeDefined();
  });

  it("no-ops for a keg (single-tier family, no higher tier)", async () => {
    const { client, effects } = makeClient({
      target: { id: "keg", container_id: "keg16", lid_id: null, label_id: null, partner_id: "cbc" },
      family: [{ id: "keg", format: "loose", total_volume_fl_oz: 660, container_id: "keg16", lid_id: null, label_id: null, partner_id: "cbc" }],
      csi: [],
    });
    const res = await applyBreakDown(client, { recipeId: "r1", variationId: "keg", needed: 5, sourceRef: null });
    expect(res.applied).toEqual([]);
    expect(res.shortfall).toBe(0);
    expect(effects).toEqual([]);
  });

  it("cascades case->pack->single, journaling two breaks, and reports leftover shortfall honestly", async () => {
    const { client, effects } = makeClient({
      target, family: family16,
      csi: [{ id: "row-case", batch_id: "B-040", recipe_id: "r1", variation_id: ID.case, quantity_on_hand: 1, created_at: "2026-01-01" }],
    });
    const res = await applyBreakDown(client, { recipeId: "r1", variationId: ID.single, needed: 3, sourceRef: null });
    expect(res.applied).toEqual([
      { batchId: "B-040", fromVariationId: ID.case, toVariationId: ID.pack, toUnits: 6 },
      { batchId: "B-040", fromVariationId: ID.pack, toVariationId: ID.single, toUnits: 4 },
    ]);
    expect(res.shortfall).toBe(0);
    expect(effects.filter((e) => e.table === "cold_storage_breaks")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- applyBreakDown`
Expected: FAIL — `Cannot find module './applyBreakDown'`.

- [ ] **Step 3: Write the implementation**

Create `lib/production/applyBreakDown.ts`:

```ts
// lib/production/applyBreakDown.ts
//
// IO layer for cold-storage pack break-downs. Resolves the target variation's
// can-identity family (same container + lid + label + partner, differing only by
// tier), tops up the target tier by cracking higher tiers per planBreakDown, and
// journals each break to cold_storage_breaks. Breaks stay within a single batch so
// attribution is preserved. Scoped to the taproom fungible path — the caller
// (recordTaproomConsumption) invokes this only when the target tier is short.

import type { SupabaseClient } from "@supabase/supabase-js";
import { planBreakDown, deriveCansEach, type Tier } from "./coldStorageBreak";

export interface AppliedBreak {
  batchId: string;
  fromVariationId: string;
  toVariationId: string;
  toUnits: number;
}

export interface ApplyBreakResult {
  applied: AppliedBreak[];
  shortfall: number;
  warnings: string[];
}

const CAN_FORMATS = new Set(["loose", "4-pack", "6-pack", "case"]);
const DUST = 1e-4;

const nullSafeEq = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

export async function applyBreakDown(
  supabase: SupabaseClient,
  params: { recipeId: string; variationId: string; needed: number; sourceRef?: string | null },
): Promise<ApplyBreakResult> {
  const { recipeId, variationId, needed } = params;
  const sourceRef = params.sourceRef ?? null;

  // 1. Target identity.
  const { data: target, error: tErr } = await supabase
    .from("packaging_variations")
    .select("container_id, lid_id, label_id, partner_id")
    .eq("id", variationId)
    .single();
  if (tErr) throw new Error(tErr.message);
  if (!target) return { applied: [], shortfall: 0, warnings: [] };

  // 2. Candidate siblings by (indexed) container_id, then full null-safe identity in JS.
  const { data: candidates, error: cErr } = await supabase
    .from("packaging_variations")
    .select("id, format, total_volume_fl_oz, container_id, lid_id, label_id, partner_id")
    .eq("container_id", target.container_id);
  if (cErr) throw new Error(cErr.message);

  const family = (candidates ?? []).filter(
    (v) =>
      CAN_FORMATS.has(v.format) &&
      nullSafeEq(v.lid_id, target.lid_id) &&
      nullSafeEq(v.label_id, target.label_id) &&
      nullSafeEq(v.partner_id, target.partner_id),
  );

  // 3. No higher tier to break -> nothing to do (kegs, or a can with only its own tier).
  if (family.length < 2) return { applied: [], shortfall: 0, warnings: [] };

  // 4. Tier sizes from volume (+ validation warnings).
  const { tiers: derived, warnings } = deriveCansEach({
    variations: family.map((v) => ({ variationId: v.id, format: v.format, totalVolumeFlOz: Number(v.total_volume_fl_oz) })),
  });

  // 5. Current on-hand per tier for this recipe.
  const varIds = derived.map((t) => t.variationId);
  const { data: onHandRows, error: ohErr } = await supabase
    .from("cold_storage_inventory")
    .select("variation_id, quantity_on_hand")
    .eq("recipe_id", recipeId)
    .in("variation_id", varIds);
  if (ohErr) throw new Error(ohErr.message);
  const onHandByVar = new Map<string, number>();
  for (const r of onHandRows ?? []) onHandByVar.set(r.variation_id, (onHandByVar.get(r.variation_id) ?? 0) + Number(r.quantity_on_hand));

  const tiers: Tier[] = derived.map((t) => ({ ...t, onHand: onHandByVar.get(t.variationId) ?? 0 }));

  // 6. Plan.
  const plan = planBreakDown({ tiers, targetVariationId: variationId, needed });

  // 7. Execute each op within a single batch.
  const applied: AppliedBreak[] = [];
  for (const op of plan.ops) {
    // Oldest cold-storage row of the parent tier for this recipe -> its batch.
    const { data: srcRows, error: sErr } = await supabase
      .from("cold_storage_inventory")
      .select("id, batch_id, quantity_on_hand, created_at")
      .eq("recipe_id", recipeId)
      .eq("variation_id", op.fromVariationId)
      .order("created_at", { ascending: true })
      .limit(1);
    if (sErr) throw new Error(sErr.message);
    const srcRow = (srcRows ?? [])[0];
    if (!srcRow) continue; // raced away since planning; skip (caller re-checks availability)
    const batchId = srcRow.batch_id;

    // Decrement one parent unit (delete at dust).
    const remaining = Number(srcRow.quantity_on_hand) - 1;
    if (remaining <= DUST) {
      const { error } = await supabase.from("cold_storage_inventory").delete().eq("id", srcRow.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from("cold_storage_inventory")
        .update({ quantity_on_hand: remaining, updated_at: new Date().toISOString() }).eq("id", srcRow.id);
      if (error) throw new Error(error.message);
    }

    // Add child units to the SAME batch's child row (create if missing).
    const { data: childRows, error: chErr } = await supabase
      .from("cold_storage_inventory")
      .select("id, quantity_on_hand")
      .eq("recipe_id", recipeId)
      .eq("variation_id", op.toVariationId)
      .eq("batch_id", batchId)
      .limit(1);
    if (chErr) throw new Error(chErr.message);
    const childRow = (childRows ?? [])[0];
    if (childRow) {
      const { error } = await supabase.from("cold_storage_inventory")
        .update({ quantity_on_hand: Number(childRow.quantity_on_hand) + op.toUnits, updated_at: new Date().toISOString() })
        .eq("id", childRow.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from("cold_storage_inventory")
        .insert({ batch_id: batchId, recipe_id: recipeId, variation_id: op.toVariationId, quantity_on_hand: op.toUnits });
      if (error) throw new Error(error.message);
    }

    // Journal the break.
    const { error: jErr } = await supabase.from("cold_storage_breaks").insert({
      batch_id: batchId,
      recipe_id: recipeId,
      from_variation_id: op.fromVariationId,
      to_variation_id: op.toVariationId,
      from_units: op.fromUnits,
      to_units: op.toUnits,
      source_ref: sourceRef,
    });
    if (jErr) throw new Error(jErr.message);

    applied.push({ batchId, fromVariationId: op.fromVariationId, toVariationId: op.toVariationId, toUnits: op.toUnits });
  }

  return { applied, shortfall: plan.shortfall, warnings };
}
```

> Note on the stub: the child-row lookup adds `.eq("batch_id", batchId)`; the fake's `_f` map already keys on `batch_id`, so filter it in the `then` handler alongside `recipe_id`/`variation_id`. If a test's first single-insert path needs it, extend the fake's `cold_storage_inventory` filter to honor `batch_id` (add `if (q._f.batch_id) rows = rows.filter((r) => r.batch_id === q._f.batch_id)`).

- [ ] **Step 4: Extend the fake to honor `batch_id`, then run the test**

Add to the `cold_storage_inventory` `then` handler in the test fake (after the `variation_id` filter):

```ts
if (q._f.batch_id) rows = rows.filter((r) => r.batch_id === q._f.batch_id);
```

Run: `npm run test -- applyBreakDown`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/production/applyBreakDown.ts lib/production/applyBreakDown.test.ts
git commit -m "feat(cold-storage): applyBreakDown executes + journals pack break-downs"
```

---

### Task 5: Wire break-down into `recordTaproomConsumption` and surface it

**Files:**
- Modify: `lib/production/recordTaproomConsumption.ts`
- Modify: `lib/production/taproomConsumptionSync.ts:49-58` (result type) and `:200-209` (return)
- Test: `lib/production/recordTaproomConsumption.test.ts` (extend if present; else create)

**Interfaces:**
- Consumes: `applyBreakDown`, `AppliedBreak` (Task 4).
- Produces:
  - `recordTaproomConsumption` result gains `breaks: AppliedBreak[]`.
  - `TaproomSyncResult` gains `packsBrokenDown: number` (count of break ops applied this run).

- [ ] **Step 1: Write the failing test**

Add to (or create) `lib/production/recordTaproomConsumption.test.ts` a test that, given a target variation with 0 loose on hand but a stubbed `applyBreakDown` that tops it up, records the sale. Because `recordTaproomConsumption` orchestrates other IO (`writeColdStorageShipment`), test the NEW branch in isolation by asserting the availability-then-break-then-reavailability sequence via a stub client that returns 0 available on the first `getAvailableColdStorageQuantity` call and >0 on the second:

```ts
import { describe, it, expect, vi } from "vitest";

// Mock the two IO collaborators so we test recordTaproomConsumption's control flow:
// short -> applyBreakDown -> re-check available -> writeColdStorageShipment.
vi.mock("./coldStorageDepletion", () => ({
  getAvailableColdStorageQuantity: vi.fn(),
}));
vi.mock("./applyBreakDown", () => ({ applyBreakDown: vi.fn() }));
vi.mock("./shipmentWriter", () => ({ writeColdStorageShipment: vi.fn() }));

import { getAvailableColdStorageQuantity } from "./coldStorageDepletion";
import { applyBreakDown } from "./applyBreakDown";
import { writeColdStorageShipment } from "./shipmentWriter";
import { recordTaproomConsumption } from "./recordTaproomConsumption";

const supabase = {} as never;

describe("recordTaproomConsumption break-down integration", () => {
  it("breaks a higher tier when short, then records against the topped-up single stock", async () => {
    (getAvailableColdStorageQuantity as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(0)   // initial: no loose singles
      .mockResolvedValueOnce(4);  // after break: 4 singles
    (applyBreakDown as ReturnType<typeof vi.fn>).mockResolvedValue({
      applied: [{ batchId: "B-040", fromVariationId: "pack", toVariationId: "single", toUnits: 4 }],
      shortfall: 0, warnings: [],
    });
    (writeColdStorageShipment as ReturnType<typeof vi.fn>).mockResolvedValue({ exportTransactionIds: ["et1"] });

    const res = await recordTaproomConsumption(supabase, {
      recipeId: "r1", variationId: "single", quantity: 3, sourceRef: "sqsale:x:2026-07-07",
    });

    expect(applyBreakDown).toHaveBeenCalledWith(supabase, { recipeId: "r1", variationId: "single", needed: 3, sourceRef: "sqsale:x:2026-07-07" });
    expect(res.recordedQty).toBe(3);
    expect(res.shortfallQty).toBe(0);
    expect(res.breaks).toEqual([{ batchId: "B-040", fromVariationId: "pack", toVariationId: "single", toUnits: 4 }]);
  });

  it("does not attempt a break when the target tier already has enough", async () => {
    (getAvailableColdStorageQuantity as ReturnType<typeof vi.fn>).mockResolvedValueOnce(10);
    (writeColdStorageShipment as ReturnType<typeof vi.fn>).mockResolvedValue({ exportTransactionIds: ["et1"] });
    const res = await recordTaproomConsumption(supabase, { recipeId: "r1", variationId: "single", quantity: 3, sourceRef: "x" });
    expect(applyBreakDown).not.toHaveBeenCalled();
    expect(res.recordedQty).toBe(3);
    expect(res.breaks).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- recordTaproomConsumption`
Expected: FAIL — `res.breaks` is undefined / `applyBreakDown` never called.

- [ ] **Step 3: Modify `recordTaproomConsumption.ts`**

Replace the body of `recordTaproomConsumption` (keep the signature + doc comment) so it attempts a break-down when short:

```ts
import { SupabaseClient } from "@supabase/supabase-js";
import { getAvailableColdStorageQuantity } from "@/lib/production/coldStorageDepletion";
import { writeColdStorageShipment } from "@/lib/production/shipmentWriter";
import { applyBreakDown, type AppliedBreak } from "@/lib/production/applyBreakDown";

export interface RecordTaproomConsumptionParams {
  shipmentId?: string;
  recipeId: string;
  variationId: string;
  quantity: number;
  sourceRef: string;
  notes?: string | null;
}

const EPS = 1e-4;

export async function recordTaproomConsumption(
  supabase: SupabaseClient,
  params: RecordTaproomConsumptionParams,
): Promise<{ recordedQty: number; shortfallQty: number; exportTransactionIds: string[]; breaks: AppliedBreak[] }> {
  const { recipeId, variationId, quantity } = params;

  let available = await getAvailableColdStorageQuantity(supabase, { recipeId, variationId });

  // Short on this tier? Break down higher tiers of the same can identity to top it
  // up (case->pack->single, smallest-first). Only the taproom path breaks; sealed
  // wholesale stock is never auto-cracked. No-op for kegs / no-higher-tier cans.
  let breaks: AppliedBreak[] = [];
  if (available < quantity - EPS) {
    const bd = await applyBreakDown(supabase, { recipeId, variationId, needed: quantity, sourceRef: params.sourceRef });
    breaks = bd.applied;
    if (bd.applied.length > 0) {
      available = await getAvailableColdStorageQuantity(supabase, { recipeId, variationId });
    }
  }

  const recordable = Math.min(quantity, available);
  const shortfall = quantity - recordable;

  if (recordable <= 0) {
    return { recordedQty: 0, shortfallQty: shortfall, exportTransactionIds: [], breaks };
  }

  const result = await writeColdStorageShipment(supabase, {
    shipmentId: params.shipmentId,
    channel: "taproom",
    recipeId,
    variationId,
    quantity: recordable,
    recipientId: null,
    recipientName: null,
    allocationId: null,
    sourceRef: params.sourceRef,
    notes: params.notes ?? null,
  });

  return { recordedQty: recordable, shortfallQty: shortfall, exportTransactionIds: result.exportTransactionIds, breaks };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- recordTaproomConsumption`
Expected: PASS.

- [ ] **Step 5: Surface the break count in the sync result**

In `lib/production/taproomConsumptionSync.ts`:

Add to `TaproomSyncResult` (interface at line ~49):

```ts
  packsBrokenDown: number;
```

Track and return it — after `let recountsApplied = 0;` add:

```ts
  let packsBrokenDown = 0;
```

Inside the `if (res.recordedQty > EPS) { ... }` block (or right after the `recordTaproomConsumption` call), add:

```ts
    packsBrokenDown += res.breaks.length;
```

And add `packsBrokenDown,` to the returned object (line ~200 `return { ... }`).

- [ ] **Step 6: Run the full suite + lint + build**

Run: `npm run test`
Expected: PASS, coverage ≥ 86 lines/statements (three new pure-heavy modules add coverage).

Run: `npm run lint`
Expected: no errors.

Run: `npm run build`
Expected: clean build.

- [ ] **Step 7: Commit**

```bash
git add lib/production/recordTaproomConsumption.ts lib/production/recordTaproomConsumption.test.ts lib/production/taproomConsumptionSync.ts
git commit -m "feat(cold-storage): auto break-down higher tiers on short taproom can sales"
```

---

## Out of scope (separate follow-ups)

1. **Physical-count reconciliation migration** — truing `cold_storage_inventory` up to the 2026-07-07 cold-room count (the diff that started this thread). It's independent of the break mechanism: it sets absolute on-hand per (recipe, variation) tier, mirroring `20260712_cold_storage_physical_reconciliation.sql`. Write it once the break table lands so the physical 4-Pack rows have somewhere natural to sit. Requires the Carolina Pale 12oz-vs-16oz-case confirmation.
2. **Fix the 12oz "6-Pack" data bug** surfaced by `deriveCansEach` (volume 48 fl oz = 4 cans, not 6). Correct `total_volume_fl_oz` (or the format) on the affected `packaging_variations` rows via migration.
3. **Grid display of derived tiers / break history** in `InventoryTab` — optional, only if you want the break log visible in the taproom UI.
4. **Wholesale sealed-case reservation overlay** — deferred by design; only build if the export/wholesale path needs guaranteed sealed cases.

## Self-Review

- **Spec coverage:** `cold_storage_breaks` table (Task 1) ✓; auto-break cascade (Tasks 2 planner + 4 executor + 5 wire-in) ✓ — case→pack→single one level at a time, smallest-first, taproom-scoped ✓; units validation (Task 3 `deriveCansEach`, format/volume mismatch) ✓; 6-pack handling (Task 2 6-pack test, Task 3 6-pack derivation) ✓; null-safe identity tuple (Task 4 `nullSafeEq` over container/lid/label/partner) ✓; idempotency (breaks only on real delta; state in on-hand) ✓.
- **Placeholder scan:** none — every step carries real SQL/TS/tests and exact commands.
- **Type consistency:** `Tier`/`BreakOp`/`BreakPlan` (Task 2) reused by Task 4; `AppliedBreak`/`ApplyBreakResult` (Task 4) reused by Task 5; `deriveCansEach` returns `{ tiers, warnings }` consumed identically in Task 4. `planBreakDown` input `{ tiers, targetVariationId, needed }` matches all call sites.
