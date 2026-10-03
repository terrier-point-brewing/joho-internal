---
name: project_floorplan_batchlog_export_fixes
description: "PR #295 (Production floorplan/batch-log/export fixes) — merged, all 3 migrations applied and verified. Only gate left is that the new UI has never been seen in a browser."
metadata: 
  node_type: memory
  type: project
  originSessionId: b76f0935-7493-44c2-b20b-ebc9d49053fe
  modified: 2026-07-29T18:32:14.361Z
---

2026-07-29, **PR #295 MERGED** (`e3691df`). Seven Production fixes: partial-transfer
default, Up Next ghosts, canning packaging loss %, yeast re-pitch, shortfall
over-reporting, shortfall detail modal, multi-line Export Bay Ship.

## ✅ Migrations — all three APPLIED & verified (2026-07-29)

| Migration | State |
|---|---|
| `20260829_packaging_loss_and_yeast_repitch.sql` (schema) | ✅ applied on the **second** pass |
| `20260830_release_stale_ingredient_commitments.sql` (data) | ✅ applied — 0 stale rows remain |
| `20260831_cancel_fulfilled_packaging_ghosts.sql` (data) | ✅ applied — B-038 ghost `95f675a7` cancelled |

**The near-miss worth remembering:** the first "migrations applied" report was
partial — both DATA migrations landed while the SCHEMA one was silently skipped.
That combination is invisible from the app's read paths (row reads work fine) but
had broken **every export transaction write** (`exportTransactionWriter.ts:84`
inserts `packaging_loss_pct`, error checked, so Ship / ad-hoc export / taproom
consumption sync / phantom exports all threw) plus invoice preview
(`exportInvoicePreview.ts:414,502`). Taproom sync runs on a schedule, so it was
failing in the background rather than surfacing to a user.

Post-apply verification that closed it: all 4 columns `PRESENT` on SELECT; write
path OK (no `PGRST204`, so PostgREST's cache reloaded); defaults correct on every
existing row (129/129 batch_transfers, 317/317 export_transactions, 30/30
brew_batches); the 0–100 check constraint rejects 150 with `23514`; and a probe
insert of the real `export_transactions` column set reached `23503` (fake FK) —
proving every column resolved.

## Durable: 42703 vs PGRST204 tells you WHICH failure you have

A missing column surfaces two different ways and they need different fixes:
- **`42703` on a SELECT** — Postgres itself rejected it. The column genuinely does
  not exist → apply the migration.
- **`PGRST204` on an INSERT/UPDATE** — "Could not find the 'x' column … in the schema
  cache". Ambiguous: either genuinely absent, OR present-but-PostgREST-cache-stale
  → reload the schema cache first.

Always probe with a **SELECT** to disambiguate; the write path alone can't tell you.
Related: [[project_migration_drift_brew_activities]], [[project_draft_swap_tap_transitions]].

## Durable: "migrations applied" is a claim to verify, not accept

The user applied 2 of 3 and reported all 3 done, in good faith. A 20-line read-only
probe (select each new column, count the rows each data migration should have changed)
caught it before cleanup. Do this on EVERY "migrations applied" — this index has a
documented history of stale APPLIED/PENDING claims.

## Durable: shortfall priority ordering, and the clamp bug

`getShortfalls` now allocates stock to pre-brew batches in `planned_brew_date` order
(earlier date wins; undated sorts last; same-date ties break on `batch_id`), and
ignores commitments held by batches past planning.

⚠️ Available stock **must be clamped at zero** before subtracting this batch's need.
Without the clamp an earlier batch's own unmet deficit rolls forward: B-056 read
"needs 450 lb Pilsner, short 1110" (its 450 + B-054's missing 660). Caught only by
replaying the new logic against live prod data — the unit tests all passed.

Prod result: B-034 went 9 shorts → 1 (Wy1318, genuinely 0 stock) → 0 as a re-pitch.

## Durable: Up Next ghosts come from the claw-back

When an unscheduled kegging/canning run happens, `transfers/route.ts` claws its volume
out of the next open packaging entry. That drove `volume_bbl` to 0 but left the entry
OPEN, so it stayed a pending action forever — B-038 advertised a 2026-07-14 Canning
action for months after completing. Entries exhausted this way are now cancelled at
the source. If Up Next shows stale work again, look for zero-volume open packaging
entries first.

## Not verified in a browser

Login wall again — the shortfall modal, re-pitch checkbox, multi-line Ship rows and
canning loss field have never been seen rendered. Floorplan pieces need a **brewer**
account; Ship needs `exportOperate`. Same gap as #290/#292/#293.
