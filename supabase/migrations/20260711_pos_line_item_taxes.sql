-- pos_line_item_taxes: store per-line Square tax breakdown for tax reporting
--
-- One row per tax applied to a POS line item. Links to Square's tax IDs and
-- stores the breakdown (tax name, rate, amount) for import into tax filing systems.
--
-- Follows the finance-table service-role-only access pattern: RLS enabled,
-- no authenticated access (service_role bypasses RLS).

create table if not exists public.pos_line_item_taxes (
  id               uuid        primary key default gen_random_uuid(),
  line_item_id     uuid        not null references public.pos_line_items(id) on delete cascade,
  square_tax_id    text        not null,
  tax_name         text,
  tax_pct          numeric,
  amount_cents     integer     not null default 0,
  created_at       timestamptz not null default now()
);

-- ── indexes ───────────────────────────────────────────────────────────────────

create index if not exists pos_line_item_taxes_line_item_id_idx
  on public.pos_line_item_taxes (line_item_id);

create index if not exists pos_line_item_taxes_square_tax_id_idx
  on public.pos_line_item_taxes (square_tax_id);

-- ── column comments ───────────────────────────────────────────────────────────

comment on column public.pos_line_item_taxes.amount_cents is 'tax applied to this line by this tax, in cents';

-- ── RLS (service-role-only) ───────────────────────────────────────────────────

alter table public.pos_line_item_taxes enable row level security;

-- Finance tables are read/written exclusively via the service-role admin client,
-- which bypasses RLS. The policy below denies all authenticated-role access
-- (finance_reader_roles() returns an empty array); service_role is unaffected.
create policy "finance readers" on public.pos_line_item_taxes
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );
