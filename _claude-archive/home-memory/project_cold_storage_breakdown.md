---
name: project_cold_storage_breakdown
description: 2026-07-08 cold-storage pack break-down feature (PR
metadata: 
  node_type: memory
  type: project
  originSessionId: 4459796e-b20b-49f5-9910-9bf3b06f7308
---

Branch `claude/cold-storage-inventory-check-a85da3`, PR #122 (open, base main). Two deliverables:

1. **Auto pack break-down** — taproom can-sale of a lower tier than what's stocked auto-cracks a higher tier (case→pack→single, one level at a time, smallest-first, taproom path only; wholesale/`writeColdStorageShipment` untouched). New `cold_storage_breaks` journal table (migration `20260717`); pure `planBreakDown`/`deriveCansEach` + IO `applyBreakDown` in `lib/production/`; wired into `recordTaproomConsumption`. Can-identity family key = null-safe `(container_id, lid_id, label_id, partner_id)`, tier = `(format, paktech_id, tray_id)`. Pack size from `total_volume_fl_oz` (NOT the shared paktech `can_count`).

2. **Physical reconciliation** (migration `20260718`) — absolute trueup of `cold_storage_inventory` to the 2026-07-07 cold-room count; first-classes 4-Pack lots. Post-count adjustment: 9 Carolina Pale Ale 16oz 4-packs sold (Square 2026-07-07, only packaged sale since count) drew from the 6 sealed cases → CPA seated as Case 4 + 4-Pack 3 (draft sales don't draw cold storage until a keg-swap recount). Dry-run verified post-state == adjusted count for all 14 recipes.

**⚠️ Neither migration is applied to prod.** Per repo policy, apply MANUALLY with a snapshot first. Apply `20260717` (additive table) before `20260718` (data). Re-applying `20260718` overwrites later movement — one-shot.

**Accepted tradeoffs (documented in code, owner-decided):** executor is non-atomic (3 writes/break, parent-first = understates-not-oversells) → accept + document; taproom sale can crack a sealed wholesale case when only cases stocked → accept silently (no reservation overlay; every break journaled).

Resolved: the 12oz "6-Pack" data bug (volume 48→72 fl oz) was fixed directly by correcting the paktech in packaging inventory; `deriveCansEach` no longer warns. Relates to [[project_three_channel_invoicing]], [[project_backfill_state]].
