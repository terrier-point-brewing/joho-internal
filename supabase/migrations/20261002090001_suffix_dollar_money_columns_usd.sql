-- Money-unit legibility: give the dollar-denominated money columns an explicit
-- `_usd` suffix so the unit is readable at the call site.
--
-- This app stores Square amounts as INTEGER CENTS, and most money columns are
-- named `*_cents` accordingly. A handful of columns are `numeric` DOLLARS —
-- per-unit costs and rates legitimately need sub-cent precision, so they stay
-- decimal (see 20260722_money_column_comments.sql, which labelled them but left
-- the names bare). The dangerous ones are the bare-named dollar columns that sit
-- in the same row as a `*_cents` column: `deposit_invoice_ingredients` carries
-- `cost_per_unit` next to `line_total_cents`, and
-- `export_invoice_material_components` carries `unit_cost` next to
-- `line_total_cents`. Reading either row, nothing tells you the two numbers are
-- in different units.
--
-- This is a PURE RENAME. No value is converted, no storage type changes. Whether
-- these should become integer cents is a separate question, deliberately not
-- answered here.
--
-- Columns that already carry an explicit `_usd` suffix
-- (`export_transactions.total_excise_tax_usd`, `export_transaction_taxes.rate_usd`
-- / `.amount_usd`, `excise_tax_rates.rate_usd`) are already legible and are left
-- alone.

-- ── Invoice breakdown snapshots (dollars beside cents in the same row) ────────

alter table public.deposit_invoice_ingredients
  rename column cost_per_unit to cost_per_unit_usd;

alter table public.export_invoice_material_components
  rename column unit_cost to unit_cost_usd;

-- ── Catalog unit costs ───────────────────────────────────────────────────────

alter table public.ingredients
  rename column cost_per_unit to cost_per_unit_usd;

alter table public.packaging_items
  rename column unit_cost to unit_cost_usd;

-- ── Stock adjustments (the COGS source on the P&L) ───────────────────────────

alter table public.stock_adjustments
  rename column cost_per_unit to cost_per_unit_usd;
alter table public.stock_adjustments
  rename column total_value_change to total_value_change_usd;
alter table public.stock_adjustments
  rename column shipping_cost to shipping_cost_usd;

alter table public.packaging_stock_adjustments
  rename column cost_per_unit to cost_per_unit_usd;
alter table public.packaging_stock_adjustments
  rename column total_value_change to total_value_change_usd;
alter table public.packaging_stock_adjustments
  rename column shipping_cost to shipping_cost_usd;

-- ── Re-apply the unit comments onto the new names ────────────────────────────
-- `rename column` carries the comment across, but the two breakdown-snapshot
-- columns were never commented (both tables postdate the comment migration or
-- were missed by it), so state all ten explicitly.

comment on column public.deposit_invoice_ingredients.cost_per_unit_usd is 'USD dollars (decimal)';
comment on column public.export_invoice_material_components.unit_cost_usd is 'USD dollars (decimal)';
comment on column public.ingredients.cost_per_unit_usd is 'USD dollars (decimal)';
comment on column public.packaging_items.unit_cost_usd is 'USD dollars (decimal)';
comment on column public.stock_adjustments.cost_per_unit_usd is 'USD dollars (decimal)';
comment on column public.stock_adjustments.total_value_change_usd is 'USD dollars (decimal)';
comment on column public.stock_adjustments.shipping_cost_usd is 'USD dollars (decimal)';
comment on column public.packaging_stock_adjustments.cost_per_unit_usd is 'USD dollars (decimal)';
comment on column public.packaging_stock_adjustments.total_value_change_usd is 'USD dollars (decimal)';
comment on column public.packaging_stock_adjustments.shipping_cost_usd is 'USD dollars (decimal)';

-- ── Guard: nothing else in the database may still name the old columns ───────
-- `alter table ... rename column` rewrites views and constraints that depend on
-- the column, but NOT function bodies — those are stored as text. If a function
-- or view still mentions an old name it would fail at call time, not now, so
-- fail the migration instead and force the reference to be fixed here.

do $$
declare
  offender text;
begin
  select string_agg(name, ', ')
  into offender
  from (
    select n.nspname || '.' || p.proname || '()' as name
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not in ('pg_catalog', 'information_schema', 'extensions')
      and p.prokind in ('f', 'p')
      and pg_get_functiondef(p.oid) ~ '\m(cost_per_unit|total_value_change|shipping_cost|unit_cost)\M'
    union all
    select 'view ' || schemaname || '.' || viewname
    from pg_views
    where schemaname not in ('pg_catalog', 'information_schema', 'extensions')
      and definition ~ '\m(cost_per_unit|total_value_change|shipping_cost|unit_cost)\M'
  ) s;

  if offender is not null then
    raise exception
      'Old money-column names are still referenced by: %. Update those definitions in this migration.',
      offender;
  end if;
end $$;
