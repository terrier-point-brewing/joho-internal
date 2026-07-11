# Unify Conversion Execution Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Transfer modal's **Convert** mode support both conversion methods — into an **existing** target batch *or* into a **brand-new** batch created inline — and have both run through one correct execution path so the **target** batch takes over the destination tank (status, assignment, schedule) and the exhausted **source** batch is completed. Fixes the incident where converting into an existing batch showed the destination tank as the *source* beer.

**Architecture:** One execution path — `POST /api/production/transfers` with `transfer_type='conversion'`. A shared `lib/production/conversionFinalizer.ts` (a) optionally creates the target batch when converting to a net-new batch, and (b) corrects the source-centric side effects that `record_batch_transfer` (RPC) + `reconcileSchedule` produce, re-pointing the destination tank's assignment/status/schedule to the target and completing the source when exhausted. The now-redundant standalone `/api/production/conversions` route is removed (its new-child capability is absorbed here). No DB migration — app-layer only.

**Tech Stack:** Next.js 16 route handlers, Supabase JS client, React client components, Vitest.

## Global Constraints

- Business logic lives in `lib/`, never in `app/api/**` — the route only orchestrates. (CLAUDE.md)
- New/modified `lib/` modules ship with co-located `*.test.ts`; do not drop coverage below the `vitest.config.ts` floor (`lines`/`statements` = 86). (CLAUDE.md)
- Reuse existing helpers: `checkAndCompleteBatch` (`lib/production/batchCompletion.ts`) for source completion; do not re-implement exhaustion logic.
- Batch statuses are constrained to `planning | brewing | fermenting | conditioning | complete` (migration `20260705`). Never write any other value.
- Do NOT modify the `record_batch_transfer` RPC or add a migration — the fix is app-layer only.
- UI: no raw color utilities / hand-rolled primitives — reuse `.inp`, `<Field>`, token classes already used in `TransferModal.tsx`. (CLAUDE.md UI conventions)

---

## Background (read before starting)

Executing a conversion runs, in order, inside `processTransferLine` → `POST /api/production/transfers`:

1. **`record_batch_transfer` RPC** (`supabase/migrations/20260705_remove_packaging_status.sql`) inserts the transfer under `batch_id = source`, releases the source's active assignments, then **assigns the *source* to the destination tank** and flips the *source's* status to the dest tank's stage (`brite`→`conditioning`, `fermenter`→`fermenting`). It raises `Destination tank is already occupied` if the dest tank has an active assignment.
2. **`reconcileSchedule`** (in `route.ts`) runs with `batch_id = source` and creates a *source* schedule entry **on the destination tank**.
3. **Conversion side-effects block** (`route.ts:772-789`) only stamps `to_batch_id` on the transfer row and sets `batch_conversions.converted_at`. It never touches the **target** batch or completes the source.

Net effect: the destination tank shows the **source** beer; the **target** stays in `planning` with no tank; the source is never completed.

Two front-end entry points exist today: **TransferModal** Convert mode → `POST /api/production/transfers` (used for the incident; broken), and the standalone `POST /api/production/conversions` route that creates a **new child batch** with correct tank handling but has **zero callers** (grep-verified). This plan folds the new-child capability into the single transfers path and exposes both methods in the modal.

**Correct end state after any conversion** (verified by hand on the B-028→B-038 incident):
- Destination tank assignment → **target** batch (source released from it).
- Target status → dest-tank stage (`brite`→`conditioning`, `fermenter`→`fermenting`), forward-only.
- Target schedule entry on dest tank → `actual_start` stamped, `volume_bbl` = converted volume.
- Source's auto-created schedule entry on dest tank → cancelled.
- Source → `complete` when `batch_exhaustion.is_exhausted`; else its status reflects the tank it still occupies.

Because the target batch is created **without** a tank assignment (the finalizer assigns it after the RPC), the dest tank is free when the RPC runs, so the RPC's "already occupied" check passes in both existing-target and new-batch flows.

---

## File Structure

- **Create** `lib/production/conversionFinalizer.ts` — `conversionTargetStatus()`, `isForward()`, `createConversionTargetBatch()`, `finalizeConversion()`.
- **Create** `lib/production/conversionFinalizer.test.ts` — unit tests (pure fns + stubbed-Supabase orchestration).
- **Modify** `app/api/production/transfers/route.ts` — accept an optional `new_batch` payload; create the target when needed; call `finalizeConversion`.
- **Modify** `app/production/components/TransferModal.tsx` — Convert mode gets an "Existing batch / New batch" toggle; new-batch fields (beer name + recipe); submit either `to_batch_id` or `new_batch`.
- **Delete** `app/api/production/conversions/route.ts` — capability absorbed into the transfers path.
- **Modify** `docs/production-schema.md` — document the single conversion path + finalizer.

