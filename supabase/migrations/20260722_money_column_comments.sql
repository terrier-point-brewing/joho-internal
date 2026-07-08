-- Money-unit boundary hardening: label every money column with its unit so the
-- cents<->dollars boundary is explicit at the schema level. This migration ONLY
-- adds column comments; it changes no storage types and converts no data.
--
-- Two units are in use, deliberately:
--   * "integer cents"        — whole minor units (Square's native money format).
--   * "USD dollars (decimal)"— decimal USD; rates and per-unit costs legitimately
--                              need sub-cent precision, so these stay decimal.
--
-- `comment on column` has no `if exists` form, so columns are listed plainly.

-- ── Integer-cent columns ──────────────────────────────────────────────────────

comment on column public.invoices.subtotal_cents is 'integer cents';
comment on column public.invoices.tax_cents is 'integer cents';
comment on column public.invoices.total_cents is 'integer cents';

comment on column public.invoice_line_items.unit_price_cents is 'integer cents';
comment on column public.invoice_line_items.total_cents is 'integer cents';
comment on column public.invoice_line_items.gross_sales_cents is 'integer cents';
comment on column public.invoice_line_items.discount_cents is 'integer cents';
comment on column public.invoice_line_items.net_sales_cents is 'integer cents';
comment on column public.invoice_line_items.tax_cents is 'integer cents';

comment on column public.pos_line_items.base_price_cents is 'integer cents';
comment on column public.pos_line_items.gross_sales_cents is 'integer cents';
comment on column public.pos_line_items.discount_cents is 'integer cents';
comment on column public.pos_line_items.net_sales_cents is 'integer cents';
comment on column public.pos_line_items.tax_cents is 'integer cents';

comment on column public.square_orders.total_cents is 'integer cents';
comment on column public.square_orders.tax_cents is 'integer cents';
comment on column public.square_orders.tip_cents is 'integer cents';
comment on column public.square_orders.discount_cents is 'integer cents';

comment on column public.square_catalog_variations.price_amount is 'integer cents';

comment on column public.manual_net_sales_entries.amount_cents is 'integer cents';

comment on column public.quarterly_targets.target_cents is 'integer cents';

comment on column public.expenses.amount_cents is 'integer cents';

comment on column public.payroll_config.base_rate_cents is 'integer cents';
comment on column public.payroll_config.guaranteed_rate_cents is 'integer cents';

comment on column public.payroll_entries.paycheck_tips_cents is 'integer cents';
comment on column public.payroll_entries.cash_tips_cents is 'integer cents';
comment on column public.payroll_entries.bonus_cents is 'integer cents';
comment on column public.payroll_entries.adj_paycheck_tips_cents is 'integer cents';
comment on column public.payroll_entries.adj_cash_tips_cents is 'integer cents';
comment on column public.payroll_entries.adj_bonus_cents is 'integer cents';

-- ── USD dollars (decimal) columns ─────────────────────────────────────────────

comment on column public.excise_tax_rates.rate_usd is 'USD dollars (decimal)';

comment on column public.export_transaction_taxes.rate_usd is 'USD dollars (decimal)';
comment on column public.export_transaction_taxes.amount_usd is 'USD dollars (decimal)';

comment on column public.export_transactions.total_excise_tax_usd is 'USD dollars (decimal)';

comment on column public.ingredients.cost_per_unit is 'USD dollars (decimal)';

comment on column public.packaging_items.unit_cost is 'USD dollars (decimal)';

comment on column public.stock_adjustments.cost_per_unit is 'USD dollars (decimal)';
comment on column public.stock_adjustments.total_value_change is 'USD dollars (decimal)';
comment on column public.stock_adjustments.shipping_cost is 'USD dollars (decimal)';

comment on column public.packaging_stock_adjustments.cost_per_unit is 'USD dollars (decimal)';
comment on column public.packaging_stock_adjustments.total_value_change is 'USD dollars (decimal)';
comment on column public.packaging_stock_adjustments.shipping_cost is 'USD dollars (decimal)';
