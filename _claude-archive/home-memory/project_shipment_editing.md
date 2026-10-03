---
name: project-shipment-editing
description: "Shipment editing phase 1 (channel/recipient/notes) — built on branch claude/shipment-editing-feature-b1e762; migration 20260906120000 PENDING, browser check not done"
metadata: 
  node_type: memory
  type: project
  originSessionId: d7af45fb-746e-40c9-a21b-d41d771d881a
  modified: 2026-07-30T22:50:39.905Z
---

Worktree + both branches cleaned up 2026-07-31.
Phase 1 of shipment editing, built 2026-07-30 on `claude/shipment-editing-feature-b1e762`.
**PR #307 MERGED** 2026-07-30 as `e983484` (squash). Migration APPLIED.
Edit a booked shipment's channel / recipient / notes from Production → Shipments.

✅ Migration `20260906120000_export_transaction_edit.sql` applied 2026-07-30.

⚠️ **Never seen in a browser** — the local dev server sits behind a login wall.
Compile + route wiring verified only (307 to /login, no compile errors).
See [[project_floorplan_batchlog_export_fixes]] for why this matters.

**Design decisions worth remembering:**

- `export_transactions` had **no audit trigger** — the `batch_exports` table it
  replaced in `20260622` had `audit_batch_exports`, and it was never carried
  over. The migration closes that gap by reusing `audit_trigger_fn()`; no new
  edit-history table. This also retroactively covers the unguarded
  `/api/production/exports/[id]` PATCH/DELETE.
- **A shipment can legitimately span several channels.** `planCreditedWrites`
  stamps each credited row with its OWN allocation's channel and over-delivery
  rows with a fallback. So "all rows share one channel" is a WRONG guard — it
  would block exactly the contract shipments meant to be editable. The edit
  collapses a mixed shipment to the target instead.
- **Credit release keys off `allocation_id`, not channel**, for the same reason:
  a credited row can carry a soft channel.
- The edit is **shipment-scoped, not row-scoped**, because
  `resolveInvoiceChannel` refuses mixed-channel invoices — a partial edit would
  strand the remainder as permanently un-invoiceable.
- `checkAndFulfillCommitment` was forward-only; `recheckCommitmentFulfillment`
  is the reversible sibling (`fulfilled → open`, never `brewing`, since
  fulfillment only fires on a `complete` batch).
- Adding a route means bumping the **frozen counts** in
  `lib/auth/__tests__/equivalence.test.ts` (rows, and assertions = rows × 4
  roles). They are a deliberate drift guard, not a test bug.

**Phase 2 (`→ contract_brewing`) designed but NOT built.** Spec §6. Needs an
`excludeShipmentId` on `loadShipReserveContext` (the loader counts the shipment
being edited, so `planShipment` double-subtracts the drain and emits spurious
`guarantee_coverage` warnings), the row-split extracted from
`writeColdStorageShipment`, a preview surface for the planner's warnings, and an
atomic plpgsql RPC for the delete+insert.

**Pre-existing hazard (spec §7) — route DELETED in PR #309**, merged 2026-07-31 as `391afd7`.
`app/api/production/exports/[id]` was UI-unreferenced and unsafe: `DELETE` dropped a
ledger row without restoring cold storage (and cascaded away its excise-tax children,
breaking reconciliation against filed periods); `PATCH` set `volume_bbl` without
recomputing excise tax. Booking does deplete → write → complete → fulfill; the route
undid/mutated only the write, and the other three are forward-only. A real "unship"
(restore stock, reopen batch, recheck commitment, detach invoice) is still unbuilt.

Spec: `docs/superpowers/specs/2026-07-30-shipment-editing-design.md`
Plan: `docs/superpowers/plans/2026-07-30-shipment-editing-phase-1.md`
