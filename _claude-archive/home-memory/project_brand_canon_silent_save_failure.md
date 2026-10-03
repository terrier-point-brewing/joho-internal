---
name: project-brand-canon-silent-save-failure
description: "2026-07-28, PR #282 MERGED + migration 20260809 APPLIED — Brand Guide silently refused to save because canonWorkflow discarded every Supabase error."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4d40b6a7-ea46-41f1-ab6d-8f874c658f8b
  modified: 2026-07-29T02:09:01.716Z
---

Brand Guide edits (e.g. Ethos Introduction) appeared to save and publish but never
changed the content. **PR #282 MERGED** (squash `f26ea5c`) 2026-07-28; worktree
removed and branch deleted. **RESOLVED — nothing pending.**

Two defects stacked:

1. **Prod was missing `20260809_brand_canon_draft.sql`** — `brand_canon_versions`
   had no `updated_at` column. `saveDraft()` writes it on every save, so every
   save was rejected with `PGRST204` / `42703`. Note `20260810` (brand_assets)
   **was** applied — 20260809 got skipped in the human-gated apply order. See
   [[project_migration_drift_brew_activities]].
2. **`lib/brand/canonWorkflow.ts` discarded every Supabase `{ error }`** — so a
   rejected write was indistinguishable from a success. The route answered
   `{ ok: true }`, no banner, and Publish then snapshotted an unchanged draft.

Diagnostic that nailed it: prod showed five publishes (1.0 → 1.4) whose **draft
and published documents were byte-identical**. Publish was working correctly —
it was faithfully publishing a draft that had never changed.

✅ Migration **20260809 APPLIED** 2026-07-28 15:05 UTC (all 6 rows backfilled with
the `now()` default). Verified after: the exact `saveDraft`-shaped write
(`document` + `updated_at`) that previously returned `PGRST204`/400 now returns
`204`.

**Why:** Supabase's JS client *resolves* with `{ error }` rather than throwing.
An unchecked `await client.from(t).update(...)` is byte-for-byte
indistinguishable from a success at the call site — this is the single easiest
way to ship a write path that reports `ok: true` while writing nothing.

**How to apply:** in any `lib/` module wrapping Supabase, destructure and check
`error` on **every** query — selects included, not just writes. PR #282 added
`assertOk(error, action)` in canonWorkflow for this. When a feature "saves" but
the content never changes, check for a swallowed `{ error }` before suspecting
caching or React state. Related: [[project_brand_guide_intro_blocks]],
[[project_brand_design_system]], [[feedback_prod_db_migration_authorization]].