---

### Task 1: Pure `conversionTargetStatus` + forward-only guard

**Files:**
- Create: `lib/production/conversionFinalizer.ts`
- Test: `lib/production/conversionFinalizer.test.ts`

**Interfaces:**
- Produces:
  - `conversionTargetStatus(destType: string | null | undefined): "fermenting" | "conditioning" | null`
  - `STATUS_RANK: Record<string, number>`
  - `isForward(from: string | null | undefined, to: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// lib/production/conversionFinalizer.test.ts
import { describe, it, expect } from "vitest";
import { conversionTargetStatus, isForward } from "./conversionFinalizer";

describe("conversionTargetStatus", () => {
  it("maps brite → conditioning and fermenter → fermenting", () => {
    expect(conversionTargetStatus("brite")).toBe("conditioning");
    expect(conversionTargetStatus("fermenter")).toBe("fermenting");
  });
  it("returns null for unconstrained / unknown dest types", () => {
    expect(conversionTargetStatus("kegging")).toBeNull();
    expect(conversionTargetStatus(null)).toBeNull();
    expect(conversionTargetStatus(undefined)).toBeNull();
  });
});

describe("isForward", () => {
  it("advances planning → conditioning", () => {
    expect(isForward("planning", "conditioning")).toBe(true);
  });
  it("does not regress conditioning → fermenting", () => {
    expect(isForward("conditioning", "fermenting")).toBe(false);
  });
  it("treats null/unknown current status as earliest, and never advances past complete", () => {
    expect(isForward(null, "fermenting")).toBe(true);
    expect(isForward("complete", "conditioning")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- conversionFinalizer`
Expected: FAIL — no exports `conversionTargetStatus` / `isForward`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/production/conversionFinalizer.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkAndCompleteBatch } from "./batchCompletion";

/** Batch status implied by the stage a batch occupies in a given equipment type. */
export function conversionTargetStatus(
  destType: string | null | undefined,
): "fermenting" | "conditioning" | null {
  switch (destType) {
    case "fermenter": return "fermenting";
    case "brite":     return "conditioning";
    default:          return null;
  }
}

/** Ordered lifecycle rank; higher = later. Unknown/null ranks lowest. */
export const STATUS_RANK: Record<string, number> = {
  planning: 0, brewing: 1, fermenting: 2, conditioning: 3, complete: 4,
};

/** True when `to` is a strictly later stage than `from` (forward-only guard). */
export function isForward(from: string | null | undefined, to: string): boolean {
  const fromRank = from != null && from in STATUS_RANK ? STATUS_RANK[from] : -1;
  const toRank = to in STATUS_RANK ? STATUS_RANK[to] : -1;
  return toRank > fromRank;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- conversionFinalizer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/production/conversionFinalizer.ts lib/production/conversionFinalizer.test.ts
git commit -m "feat(production): add conversionTargetStatus + forward-only status guard"
```

---

### Task 2: `createConversionTargetBatch` (net-new target)

**Files:**
- Modify: `lib/production/conversionFinalizer.ts`
- Test: `lib/production/conversionFinalizer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  createConversionTargetBatch(
    supabase: SupabaseClient,
    args: { sourceBatchId: string; beerName: string; recipeId: string; volumeBbl: number },
  ): Promise<string>  // returns the new batch id
  ```
- Behavior: reads the parent's `planned_brew_date`, inserts a `brew_batches` row (`status: 'planning'` — the finalizer advances it by dest tank), returns its id. Status is left at `planning` so `finalizeConversion` sets the correct stage from the destination tank; the batch gets NO tank assignment here (the finalizer assigns it, keeping the dest tank free for the RPC).

- [ ] **Step 1: Write the failing test**

Append to `lib/production/conversionFinalizer.test.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createConversionTargetBatch } from "./conversionFinalizer";

function insertStub(newId: string, parentDate: string | null) {
  const recorded: { table: string; payload: unknown }[] = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.single = () => Promise.resolve({ data: table === "brew_batches" ? { planned_brew_date: parentDate } : null, error: null });
    b.insert = (payload: unknown) => {
      recorded.push({ table, payload });
      return {
        select: () => ({ single: () => Promise.resolve({ data: { id: newId }, error: null }) }),
      };
    };
    return b;
  };
  return { client: { from } as unknown as SupabaseClient, recorded };
}

