-- The allocation becomes the unit of record for the contract-brewing chain.
--
-- Three things move together here, all found by the 2026-09-13 review of
-- Commitments → Deposits → Allocations → Shipments:
--
-- 1. Deletes no longer silently rewrite what is owed. Both foreign keys were
--    ON DELETE SET NULL: deleting a commitment left its paid allocation with no
--    booked cap (owed jumped from min(share, booked) to the full share), and
--    deleting an allocation turned every shipment credited to it into an
--    unallocated over-delivery row. NO ACTION makes both a refused delete; the
--    routes explain why and point at "cancel" instead. Batch deletes still
--    cascade: NO ACTION is checked at end of statement, by which time the
--    batch's export rows have cascaded away too.
--
-- 2. commitments.status was free text. Code writes open/fulfilled, the UI
--    offers in_progress/cancelled, and nothing else is meaningful — the
--    operator-facing stage is now DERIVED (lib/production/commitmentStage) and
--    only the human decisions live in this column.
--
-- 3. A back-charged ingredient deposit is collected per export invoice, not
--    once. `batch_allocations.deposit_backcharged_invoice_id` could only point
--    at ONE invoice, so a 70% allocation delivered in three drops was charged
--    deposit on drop one and the preview filtered the allocation out of drops
--    two and three. Each invoice that carries a deposit line for an allocation
--    now writes a row here; the pointer stays as "latest" for the badges.

-- ── 1. Delete guards ─────────────────────────────────────────────────────────
alter table public.batch_allocations
  drop constraint if exists batch_allocations_contract_request_id_fkey;
alter table public.batch_allocations
  add constraint batch_allocations_contract_request_id_fkey
  foreign key (contract_request_id) references public.commitments(id) on delete no action;

alter table public.export_transactions
  drop constraint if exists export_transactions_allocation_id_fkey;
alter table public.export_transactions
  add constraint export_transactions_allocation_id_fkey
  foreign key (allocation_id) references public.batch_allocations(id) on delete no action;

-- ── 2. Stored status is the human decision only ──────────────────────────────
alter table public.commitments
  drop constraint if exists commitments_status_check;
alter table public.commitments
  add constraint commitments_status_check
  check (status in ('open', 'in_progress', 'fulfilled', 'cancelled'));

comment on column public.commitments.status is
  'Human decision only (open | cancelled). in_progress/fulfilled are legacy cache values still written by fulfillment code; the stage shown to operators is derived — see lib/production/commitmentStage.';

-- ── 3. Per-invoice deposit charges ───────────────────────────────────────────
create table if not exists public.allocation_deposit_charges (
  id            uuid primary key default gen_random_uuid(),
  allocation_id uuid not null references public.batch_allocations(id) on delete cascade,
  invoice_id    uuid not null references public.invoices(id) on delete cascade,
  -- What the export invoice actually billed for this allocation's deposit
  -- share (after any operator edit of the line), in cents.
  amount_cents  integer not null check (amount_cents >= 0),
  -- The bbl those shipments represent, for the ledger's "collected on N bbl".
  shipped_bbl   numeric(10, 4),
  created_at    timestamptz not null default now(),
  unique (allocation_id, invoice_id)
);

comment on table public.allocation_deposit_charges is
  'One row per export invoice that carries an Ingredient Deposit line for this allocation. Paid/voided state is read from the invoice, never copied here.';

create index if not exists allocation_deposit_charges_invoice_id_idx
  on public.allocation_deposit_charges(invoice_id);

drop trigger if exists audit_allocation_deposit_charges on public.allocation_deposit_charges;
create trigger audit_allocation_deposit_charges
  after insert or update or delete on public.allocation_deposit_charges
  for each row execute function public.audit_trigger_fn();

-- Money → same admin-only cluster as invoices; routes read it through the
-- service-role client after their own permission gate, like invoice numbers.
alter table public.allocation_deposit_charges enable row level security;

drop policy if exists "Admins only — allocation_deposit_charges" on public.allocation_deposit_charges;
create policy "Admins only — allocation_deposit_charges"
  on public.allocation_deposit_charges for all
  using (exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ));
