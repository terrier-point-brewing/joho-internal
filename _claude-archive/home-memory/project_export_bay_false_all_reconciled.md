---
name: project-export-bay-false-all-reconciled
description: "2026-07-28 fix — Export Bay reported \"All reconciled\" over 4 open draft recounts; three defects, branch claude/unknown-draft-recounts-c29257, no migration"
metadata: 
  node_type: memory
  type: project
  originSessionId: abc24b1b-a4fd-4815-a6f3-9aba276e2dd9
  modified: 2026-07-29T02:48:55.329Z
---

2026-07-28. Shipments tab showed 4 "Unknown" draft recounts while Export Bay said
"All reconciled". **PR #293 MERGED**, squashed to `1ad8ca5` on main. 8 files
+220/-11. **No migration.** Worktree and branch cleaned up.

Three independent defects:

1. **False all-clear from absent data.** `phantomAlertsData?.alerts ?? []` in
   `ExportBayTab.tsx` collapsed pending/401/403/500/network into `[]`, and `[]`
   rendered "⚑ All reconciled". Fixed by branching on TanStack `status`.
2. **GET gated at `operate`.** `phantom-alerts/route.ts` required
   `taproom.performance:operate`; brewer reaches the tab via
   `production.export:operate` but holds only `taproom.performance:read` → every
   brewer 403'd, rendered by defect 1 as a clean bill of health. Lowered to
   `taproomPerformanceRead`; legacy-matrix row gained an `intentionalChange`
   (`{brewer: true, viewer: true}`), count 52 → 53 in `equivalence.test.ts`.
3. **Dismissal decoupled the two views.** `reconcilePhantom.ts` — *resolve*
   writes `batch_id` + `alert_acknowledged_at`; *dismiss* writes only
   `alert_acknowledged_at`, so the row stays batchless **forever**. Export Bay
   stops counting it, Shipments shows a permanent bare "Unknown". Now labelled
   "No cold-storage stock" (dismissed) / "Unreconciled" (open) via
   `lib/production/draftRecountState.ts`.

Durable, beyond this fix: **a batchless `export_transactions` row still has a
`recipe_id`.** The old `brew_batches?.beer_name ?? "Unknown"` implied corrupt
data where there was none — the exports route now also selects `recipes(beer_name)`
and the client falls through to it. See [[project_draft_swap_tap_transitions]].

Verification gap: could not sign in (password entry prohibited) and `.env.local`
could not be symlinked (`ln -sf` denied by the permission classifier), so the UI
was never seen in a browser and `npm run build` fails at prerender on the missing
env var. Verified instead by running the real `fetchOpenPhantomAlerts` pipeline
against prod (returns 4 alerts, no error) and curling the exact new PostgREST
select (HTTP 200). `npm run verify` green: 2260 tests.
