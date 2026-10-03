---
name: project_migration_drift_brew_activities
description: 2026-07-07 fixed prod schema drift — migration 20260719 (brew_activities consolidation) was never applied though
metadata: 
  node_type: memory
  type: project
  originSessionId: 808fa95b-18dc-4621-921a-d7d87ec91056
---

2026-07-07: Export Bay ("export pay") tab showed "Unknown recipe" for everything. Root cause: `/api/production/recipes` was 500-ing because its embed `recipe_brew_activity_templates:brew_activities(*)` queried table `brew_activities`, which **did not exist on the live prod DB**. Migration `supabase/migrations/20260719_brew_activities_consolidation.sql` (from commit #113) was never applied to prod, even though later migrations (through 20260723/#121) were. Confirmed all 4 dropped tables were empty, then applied 20260719 via Supabase MCP `apply_migration` (project drlsazatrcrdwaihjmex) with user OK. Verified: brew_activities 200, old 3 tables 404, brew_step_templates kept.

**Why:** Migrations are applied manually one-at-a-time (per [[feedback_prod_db_migration_authorization]]), so a migration can be silently skipped while later ones land — code ships ahead of schema.

**How to apply:** When a `/api/production/*` route 500s with PGRST200 "could not find relationship", suspect an unapplied migration, not a code bug. Cross-check `supabase/migrations/` filenames against what's actually live (curl the REST endpoint or list_migrations). Other 2026-07 migrations may also be unapplied — worth an audit.
