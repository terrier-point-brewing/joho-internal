-- Invoice ledger: stores QB-imported and (future) Square-synced invoices.
-- Separate from the live Square API calls used by /api/finance/sales/invoices.

-- ── invoices ──────────────────────────────────────────────────────────────────
create table invoices (
  id              uuid        primary key default gen_random_uuid(),
  source          text        not null check (source in ('quickbooks', 'square')),
  external_id     text        not null,   -- QB invoice number or Square invoice ID
  invoice_number  text,
  invoice_date    date,
  due_date        date,
  customer_name   text,
  -- Optional FK to contract_brewing_partners; set during reconciliation
  partner_id      uuid        references contract_brewing_partners(id) on delete set null,
  status          text        not null default 'unknown'
                              check (status in ('open', 'paid', 'voided', 'partial', 'unknown')),
  subtotal_cents  bigint      not null default 0,
  tax_cents       bigint      not null default 0,
  total_cents     bigint      not null default 0,
  notes           text,
  raw_data        jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (source, external_id)
);

-- ── invoice_line_items ────────────────────────────────────────────────────────
create table invoice_line_items (
  id              uuid        primary key default gen_random_uuid(),
  invoice_id      uuid        not null references invoices(id) on delete cascade,
  sort_order      integer     not null default 0,
  description     text,
  -- Mirrors the categories used by /api/finance/sales/invoices route
  category        text        check (category in (
                    'materials_packaging', 'packaging_fees', 'other_services',
                    'pass_through_taxes', 'distribution_keg', 'distribution_can', 'other'
                  )),
  quantity        numeric     not null default 1,
  unit_price_cents bigint     not null default 0,
  total_cents     bigint      not null default 0,
  variation_name  text,       -- keg size / can format for packaging fees
  raw_data        jsonb,
  created_at      timestamptz not null default now()
);

-- ── invoice_batch_links ───────────────────────────────────────────────────────
-- Many-to-many: one invoice can cover multiple batches; one batch can appear on
-- multiple invoices. Nullable during backfill — links are added incrementally.
create table invoice_batch_links (
  id          uuid        primary key default gen_random_uuid(),
  invoice_id  uuid        not null references invoices(id) on delete cascade,
  batch_id    uuid        not null references brew_batches(id) on delete cascade,
  note        text,
  created_by  uuid        references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (invoice_id, batch_id)
);

-- ── indexes ───────────────────────────────────────────────────────────────────
create index on invoices (invoice_date desc);
create index on invoices (partner_id);
create index on invoices (status);
create index on invoice_line_items (invoice_id);
create index on invoice_batch_links (invoice_id);
create index on invoice_batch_links (batch_id);

-- ── updated_at trigger ────────────────────────────────────────────────────────
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger invoices_updated_at
  before update on invoices
  for each row execute procedure set_updated_at();

-- ── RLS (admin-only) ─────────────────────────────────────────────────────────
alter table invoices             enable row level security;
alter table invoice_line_items   enable row level security;
alter table invoice_batch_links  enable row level security;

-- Shared admin check used across all three tables
create policy "Admins only — invoices"
  on invoices for all
  using (exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ));

create policy "Admins only — invoice_line_items"
  on invoice_line_items for all
  using (exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ));

create policy "Admins only — invoice_batch_links"
  on invoice_batch_links for all
  using (exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ));
