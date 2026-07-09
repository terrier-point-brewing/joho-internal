-- Frozen per-ingredient breakdown behind each contract-brewing deposit invoice.
-- Attached to the finance-ledger invoices row (invoice_type='allocation_deposit').
-- line_total_cents is that ingredient's share of the deposit, pre-scaled so
-- SUM(line_total_cents) = invoices.total_cents. All rows uniform (no provenance
-- flags); replaced wholesale when a deposit is regenerated.

create table if not exists public.deposit_invoice_ingredients (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid    not null references public.invoices(id) on delete cascade,
  ingredient_id    uuid    references public.ingredients(id) on delete set null,
  ingredient_name  text    not null,
  unit             text    not null,
  quantity_per_bbl numeric not null,
  cost_per_unit    numeric not null,
  line_total_cents integer not null,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now()
);

create index if not exists deposit_invoice_ingredients_invoice_id_idx
  on public.deposit_invoice_ingredients(invoice_id);

drop trigger if exists audit_deposit_invoice_ingredients on public.deposit_invoice_ingredients;
create trigger audit_deposit_invoice_ingredients
  after insert or update or delete on public.deposit_invoice_ingredients
  for each row execute function public.audit_trigger_fn();

-- ── RLS (admin-only, matching the parent invoices cluster) ───────────────────
alter table public.deposit_invoice_ingredients enable row level security;

create policy "Admins only — deposit_invoice_ingredients"
  on public.deposit_invoice_ingredients for all
  using (exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ));
