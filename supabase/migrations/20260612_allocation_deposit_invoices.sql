-- Allocation deposit invoices: track Square deposit invoices per batch_allocation.
-- Also extends the invoices table with type + allocation FK for modular invoice tracking.

-- ── batch_allocations: add deposit invoice tracking columns ───────────────────
alter table public.batch_allocations
  add column if not exists square_deposit_invoice_id text,
  add column if not exists square_deposit_order_id   text,
  add column if not exists invoice_generated_at      timestamptz,
  add column if not exists invoice_sent_at           timestamptz,
  add column if not exists invoice_paid_at           timestamptz;

-- ── invoices: add type + allocation FK for modular invoice categorization ─────
alter table public.invoices
  add column if not exists invoice_type  text not null default 'standard'
    check (invoice_type in ('standard', 'allocation_deposit')),
  add column if not exists allocation_id uuid references public.batch_allocations(id) on delete set null;

create index if not exists invoices_allocation_id_idx  on public.invoices(allocation_id);
create index if not exists invoices_invoice_type_idx   on public.invoices(invoice_type);
