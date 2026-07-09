-- ============================================================================
-- RLS rollout, Phase 2 — drop the backup + drift tables locked deny-all in
-- Phase 1 (20260709_enable_rls_phase1), removing them from the attack surface
-- and the schema entirely.
--
-- Verified before writing (2026-07-09, prod drlsazatrcrdwaihjmex):
--   * No application code references any of these tables (grep app/ lib/).
--   * No view or function depends on them (pg_depend/pg_rewrite check clean).
--   * The only inbound FK is workflow_template_steps -> workflow_templates
--     (both dropped here; child first, so no CASCADE needed).
--   * Row counts snapshotted before drop: brew_batches_bak_20260704 (24),
--     cold_storage_inventory_bak_20260704 (23),
--     cold_storage_inventory_bak_20260707 (40); the three drift tables empty.
--
-- This consolidates + completes three drop migrations that were committed but
-- never applied to prod (the migration drift that left these tables live):
--   20260717_drop_workflow_templates, 20260718_drop_brew_inventory_adjustments,
--   20260720_drop_backup_tables — plus cold_storage_inventory_bak_20260707,
--   which never had a drop migration. All statements are idempotent, so this is
--   safe whether or not any of those earlier migrations eventually run.
--
-- Each table's audit triggers, indexes, and FKs drop automatically with it.
-- ============================================================================

-- Legacy workflow-template system (superseded by brew-step / brew-activity
-- templates). Child table first to satisfy the FK.
drop table if exists public.workflow_template_steps;
drop table if exists public.workflow_templates;

-- Baseline-era finished-beer ledger, superseded by cold_storage_inventory.
drop table if exists public.brew_inventory_adjustments;

-- Ad-hoc point-in-time snapshots from the 2026-07-04/07 batch-conversion and
-- cold-storage reconciliation work.
drop table if exists public.brew_batches_bak_20260704;
drop table if exists public.cold_storage_inventory_bak_20260704;
drop table if exists public.cold_storage_inventory_bak_20260707;
