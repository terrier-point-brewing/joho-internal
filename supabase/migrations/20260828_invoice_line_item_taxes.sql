-- invoice_line_item_taxes: per-line Square tax breakdown for invoice-backed
-- orders. Structurally identical to pos_line_item_taxes (20260711), one table
-- over, so fetchTaxableBase and fetchTaxAccruals each union two sources of one
-- row shape instead of growing a second code path.
--
-- Needed because invoice_line_items stores only a scalar tax_cents with no
-- authority attribution, so invoice-collected tax was invisible to the NC DOR
-- worksheets.

create table if not exists public.invoice_line_item_taxes (
  id            uuid        primary key default gen_random_uuid(),
  line_item_id  uuid        not null references public.invoice_line_items(id) on delete cascade,
  square_tax_id text        not null,
  tax_name      text,
  tax_pct       numeric,
  amount_cents  integer     not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists invoice_line_item_taxes_line_item_id_idx
  on public.invoice_line_item_taxes (line_item_id);

create index if not exists invoice_line_item_taxes_square_tax_id_idx
  on public.invoice_line_item_taxes (square_tax_id);

comment on column public.invoice_line_item_taxes.amount_cents is 'tax applied to this line by this tax, in cents';

alter table public.invoice_line_item_taxes enable row level security;

create policy "finance readers" on public.invoice_line_item_taxes
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );

-- RENUMBERED 2026-07-28: originally 20260826_invoice_line_item_taxes.sql. PR #285 merged first and had
-- already claimed that prefix, so this file moved to keep every migration
-- version unique. Already applied to prod under the old name; the rename is
-- repo hygiene only and re-applies nothing.
