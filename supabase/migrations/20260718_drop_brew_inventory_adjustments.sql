-- Drop brew_inventory_adjustments (schema audit / 2026-07 cleanup).
--
-- Baseline-era finished-beer ledger with 0 live rows and NO writer: its POST
-- route (app/api/production/brew-adjustments) was never wired to any UI, and no
-- RPC/trigger writes it. Finished-beer corrections are handled by
-- cold_storage_inventory (built later). The former readers (demand-calendar,
-- batch-scheduler, BrewsSubtab, SafetyStockTab, StockAdjustmentsTab) summed its
-- always-zero adjustments into on-hand; those reads are removed in this same
-- change. Its FK to batch_transfers, its brew_inv_adj_transfer_idx index, and its
-- audit trigger drop automatically with the table. Nothing FKs into it.

drop table if exists public.brew_inventory_adjustments;
