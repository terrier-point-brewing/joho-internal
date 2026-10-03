---
name: project-unified-draft-pour-consumption
description: 2026-07-11 PR
metadata: 
  node_type: memory
  type: project
  originSessionId: 29bca418-4923-4e11-b29b-2271ed1d42bd
---

PR #164 (branch `claude/unified-draft-pour-consumption`, OPEN) makes actual draft **pour** sell-through the single persisted basis for taproom draft metrics (fl-oz-available, oz/day, days-left, shrinkage) + production demand, and reverts [[project_taproom_sync_race]]-adjacent PR #155.

**Key domain facts discovered (verified against prod Square):**
- A draft beer's Square item has a base "Draft" variation (counted in fl oz; app recounts it via `setPhysicalCount` on swap) + sibling pour variations "Draft - 5oz/10oz/16oz" sold as `COMPOSED→SOLD` (quantity in pours; fl oz = pours × size).
- Square's **calculated** `IN_STOCK` (`/inventory/counts`, `fetchCurrentCounts`) on the base variation IS live-decremented by pours. The **`/inventory/changes`** feed is NOT — that was #155's bug (produced 1980 = 300% of a keg). Order-line sums == inventory COMPOSED→SOLD == Square UI, to the fl oz (validated 691/245/624).
- Shrinkage "leftover at swap" = base calculated on-hand captured pre-recount (live) or `max(0, last_recount_before_swap − pours_since)` (backfill).

**FROZEN invariant (do not change):** the whole-keg accounting path — `draft_swap → export_transactions` (whole-keg qty/volume_bbl/excise via exportTransactionWriter/recordTaproomConsumption/shipmentWriter), the `setPhysicalCount` recount, cold-storage depletion. Guardrail test: `lib/production/taproomConsumptionSync.frozen.test.ts`. Excise report (`app/api/finance/taxes`) reads taproom draft_swap volume — safe only because the write is unchanged.

**New/changed:** table `draft_pour_consumption` (migration `20260727`, RLS `for all to authenticated`); primitive `lib/taproom/draftPourConsumption.ts`; `syncDraftPourConsumption.ts`; sell-through + demand-calendar read the primitive (fixed latent bug: draft demand was always 0); backfill `lib/production/backfillDraftShrinkage.ts` + route `POST /api/taproom/draft-stats/backfill` (admin, dry-run default).

**ROLLOUT COMPLETE (2026-07-11):** #164 squash-merged (c77d756). Migration applied. Ledger seeded via service-role (510 recipe×day rows, 90d, 15 draft recipes / 60 pour vars). Shrinkage backfill applied to all 7 rows: Carolina 658→34 ✓ (validated), 7/09 660→369, 7/10 100→7, and **four 7/05 rows → 0** (stale anchor: last recount 12–28d before swap + pours>1 keg = run-dry/multi-keg-in-window, clamped; two are [[project_taproom_sync_race]] dup-swap rows). Pre-apply backup of draft_swap_shrinkage saved to session scratchpad. One-off backfill code (route+lib+test+fetchPhysicalCounts) REMOVED via PR #166 (OPEN).

**Gotcha for future:** cron/webhook write the ledger with only 1–2 day windows but reads need 30 (SELL_THROUGH_WINDOW_DAYS) / 28 (demand) — a one-time wide seed (`?days=90` on the manual sync route, or syncDraftPourConsumption(admin,{days:90})) is needed after deploy or metrics under-report for ~30 days until the ledger fills.

Plan: `docs/superpowers/plans/2026-07-10-unified-draft-pour-consumption.md`.

**Accreted-backfill sweep DONE (2026-07-11, PR #166 OPEN)** — verified each against prod before removing. REMOVED: draft-stats shrinkage backfill (ran, dead) + `finance/ledger/backfill-invoice-lines` (redundant dup of `finance/ledger/sync-square`; both call syncSquareInvoicesForYear, cron+export-flow keep it alive). KEPT (verified still needed/active): `production/deposit-invoices/backfill` — **still PENDING**, `deposit_invoice_ingredients` has 0 rows for the 17 legacy allocation_deposit invoices (new ones snapshot live via allocations/[id]/invoice; legacy need this backfill run — see [[project_deposit_invoice_breakdown]]); `scripts/cleanup-taproom-draftswap-duplicates.sql` (sync-race dedup, unrun — [[project_taproom_sync_race]]); `scripts/ramp-api-spike.mjs`; `scripts/check-search-filter.mjs` (active CI tooling). Lesson: most "backfill" routes are pending-and-needed or reusable wrappers, NOT dead — never blind-delete.
