---
name: project_taproom_sync_race
description: 2026-07-10 taproom draft-swap duplicate rows = webhook-triggered concurrency race; fix + cleanup PENDING manual prod apply
metadata: 
  node_type: memory
  type: project
  originSessionId: 821fe904-5bba-46a1-b1fa-0b8ff22dcea6
---

Taproom "draft recount" shipments were duplicating (one 1/6-keg swap showing as 5–6 rows). **Root cause: a read-then-write race.** The Square webhook (`app/api/webhooks/square/route.ts`) fires the full `runTaproomConsumptionSync` on every `order.*` event, so one Draft Restock's event burst ran ~6 syncs concurrently. Each read `recordedByRef` = "0 already recorded" for the swap's `source_ref` before any committed, so each wrote its own duplicate `export_transactions` row AND drained `cold_storage_inventory`. Proof: N rows per `source_ref`, each qty 1, written within <0.3s, each with a **different `shipment_id`** (fresh UUID per run).

**Fix (PR #150, branch claude/taproom-transaction-dates-f76cbd, not yet merged):**
- `supabase/migrations/20260726_taproom_sync_lock.sql` — new `sync_locks` lease table + `try_acquire_sync_lock`/`release_sync_lock` fns (search_path pinned, service_role-only, RLS on). **APPLIED to prod 2026-07-10.**
- `lib/production/taproomConsumptionSync.ts` — acquires lease (job `taproom_consumption_sync`, TTL 300s), **skips entirely if held**, releases in `finally`. Added `lockSkipped` to `TaproomSyncResult`.
- `scripts/cleanup-taproom-draftswap-duplicates.sql` — one-time data cleanup (NOT a migration, won't auto-apply). Dedupes the 2 affected refs (keep earliest) and restores the ~9 over-drained 1/6-keg units: cold_storage `eef32077` 4→8 (B-029 Epic Hazy), `429fdf01` 3→8 (B-044 Carolina Pale Ale). **PENDING review + backup + manual run.** Open item: B-044 is status='complete' — confirm still correct after restoring inventory (script does NOT touch batch status).

All-time blast radius was small: 7 real swaps, only 2 duplicated (5× and 6×). Same-branch sibling fix: taproom shipments date-label bug (UTC slice + unanchored `fmt`) in `ShipmentsTab.tsx`. See [[feedback_prod_db_migration_authorization]].
