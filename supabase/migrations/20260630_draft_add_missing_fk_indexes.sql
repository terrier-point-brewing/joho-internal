-- DRAFT — DO NOT APPLY WITHOUT REVIEW
--
-- Finding S6 (schema audit 2026-06-30): 66 foreign-key columns in the public schema
-- have no covering index. Cascade deletes and joins on the parent therefore fall back
-- to sequential scans. Source: cross-check of pg_constraint (contype='f') against
-- pg_index leading-column coverage on the live DB (project drlsazatrcrdwaihjmex),
-- read-only.
--
-- This change is ADDITIVE and non-destructive: it only creates indexes. It was NOT run.
-- Reviewer notes:
--   * `IF NOT EXISTS` guards make this idempotent / safe to re-run.
--   * Tables are small today, so plain CREATE INDEX is fine. If applying against prod
--     under load, switch each to `CREATE INDEX CONCURRENTLY` (and run outside a txn).
--   * This file lists ALL 66 missing-FK-index columns found. Trim to taste before
--     applying if some columns are never used as a join/delete predicate.

-- batch_allocations
create index if not exists idx_batch_allocations_contract_request_id on public.batch_allocations (contract_request_id);
-- batch_brew_activity_log
create index if not exists idx_batch_brew_activity_log_template_id on public.batch_brew_activity_log (template_id);
-- batch_conversions
create index if not exists idx_batch_conversions_source_equipment_id on public.batch_conversions (source_equipment_id);
create index if not exists idx_batch_conversions_target_batch_id on public.batch_conversions (target_batch_id);
-- batch_status_history
create index if not exists idx_batch_status_history_batch_id on public.batch_status_history (batch_id);
-- batch_tank_assignments
create index if not exists idx_batch_tank_assignments_batch_id on public.batch_tank_assignments (batch_id);
-- batch_transfers
create index if not exists idx_batch_transfers_batch_id on public.batch_transfers (batch_id);
create index if not exists idx_batch_transfers_created_by on public.batch_transfers (created_by);
create index if not exists idx_batch_transfers_from_tank_id on public.batch_transfers (from_tank_id);
create index if not exists idx_batch_transfers_to_batch_id on public.batch_transfers (to_batch_id);
create index if not exists idx_batch_transfers_to_tank_id on public.batch_transfers (to_tank_id);
create index if not exists idx_batch_transfers_variation_id on public.batch_transfers (variation_id);
-- brew_batches
create index if not exists idx_brew_batches_converted_from_batch_id on public.brew_batches (converted_from_batch_id);
create index if not exists idx_brew_batches_recipe_id on public.brew_batches (recipe_id);
-- brew_step_template_steps
create index if not exists idx_brew_step_template_steps_template_id on public.brew_step_template_steps (template_id);
-- chart_of_accounts
create index if not exists idx_chart_of_accounts_parent_id on public.chart_of_accounts (parent_id);
create index if not exists idx_chart_of_accounts_uploaded_by on public.chart_of_accounts (uploaded_by);
-- cold_storage_inventory
create index if not exists idx_cold_storage_inventory_recipe_id on public.cold_storage_inventory (recipe_id);
create index if not exists idx_cold_storage_inventory_source_transfer_id on public.cold_storage_inventory (source_transfer_id);
-- commitment_packaging_preferences
create index if not exists idx_commitment_packaging_preferences_variation_id on public.commitment_packaging_preferences (variation_id);
-- commitments
create index if not exists idx_commitments_partner_id on public.commitments (partner_id);
create index if not exists idx_commitments_recipe_id on public.commitments (recipe_id);
-- events
create index if not exists idx_events_created_by on public.events (created_by);
-- export_transaction_taxes
create index if not exists idx_export_transaction_taxes_excise_tax_rate_id on public.export_transaction_taxes (excise_tax_rate_id);
-- export_transactions
create index if not exists idx_export_transactions_packaging_item_id on public.export_transactions (packaging_item_id);
create index if not exists idx_export_transactions_recipe_id on public.export_transactions (recipe_id);
create index if not exists idx_export_transactions_recipient_id on public.export_transactions (recipient_id);
create index if not exists idx_export_transactions_source_transfer_id on public.export_transactions (source_transfer_id);
-- ingredients
create index if not exists idx_ingredients_partner_id on public.ingredients (partner_id);
create index if not exists idx_ingredients_supplier_id on public.ingredients (supplier_id);
-- invoice_batch_links
create index if not exists idx_invoice_batch_links_created_by on public.invoice_batch_links (created_by);
-- invoice_item_mappings
create index if not exists idx_invoice_item_mappings_packaging_item_id on public.invoice_item_mappings (packaging_item_id);
create index if not exists idx_invoice_item_mappings_partner_id on public.invoice_item_mappings (partner_id);
-- invoice_line_items
create index if not exists idx_invoice_line_items_bs_chart_of_accounts_id on public.invoice_line_items (bs_chart_of_accounts_id);
create index if not exists idx_invoice_line_items_delivery_invoice_id on public.invoice_line_items (delivery_invoice_id);
create index if not exists idx_invoice_line_items_pl_chart_of_accounts_id on public.invoice_line_items (pl_chart_of_accounts_id);
-- packaging_items
create index if not exists idx_packaging_items_partner_id on public.packaging_items (partner_id);
create index if not exists idx_packaging_items_supplier_id on public.packaging_items (supplier_id);
-- packaging_stock_adjustments
create index if not exists idx_packaging_stock_adjustments_batch_transfer_id on public.packaging_stock_adjustments (batch_transfer_id);
-- packaging_variations
create index if not exists idx_packaging_variations_label_id on public.packaging_variations (label_id);
create index if not exists idx_packaging_variations_lid_id on public.packaging_variations (lid_id);
create index if not exists idx_packaging_variations_paktech_id on public.packaging_variations (paktech_id);
create index if not exists idx_packaging_variations_tray_id on public.packaging_variations (tray_id);
-- pay_periods
create index if not exists idx_pay_periods_locked_by on public.pay_periods (locked_by);
-- payroll_entries
create index if not exists idx_payroll_entries_employee_id on public.payroll_entries (employee_id);
-- pos_line_items
create index if not exists idx_pos_line_items_chart_of_accounts_id on public.pos_line_items (chart_of_accounts_id);
-- recipe_ingredients
create index if not exists idx_recipe_ingredients_ingredient_id on public.recipe_ingredients (ingredient_id);
create index if not exists idx_recipe_ingredients_recipe_id on public.recipe_ingredients (recipe_id);
-- recipe_packaging_variations
create index if not exists idx_recipe_packaging_variations_variation_id on public.recipe_packaging_variations (variation_id);
-- recipe_square_links
create index if not exists idx_recipe_square_links_catalog_item_id on public.recipe_square_links (catalog_item_id);
create index if not exists idx_recipe_square_links_catalog_variation_id on public.recipe_square_links (catalog_variation_id);
create index if not exists idx_recipe_square_links_packaging_item_id on public.recipe_square_links (packaging_item_id);
-- recipes
create index if not exists idx_recipes_partner_id on public.recipes (partner_id);
-- square_catalog_variations
create index if not exists idx_scv_bs_chart_of_accounts_id on public.square_catalog_variations (bs_chart_of_accounts_id);
create index if not exists idx_scv_catalog_item_id on public.square_catalog_variations (catalog_item_id);
create index if not exists idx_scv_chart_of_accounts_id on public.square_catalog_variations (chart_of_accounts_id);
create index if not exists idx_scv_chart_of_accounts_id_invoice on public.square_catalog_variations (chart_of_accounts_id_invoice);
create index if not exists idx_scv_chart_of_accounts_id_pos on public.square_catalog_variations (chart_of_accounts_id_pos);
create index if not exists idx_scv_pl_chart_of_accounts_id on public.square_catalog_variations (pl_chart_of_accounts_id);
-- stock_adjustments
create index if not exists idx_stock_adjustments_batch_id on public.stock_adjustments (batch_id);
create index if not exists idx_stock_adjustments_ingredient_id on public.stock_adjustments (ingredient_id);
-- system_settings
create index if not exists idx_system_settings_updated_by on public.system_settings (updated_by);
-- tap_assignments
create index if not exists idx_tap_assignments_recipe_id on public.tap_assignments (recipe_id);
-- workflow_template_steps  (NOTE: table is a drop candidate — see S8; skip if dropping)
create index if not exists idx_workflow_template_steps_equipment_id on public.workflow_template_steps (equipment_id);
create index if not exists idx_workflow_template_steps_template_id on public.workflow_template_steps (template_id);
