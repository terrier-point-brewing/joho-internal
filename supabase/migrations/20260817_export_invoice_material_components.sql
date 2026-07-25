-- Frozen derivation behind each contract-brewing "Packaging Materials" invoice
-- line. Attached to the finance-ledger invoices row (invoice_type='export_invoice').
-- Mirrors deposit_invoice_ingredients (20260709), one level deeper: a materials
-- line covers one recipe, which can span several packaging runs (variations),
-- each consuming several components. One row per component per run.
--
-- Unit costs drift as packaging items are repriced, so recomputing this later
-- would NOT reproduce what the customer was billed — hence the snapshot.
--
-- line_total_cents is quantity_used x unit_cost at snapshot time. Unlike the
-- deposit table these are NOT scaled to the invoice total: they record what the
-- materials computation produced. The authoritative charged amount is always
-- invoice_line_items (the user may edit a line before generating), so a sum
-- mismatch is meaningful signal, not corruption.

create table if not exists public.export_invoice_material_components (
  id                uuid primary key default gen_random_uuid(),
  invoice_id        uuid    not null references public.invoices(id) on delete cascade,
  recipe_id         uuid    references public.recipes(id) on delete set null,
  beer_name         text,
  -- The literal packaging variation shipped (export_transactions.variant_label).
  variant_label     text,
  packaging_format  text    not null,
  -- Packages can be fractional when a shipment is split across commitments.
  packages          numeric not null,
  units_per_package numeric not null,
  component_role    text    not null check (component_role in ('container', 'lid', 'label', 'paktech', 'tray')),
  component_name    text    not null,
  -- null = no unit cost was set on the packaging item; the component billed $0.
  unit_cost         numeric,
  quantity_used     numeric not null,
  line_total_cents  integer not null,
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now()
);

create index if not exists export_invoice_material_components_invoice_id_idx
  on public.export_invoice_material_components(invoice_id);

drop trigger if exists audit_export_invoice_material_components on public.export_invoice_material_components;
create trigger audit_export_invoice_material_components
  after insert or update or delete on public.export_invoice_material_components
  for each row execute function public.audit_trigger_fn();

-- ── RLS (admin-only, matching the parent invoices cluster) ───────────────────
alter table public.export_invoice_material_components enable row level security;

create policy "Admins only — export_invoice_material_components"
  on public.export_invoice_material_components for all
  using (exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ));
