-- Drop the legacy workflow-template system (schema audit finding S8 / 2026-07 cleanup).
--
-- `workflow_templates` + `workflow_template_steps` were the ORIGINAL batch-workflow
-- model. They hold 0 live rows and are superseded by the brew-step / brew-activity
-- template system. The only code referencing them (the two
-- app/api/production/workflow-templates route files and two interfaces in
-- app/production/types.ts) is removed in this same change; there is no UI caller,
-- test, or other table FK'ing into them. Their audit triggers
-- (audit_workflow_templates, audit_workflow_template_steps) drop automatically with
-- the tables. Child table dropped first.

drop table if exists public.workflow_template_steps;
drop table if exists public.workflow_templates;
