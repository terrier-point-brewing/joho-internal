---
name: project-payroll-day-override-grid
description: "Per-day payroll override grid on Taproom Shifts tab — PR #277 + #289 MERGED, migration 20260821 APPLIED"
metadata: 
  node_type: memory
  type: project
  originSessionId: 089b10c8-4055-460d-b4a3-610a24f8b30a
  modified: 2026-07-27T21:29:21.868Z
---

**PR #277 MERGED** (`0ee463f`) + follow-up **PR #289 MERGED** (`5541061`), both 2026-07-27/28. Migration `20260821_payroll_shift_overrides.sql` **APPLIED**. Managers+admins can override hours / cash tips / card tips per employee-day cell in Taproom › Payroll › Shifts; corrections feed Summary, bonus, Gusto export, and the locked snapshot.

⚠️ **Never verified in a browser** — every attempt hit the login wall. The sticky columns, the Adjustments tab, and the actual save round-trip have no human or automated eyes on them. Check on a **manager** account.

#289 (follow-up) fixed a real perf defect and added three UI asks:
- **Saves made 12 paginated Square round-trips.** `buildDailyGrid` coupled fetch to compute, so the shifts route's "compute twice for the strikethrough baseline" meant "fetch twice", and the PUT's pool-guard validation + dual query invalidation multiplied it. Split into `fetchDayGridInputs` (only I/O) + `computeDailyGrid` (pure); added `unstable_cache` to `fetchShiftsByDay`/`fetchPayments`. **12 sequences per save → 3.** The spec had *claimed* the baseline pass was free — it was structurally impossible, and no test caught it because tests mock the fetchers, making redundant I/O invisible.
- Sticky employee (left) + save/notes (right) columns. Dividers use `box-shadow`, not `border`: under `border-collapse` the border is painted by the table, not the cell, so it can fail to travel with a sticky cell.
- **Adjustments tab** — every manual change to a period, both layers (period `payroll_entries.adj_*` + per-day `payroll_shift_overrides`), one row per changed field. Built from already-loaded data; adds no route and no Square traffic.
- Gusto Summary sorts by last name descending.

**⚠️ `payroll_reader_roles()` is `{manager, admin}` and excludes the `custom` role** added in 20260819/20260820. No RLS policy anywhere consults `user_permission_grants`, so a custom-role user granted `payroll:operate` passes `requirePermission` then is blocked by Postgres. Pre-existing and system-wide, but this feature is the first to hand payroll *writes* below admin, so it became load-bearing. Spun out to its own session on 2026-07-28 — see [[project_rls_grant_aware_policies]]; confirm that work landed before trusting custom-role payroll access.

Durable design facts:
- **`lib/payroll/dailyGrid.ts` is now the single owner of day-level payroll computation.** `previewService.ts` and the Shifts API route each used to duplicate the Square fetch + tip attribution and had drifted. Extend that module, don't re-duplicate.
- Card-tip attribution was reformulated from a two-step (pool→employee→day) split into **one day-level split**, which is algebraically identical when nothing is overridden. Pinning a cell then falls out of one formula. Uses **largest-remainder** rounding, not per-cell `Math.round`, so attributed tips sum to the pool exactly.
- Maps key on **`square_team_member_id`**, not `employees.id` — chosen so `GuaranteeBucket`/`calculations.ts` need no translation and their tests stay frozen.
- The tipped predicate is `employment_type === "hourly" && receives_tips && active && square_team_member_id`. The **old shifts route pooled on bare `receives_tips`**, diluting the denominator — this branch fixes that Shifts-vs-Summary divergence.
- Shifts GET gate lowered `payrollManage` → `payrollRead` (managers were 403ing on a tab the page granted them). Recorded as `intentionalChange` #28 in `lib/auth/__fixtures__/legacy-matrix.ts`.
- `CAP.payrollDayOverride` reuses the existing `payroll:operate` coordinate — no `ROLE_BUNDLES` change.

- Perf: **fetch/compute must stay split.** Any new caller needing two grids over one period must use `fetchDayGridInputs` once + `computeDailyGrid` per grid. Calling `buildDailyGrid` twice silently restores the 3-sequences-per-extra-grid cost, and tests will not catch it.

Not implemented (deliberate): spec §7's rebalance-span *highlighting* — the banner names the span, but focusing a card-tip cell doesn't highlight the cells that will move.
