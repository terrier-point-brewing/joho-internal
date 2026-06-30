-- DRAFT — DO NOT APPLY WITHOUT REVIEW
--
-- Finding S8 (schema audit 2026-06-30): `workflow_templates` and `workflow_template_steps`
-- are the ORIGINAL batch-workflow system. They are superseded by:
--   * brew_step_templates / brew_step_template_steps  (used by RecipesTab.tsx,
--     BrewStepTemplatesTab.tsx), and
--   * recipe_brew_activity_templates.
--
-- Evidence this is dead:
--   * 0 live rows in both tables (pg_stat_user_tables, read-only).
--   * No UI fetch caller for the /api/production/workflow-templates routes (ripgrep over
--     app/**/*.tsx finds none; brew-step-templates IS fetched by two components).
--   * The two route files app/api/production/workflow-templates/route.ts and
--     .../[id]/route.ts are the only code referencing these tables (see dead-code audit).
--
-- GATE BEFORE APPLYING:
--   * Confirm no external automation / cron / Square webhook hits the workflow-templates
--     routes. If safe, also delete the two route files (dead-code report) in the same PR.
--   * Drop order matters: child first.
--
-- NOT RUN. No DDL executed against the live DB.

drop table if exists public.workflow_template_steps;
drop table if exists public.workflow_templates;
