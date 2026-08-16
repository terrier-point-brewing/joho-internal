-- Shipments billed against a Square item that is not their own.
--
-- THE CASE
--   A customer billed at distribution rates whose beer we fill into THEIR kegs.
--   That packaging variation must never carry a Square SKU — a linked variation
--   becomes selectable in the catalog, and nobody may sell a keg that belongs to
--   someone else — so `recipe_square_links` deliberately has no row for it. The
--   shipment is still real and still billable, at the same rate as the equivalent
--   house keg, so the invoice borrows the house keg's Square item for that line.
--
-- WHY A ROW HAS TO EXIST FOR IT
--   Borrowing the SKU borrows its inventory behaviour too: Square decrements the
--   house item when the invoice is SENT (see lib/production/pendingSquareDeduction),
--   for units that were never in Square's count to begin with. Left alone that is a
--   permanent understatement of the house SKU — the cold-storage push cannot heal
--   it, because the customer-keg variation is unlinked and so contributes nothing
--   to the pushed total.
--
--   The correction is one relative adjustment per substituted shipment, applied
--   once, right after the send that caused the deduction. That needs to outlive
--   the request that drafted the invoice: generate and send are two separate
--   operator actions, minutes or days apart. Hence a table rather than a flag.
--
-- WHAT IT IS NOT
--   Not a mapping. Nothing here is ever consulted to decide what a shipment bills
--   as — that choice is made per invoice, by a person, in the preview modal, and
--   this table only records what they chose. A substitution row must never grow a
--   lookup path, or the exception quietly becomes the standing link the catalog
--   was being protected from.

create table if not exists public.invoice_sku_substitutions (
  id                     uuid primary key default gen_random_uuid(),
  invoice_id             uuid not null references public.invoices(id) on delete cascade,
  export_transaction_id  uuid not null references public.export_transactions(id) on delete cascade,
  -- The BORROWED Square variation — the house item the line was billed under,
  -- and therefore the item Square decremented and the one to credit back.
  square_variation_id    text not null,
  quantity               numeric not null check (quantity > 0),
  -- The operator's per-line choice. False keeps the audit record while leaving
  -- Square's count alone — the right answer when the customer's kegs were, for
  -- once, counted into Square by hand.
  restore_inventory      boolean not null default true,
  restored_at            timestamptz,
  square_count_before    numeric,
  square_count_after     numeric,
  -- Why a restore did not land. Set instead of restored_at; the send itself is
  -- never failed for it, so this is the only place the miss is visible.
  restore_error          text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.invoice_sku_substitutions is
  'One row per shipment billed against a Square item that is not its own, because its packaging variation is deliberately unlinked (beer filled into the customer''s own kegs). Records the borrowed variation and whether the units it caused Square to deduct were credited back. Never read as a mapping.';
comment on column public.invoice_sku_substitutions.square_count_before is
  'Square''s on-hand for the borrowed variation immediately before the credit. Stored with square_count_after because Square accepts a write against an object it does not have and reports no error — the pair is the only proof the count actually moved.';

-- One substitution per shipment per invoice: a shipment is billed once.
create unique index if not exists invoice_sku_substitutions_txn_uniq
  on public.invoice_sku_substitutions (invoice_id, export_transaction_id);

-- The send path asks one question: what does this invoice still owe Square?
create index if not exists invoice_sku_substitutions_pending_idx
  on public.invoice_sku_substitutions (invoice_id)
  where restore_inventory and restored_at is null;

-- updated_at is the trigger's job, never the app's.
drop trigger if exists set_updated_at on public.invoice_sku_substitutions;
create trigger set_updated_at
  before insert or update on public.invoice_sku_substitutions
  for each row execute function public.update_updated_at();

-- Same read gate as invoices and invoice_line_items: written and read only
-- through the admin client, behind requirePermission(CAP.exportOperate).
alter table public.invoice_sku_substitutions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'invoice_sku_substitutions' and policyname = 'finance readers'
  ) then
    create policy "finance readers" on public.invoice_sku_substitutions
      for all to authenticated
      using (get_my_role() = any (finance_reader_roles()))
      with check (get_my_role() = any (finance_reader_roles()));
  end if;
end $$;