describe("createConversionTargetBatch", () => {
  it("inserts a planning child linked to the parent and returns its id", async () => {
    const { client, recorded } = insertStub("child-1", "2026-05-21");
    const id = await createConversionTargetBatch(client, {
      sourceBatchId: "S", beerName: "Pumpkin Ale", recipeId: "r1", volumeBbl: 24.5,
    });
    expect(id).toBe("child-1");
    const ins = recorded.find(r => r.table === "brew_batches");
    expect(ins?.payload).toMatchObject({
      beer_name: "Pumpkin Ale", recipe_id: "r1", volume_bbl: 24.5,
      status: "planning", converted_from_batch_id: "S", converted_volume_bbl: 24.5,
      planned_brew_date: "2026-05-21",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- conversionFinalizer`
Expected: FAIL — `createConversionTargetBatch` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `lib/production/conversionFinalizer.ts`:

```ts
export async function createConversionTargetBatch(
  supabase: SupabaseClient,
  { sourceBatchId, beerName, recipeId, volumeBbl }: {
    sourceBatchId: string; beerName: string; recipeId: string; volumeBbl: number;
  },
): Promise<string> {
  const { data: parent } = await supabase
    .from("brew_batches").select("planned_brew_date").eq("id", sourceBatchId).single();

  const { data: child, error } = await supabase
    .from("brew_batches")
    .insert({
      beer_name:               beerName,
      recipe_id:               recipeId,
      volume_bbl:              volumeBbl,
      status:                  "planning",
      planned_brew_date:       (parent as { planned_brew_date: string | null } | null)?.planned_brew_date ?? null,
      converted_from_batch_id: sourceBatchId,
      converted_volume_bbl:    volumeBbl,
    })
    .select("id")
    .single();

  if (error || !child) throw new Error(error?.message ?? "Failed to create conversion target batch");
  return (child as { id: string }).id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- conversionFinalizer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/production/conversionFinalizer.ts lib/production/conversionFinalizer.test.ts
git commit -m "feat(production): add createConversionTargetBatch for ad-hoc conversion targets"
```

---

### Task 3: `finalizeConversion` orchestration

**Files:**
- Modify: `lib/production/conversionFinalizer.ts`
- Test: `lib/production/conversionFinalizer.test.ts`

**Interfaces:**
- Consumes: `conversionTargetStatus`, `isForward` (Task 1); `checkAndCompleteBatch` (`./batchCompletion`).
- Produces:
  ```ts
  finalizeConversion(
    supabase: SupabaseClient,
    args: { sourceBatchId: string; targetBatchId: string; fromTankId: string | null; toTankId: string | null; volumeBbl: number; today: string },
  ): Promise<void>
  ```

**Behavior (in order), destination steps only when `toTankId` is set:**
1. Resolve `destType` from `equipment` for `toTankId`; `stage` = `fermenting`/`conditioning`/null.
2. Release the source's active assignment on `toTankId`.
3. Cancel the source's spurious open schedule entry on `toTankId`.
4. Assign the target to `toTankId` when `conversionTargetStatus(destType)` is non-null and the target has no active assignment there.
5. Advance target status forward-only; write a `batch_status_history` row when it changes.
6. Stamp the target's open schedule entry for that stage on `toTankId` (`actual_start` if null, `volume_bbl`); insert one if none exists.
7. Correct the source's status from the tank it still occupies (partial conversions).
8. `await checkAndCompleteBatch(supabase, sourceBatchId)` — completion wins for full conversions.

- [ ] **Step 1: Write the failing test**

Append to `lib/production/conversionFinalizer.test.ts`. Model the stub on `lib/production/batchCompletion.test.ts`; capture `.eq()` filters so tests assert *who* was mutated.

```ts
import { finalizeConversion } from "./conversionFinalizer";

interface Rec { table: string; op: string; payload?: unknown; match: Record<string, unknown> }

function stub(rows: {
  equipmentType?: string | null;
  targetStatus?: string | null;
  targetEntry?: { id: string; actual_start: string | null } | null;
  sourceAssignment?: { tank_id: string; equipment: { type: string | null } | null } | null;
  exhaustion?: { is_exhausted: boolean } | null;
}) {
  const recorded: Rec[] = [];
  const from = (table: string) => {
    const match: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (k: string, v: unknown) => { match[k] = v; return b; };
    b.is = (k: string, v: unknown) => { match[`${k}:is`] = v; return b; };
    b.not = () => b; b.order = () => b; b.limit = () => b;
    b.update = (payload: unknown) => { recorded.push({ table, op: "update", payload, match: { ...match } }); return b; };
    b.insert = (payload: unknown) => { recorded.push({ table, op: "insert", payload, match: { ...match } }); return Promise.resolve({ data: null, error: null }); };
    b.maybeSingle = () => read(table);
    b.single = () => read(table);
    b.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null }); // update().eq()... await
    return b;
  };
  const read = (table: string) => {
    if (table === "equipment") return Promise.resolve({ data: { type: rows.equipmentType ?? null }, error: null });
    if (table === "batch_exhaustion") return Promise.resolve({ data: rows.exhaustion ?? null, error: null });
    if (table === "brew_batches") return Promise.resolve({ data: { status: rows.targetStatus ?? null }, error: null });
    if (table === "batch_schedule_entries") return Promise.resolve({ data: rows.targetEntry ?? null, error: null });
    if (table === "batch_tank_assignments") return Promise.resolve({ data: rows.sourceAssignment ?? null, error: null });
    return Promise.resolve({ data: null, error: null });
  };
  return { client: { from } as unknown as SupabaseClient, recorded };
}

describe("finalizeConversion", () => {
  const base = { sourceBatchId: "S", targetBatchId: "T", fromTankId: "src", toTankId: "dst", volumeBbl: 24.5, today: "2026-07-03" };

  it("releases source from dest tank and assigns target there", async () => {
    const { client, recorded } = stub({ equipmentType: "brite", targetStatus: "planning", exhaustion: { is_exhausted: true } });
    await finalizeConversion(client, base);
    expect(recorded.find(r => r.table === "batch_tank_assignments" && r.op === "update" && r.match["batch_id"] === "S" && r.match["tank_id"] === "dst")).toBeTruthy();
    expect(recorded.find(r => r.table === "batch_tank_assignments" && r.op === "insert")?.payload).toEqual({ batch_id: "T", tank_id: "dst" });
  });

  it("advances target planning → conditioning with a history row", async () => {
    const { client, recorded } = stub({ equipmentType: "brite", targetStatus: "planning", exhaustion: { is_exhausted: true } });
    await finalizeConversion(client, base);
    expect(recorded.find(r => r.table === "brew_batches" && r.op === "update" && r.match["id"] === "T")?.payload).toEqual({ status: "conditioning" });
    expect(recorded.find(r => r.table === "batch_status_history")).toBeTruthy();
  });

  it("cancels the source's spurious dest-tank schedule entry", async () => {
    const { client, recorded } = stub({ equipmentType: "brite", targetStatus: "planning", exhaustion: { is_exhausted: true } });
    await finalizeConversion(client, base);
    expect(recorded.find(r => r.table === "batch_schedule_entries" && r.op === "update" && r.match["batch_id"] === "S" && r.match["equipment_id"] === "dst")).toBeTruthy();
  });

  it("stamps an existing target schedule entry instead of inserting one", async () => {
    const { client, recorded } = stub({ equipmentType: "brite", targetStatus: "planning", targetEntry: { id: "e5", actual_start: null }, exhaustion: { is_exhausted: true } });
    await finalizeConversion(client, base);
    expect((recorded.find(r => r.table === "batch_schedule_entries" && r.op === "update" && r.match["id"] === "e5")?.payload as { volume_bbl: number }).volume_bbl).toBe(24.5);
    expect(recorded.find(r => r.table === "batch_schedule_entries" && r.op === "insert")).toBeUndefined();
  });

  it("does nothing to the dest tank when toTankId is null", async () => {
    const { client, recorded } = stub({ equipmentType: null, exhaustion: { is_exhausted: false } });
    await finalizeConversion(client, { ...base, toTankId: null });
    expect(recorded.find(r => r.table === "batch_tank_assignments" && r.op === "insert")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- conversionFinalizer`
Expected: FAIL — `finalizeConversion` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `lib/production/conversionFinalizer.ts`:

```ts
export interface FinalizeConversionArgs {
  sourceBatchId: string;
  targetBatchId: string;
  fromTankId: string | null;
  toTankId: string | null;
  volumeBbl: number;
  today: string; // 'YYYY-MM-DD'
}

/**
 * Re-point a just-recorded conversion transfer's destination-tank occupancy from
 * the SOURCE batch (where record_batch_transfer + reconcileSchedule wrongly put
 * it) onto the TARGET batch, and complete the source if it is now exhausted.
 * Call once per conversion transfer, after the transfer row exists.
 */
export async function finalizeConversion(
  supabase: SupabaseClient,
  { sourceBatchId, targetBatchId, toTankId, volumeBbl, today }: FinalizeConversionArgs,
): Promise<void> {
  if (toTankId) {
    const { data: destEq } = await supabase
      .from("equipment").select("type").eq("id", toTankId).maybeSingle();
    const destType = (destEq as { type: string | null } | null)?.type ?? null;
    const targetStatus = conversionTargetStatus(destType);
    const stage = destType === "fermenter" ? "fermenting" : destType === "brite" ? "conditioning" : null;

    // 2. Release the source from the destination tank (RPC assigned it there).
    await supabase
      .from("batch_tank_assignments")
      .update({ released_at: new Date().toISOString() })
      .eq("batch_id", sourceBatchId).eq("tank_id", toTankId).is("released_at", null);

    // 3. Cancel the source's spurious open schedule entry on the destination tank.
    await supabase
      .from("batch_schedule_entries")
      .update({ cancelled_at: new Date().toISOString(), cancellation_reason: "conversion: destination belongs to target batch", updated_at: new Date().toISOString() })
      .eq("batch_id", sourceBatchId).eq("equipment_id", toTankId)
      .is("cancelled_at", null).is("actual_end", null);

    // 4. Assign the target to the destination tank (constrained types only).
    if (targetStatus) {
      const { data: existing } = await supabase
        .from("batch_tank_assignments")
        .select("id").eq("batch_id", targetBatchId).eq("tank_id", toTankId).is("released_at", null)
        .maybeSingle();
      if (!existing) {
        await supabase.from("batch_tank_assignments").insert({ batch_id: targetBatchId, tank_id: toTankId });
      }
    }

    // 5. Advance the target's status (forward-only).
    if (targetStatus) {
      const { data: tb } = await supabase
        .from("brew_batches").select("status").eq("id", targetBatchId).maybeSingle();
      if (isForward((tb as { status: string | null } | null)?.status, targetStatus)) {
        await supabase.from("brew_batches").update({ status: targetStatus }).eq("id", targetBatchId);
        await supabase.from("batch_status_history").insert({
          batch_id: targetBatchId, status: targetStatus, note: `Auto: conversion into ${destType}`,
        });
      }
    }

    // 6. Stamp (or create) the target's schedule entry on the destination tank.
    if (stage) {
      const { data: entry } = await supabase
        .from("batch_schedule_entries")
        .select("id, actual_start")
        .eq("batch_id", targetBatchId).eq("equipment_id", toTankId).eq("stage", stage)
        .is("cancelled_at", null)
        .order("planned_start", { ascending: true }).limit(1)
        .maybeSingle();
      const row = entry as { id: string; actual_start: string | null } | null;
      if (row) {
        const updates: Record<string, unknown> = { volume_bbl: volumeBbl, updated_at: new Date().toISOString() };
        if (row.actual_start == null) updates.actual_start = today;
        await supabase.from("batch_schedule_entries").update(updates).eq("id", row.id);
      } else {
        await supabase.from("batch_schedule_entries").insert({
          batch_id: targetBatchId, equipment_id: toTankId, stage,
          planned_start: today, planned_end: today, actual_start: today,
          volume_bbl: volumeBbl, notes: "Auto-created on conversion",
        });
      }
    }
  }

  // 7. Correct the source's status from the tank it still occupies (partial
  //    conversions; RPC guessed the dest-tank stage). Completion wins in step 8.
  const { data: srcAssign } = await supabase
    .from("batch_tank_assignments")
    .select("tank_id, equipment:tank_id(type)")
    .eq("batch_id", sourceBatchId).is("released_at", null)
    .order("assigned_at", { ascending: false }).limit(1)
    .maybeSingle();
  const srcType = (srcAssign as { equipment: { type: string | null } | null } | null)?.equipment?.type ?? null;
  const srcStatus = conversionTargetStatus(srcType);
  if (srcStatus) {
    await supabase.from("brew_batches").update({ status: srcStatus }).eq("id", sourceBatchId);
  }

  // 8. Complete the source if fully exhausted (full conversion).
  await checkAndCompleteBatch(supabase, sourceBatchId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- conversionFinalizer`
Expected: PASS (all cases). If read chains don't resolve, adjust the stub (not the implementation) until the real decisions assert correctly.

- [ ] **Step 5: Commit**

```bash
git add lib/production/conversionFinalizer.ts lib/production/conversionFinalizer.test.ts
git commit -m "feat(production): add finalizeConversion to hand dest tank to the target batch"
```

---

### Task 4: Wire the transfers route — existing target + net-new batch

**Files:**
- Modify: `app/api/production/transfers/route.ts` (POST body type ~636-653; conversion block ~772-789; add imports)

**Interfaces:**
- Consumes: `finalizeConversion`, `createConversionTargetBatch` (Tasks 2-3).
- New request field: `new_batch?: { beer_name: string; recipe_id: string } | null` on the transfers POST body (only meaningful when `transfer_type === "conversion"`).

- [ ] **Step 1: Add imports**

Next to the existing `checkAndCompleteBatch` import at the top of `route.ts`:

```ts
import { finalizeConversion, createConversionTargetBatch } from "@/lib/production/conversionFinalizer";
```

- [ ] **Step 2: Accept `new_batch` in the POST body**

In the `POST` handler, extend the destructured body and its type (currently ~636-653) to include `new_batch`:

```ts
  const {
    batch_id,
    from_tank_id,
    to_tank_id,
    to_batch_id,
    transfer_type,
    notes,
    packaging_lines,
    new_batch,
  } = body as {
    batch_id: string;
    from_tank_id: string | null;
    to_tank_id: string | null;
    to_batch_id?: string | null;
    transfer_type: "transfer" | "kegging" | "canning" | "conversion" | "brewing";
    notes: string | null;
    volume_bbl?: number;
    shrinkage_bbl?: number;
    packaging_lines?: { variation_id: string; quantity: number }[];
    new_batch?: { beer_name: string; recipe_id: string } | null;
  };
```

- [ ] **Step 3: Replace the conversion side-effects block**

Replace the existing block (`route.ts:772-789`) with one that resolves the target (existing or net-new), stamps the transfer, marks the plan executed, then finalizes:

```ts
  // ── Conversion side effects ────────────────────────────────────────────────
  if (transfer_type === "conversion" && (to_batch_id || new_batch) && transfers.length > 0) {
    const convertedVol = Number(body.volume_bbl ?? 0);

    // Resolve the target batch: an existing one, or a brand-new batch created inline.
    let targetBatchId = to_batch_id ?? null;
    if (!targetBatchId && new_batch?.beer_name && new_batch?.recipe_id) {
      try {
        targetBatchId = await createConversionTargetBatch(supabase, {
          sourceBatchId: batch_id,
          beerName:      new_batch.beer_name,
          recipeId:      new_batch.recipe_id,
          volumeBbl:     convertedVol,
        });
      } catch (createErr) {
        return NextResponse.json({ error: (createErr as Error).message }, { status: 500 });
      }
    }

    if (targetBatchId) {
      const transferId = (transfers[0] as { id?: string }).id;
      if (transferId) {
        await supabase.from("batch_transfers").update({ to_batch_id: targetBatchId }).eq("id", transferId);
      }
      // Mark any pre-planned batch_conversions record as executed (no-op for ad-hoc new batches).
      await supabase
        .from("batch_conversions")
        .update({ converted_at: new Date().toISOString() })
        .eq("source_batch_id", batch_id)
        .eq("target_batch_id", targetBatchId)
        .is("converted_at", null);

      // Hand the destination tank to the target batch and complete the exhausted
      // source — record_batch_transfer + reconcileSchedule attribute the dest
      // occupancy to the SOURCE, which is wrong for conversions.
      try {
        await finalizeConversion(supabase, {
          sourceBatchId: batch_id,
          targetBatchId,
          fromTankId:    from_tank_id,
          toTankId:      to_tank_id,
          volumeBbl:     convertedVol,
          today:         new Date().toISOString().split("T")[0],
        });
      } catch (finalizeErr) {
        console.error("[transfers] Conversion finalize failed (transfer committed):", finalizeErr);
      }
    }
  }
```

- [ ] **Step 4: Verify build + lint + full test suite**

Run: `npm run lint && npm run test && npm run build`
Expected: lint clean, all tests pass, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add app/api/production/transfers/route.ts
git commit -m "feat(production): conversions support existing OR net-new target, one path"
```

---

### Task 5: Transfer modal — Existing / New target toggle

**Files:**
- Modify: `app/production/components/TransferModal.tsx` (convert-mode state ~134-136; banner ~330-334; convert fields ~377-401; submit ~211-234)

**Interfaces:**
- Consumes: the route's `new_batch` field (Task 4). `recipes: Recipe[]` is already a prop.

- [ ] **Step 1: Add convert-target-mode state**

After the existing convert state (`TransferModal.tsx:134-136`):

```tsx
  // Conversion-specific state
  const [convertToBatchId, setConvertToBatchId] = useState(initialConvert?.toBatchId ?? "");
  const [convertBbl,       setConvertBbl]        = useState(initialConvert?.bbl ?? "");
  // Existing target batch vs. create a brand-new one inline. Pre-planned
  // conversions arrive with a target batch, so default to "existing" then.
  const [convertTarget, setConvertTarget] = useState<"existing" | "new">(
    initialConvert?.toBatchId ? "existing" : "existing",
  );
  const [newBeerName, setNewBeerName] = useState(initialConvert?.beerName ?? "");
  const [newRecipeId, setNewRecipeId] = useState("");
```

- [ ] **Step 2: Update the convert-mode banner (existing/new aware)**

Replace the banner (`TransferModal.tsx:330-334`):

```tsx
            {mode === "convert" && (
              <div className="px-3 py-2 rounded border border-accent-border/40 bg-accent-muted/30 text-xs text-accent-soft">
                Convert volume into another recipe. Pick an <span className="font-semibold">existing target batch</span> or create a <span className="font-semibold">new batch</span> inline. Remaining volume stays in {fromTank.name} under the original batch; a full conversion completes it.
              </div>
            )}
```

- [ ] **Step 3: Replace the convert fields with a target toggle + conditional inputs**

Replace the convert-mode fields block (`TransferModal.tsx:377-401`, the `Target Batch` + `Volume to Convert` `<Field>`s) with:

```tsx
            {mode === "convert" && (
              <>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setConvertTarget("existing")}
                    className={`px-3 py-1.5 text-sm rounded border transition-colors ${convertTarget === "existing" ? "border-accent-border bg-accent-muted/30 text-accent-soft" : "border-line-strong bg-surface-mid text-secondary hover:text-strong"}`}>
                    Existing batch
                  </button>
                  <button type="button" onClick={() => setConvertTarget("new")}
                    className={`px-3 py-1.5 text-sm rounded border transition-colors ${convertTarget === "new" ? "border-accent-border bg-accent-muted/30 text-accent-soft" : "border-line-strong bg-surface-mid text-secondary hover:text-strong"}`}>
                    New batch
                  </button>
                </div>

                {convertTarget === "existing" ? (
                  <Field label="Target Batch" required>
                    <select className="inp" value={convertToBatchId} required onChange={e => setConvertToBatchId(e.target.value)}>
                      <option value="">— select batch —</option>
                      {batches
                        .filter(b => b.id !== batch.id && b.status !== "complete")
                        .map(b => (
                          <option key={b.id} value={b.id}>
                            {b.batch_number ? `#${b.batch_number} ` : ""}{b.beer_name}
                          </option>
                        ))}
                    </select>
                  </Field>
                ) : (
                  <>
                    <Field label="New Batch Name" required>
                      <input className="inp" placeholder="e.g. Pumpkin Ale" required
                        value={newBeerName} onChange={e => setNewBeerName(e.target.value)} />
                    </Field>
                    <Field label="Recipe" required>
                      <select className="inp" value={newRecipeId} required onChange={e => setNewRecipeId(e.target.value)}>
                        <option value="">— select recipe —</option>
                        {recipes.map(r => (
                          <option key={r.id} value={r.id}>{r.beer_name}</option>
                        ))}
                      </select>
                    </Field>
                  </>
                )}

                <Field label="Volume to Convert (BBL)" required>
                  <div className="flex items-center gap-2">
                    <input type="number" step="0.001" min="0.001" max={batchVol} className="inp w-40"
                      placeholder="0.000" required
                      value={convertBbl} onChange={(e) => setConvertBbl(e.target.value)} />
                    <span className="text-muted text-sm">BBL</span>
                  </div>
                </Field>
              </>
            )}
```

- [ ] **Step 4: Update the convert submit branch**

Replace the convert branch of `handleSubmit` (`TransferModal.tsx:211-234`):

```tsx
      if (mode === "convert") {
        const usingExisting = convertTarget === "existing";
        if (usingExisting && !convertToBatchId) { alert("Select a target batch."); return; }
        if (!usingExisting && (!newBeerName.trim() || !newRecipeId)) { alert("Enter a name and recipe for the new batch."); return; }
        if (!convertBbl) { alert("Enter the volume to convert."); return; }

        const res = await fetch("/api/production/transfers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            batch_id:      batch.id,
            from_tank_id:  fromTank.id,
            to_tank_id:    effectiveDestId || null,
            to_batch_id:   usingExisting ? convertToBatchId : null,
            new_batch:     usingExisting ? null : { beer_name: newBeerName.trim(), recipe_id: newRecipeId },
            volume_bbl:    parseFloat(convertBbl),
            shrinkage_bbl: 0,
            transfer_type: "conversion",
            notes:         notes || null,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Error");
        await onDone();
        onClose();
        return;
      }
```

- [ ] **Step 5: Verify lint + build**

Run: `npm run lint && npm run build`
Expected: clean build (types line up; `recipes`, `batches` are existing props).

- [ ] **Step 6: Commit**

```bash
git add app/production/components/TransferModal.tsx
git commit -m "feat(production): convert modal supports existing or net-new target batch"
```

---

### Task 6: Remove the dead standalone route + document the single path

**Files:**
- Delete: `app/api/production/conversions/route.ts`
- Modify: `docs/production-schema.md` (conversion section ~40-48)

**Rationale:** Its new-child capability is now in the transfers path (Tasks 4-5); grep confirms zero front-end callers.

- [ ] **Step 1: Re-confirm zero callers before deleting**

Run: `grep -rn "api/production/conversions" app lib --include=*.ts --include=*.tsx | grep -v "app/api/production/conversions/route"`
Expected: no output. If a caller appears, STOP — do not delete.

- [ ] **Step 2: Delete the route**

```bash
git rm app/api/production/conversions/route.ts
```

- [ ] **Step 3: Document the single conversion path**

In `docs/production-schema.md`, in the `batch_conversions` section (near "Executing a conversion", ~47-48), append:

```md
  Conversions execute via a single path: `POST /api/production/transfers` with
  `transfer_type='conversion'` and either an existing `to_batch_id` OR a
  `new_batch: { beer_name, recipe_id }` (created inline). That route then runs
  `finalizeConversion` (`lib/production/conversionFinalizer.ts`), which hands the
  destination tank's assignment + schedule entry to the TARGET batch and completes
  the SOURCE batch when fully exhausted. (The standalone `/api/production/conversions`
  new-child route was removed 2026-07-04; its capability lives in the transfers path.)
```

- [ ] **Step 4: Verify build + tests**

Run: `npm run test && npm run build`
Expected: pass (nothing imported the deleted route).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(production): remove dead conversions route; document single conversion path"
```

---

## Self-Review

**Spec coverage:**
- Both methods work (existing target + net-new batch), chosen in the modal → Tasks 4 (backend) + 5 (modal toggle). ✓
- Same correct execution path → single transfers endpoint + shared `finalizeConversion`; Task 6 removes the alternate. ✓
- Incident fix (existing-target conversion showed source in dest tank) → `finalizeConversion` steps 2-6 (Task 3), wired in Task 4. ✓
- Shared logic in one place, reuse `checkAndCompleteBatch` → `lib/production/conversionFinalizer.ts`. ✓
- Co-located tests / coverage floor → Tasks 1-3 tests. ✓
- UI conventions (no raw colors/primitives) → Task 5 reuses `.inp`, `<Field>`, token classes + the same button pattern already in the file. ✓

**Placeholder scan:** No TODO/TBD; every code step shows full code. ✓

**Type consistency:** `conversionTargetStatus`, `isForward`, `STATUS_RANK`, `createConversionTargetBatch(supabase, {sourceBatchId,beerName,recipeId,volumeBbl})`, `finalizeConversion(supabase, FinalizeConversionArgs)`, and the route's `new_batch: { beer_name, recipe_id }` are used with identical names/shapes across tasks. ✓

## Post-implementation manual verification (not a code step)

Exercise both flows on the floorplan Transfer modal:
1. **Existing target:** plan a conversion (ConvertPanel), then Convert → Existing batch → run it. Confirm the destination tank's active assignment + open schedule entry belong to the **target**, target status advanced, and a fully-converted source flips to `complete`.
2. **New batch:** Convert → New batch (name + recipe) → run it. Confirm a new batch is created, occupies the destination tank, and the source completes when fully drawn.

The equipment schedule graph (`buildGraphData.ts`) reads assignments + ledger, so the corrected assignment is what makes the tile show the right beer.
