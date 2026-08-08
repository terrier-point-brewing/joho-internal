-- Unify every refund into one record, with optional line detail
--
-- Three code paths issue or ingest refunds today and none of them know about
-- each other:
--
--   1. POST /api/production/allocations/[id]/adjust — proportional refund of a
--      deposit when a partner's batch percentage drops. Writes its own three
--      columns on batch_allocations (square_refund_id, refund_amount_cents,
--      refunded_at) and nothing else.
--   2. lib/finance/syncRefunds.ts — ingests EVERY Square refund (webhook, daily
--      cron, gap scan) into square_refunds and posts the whole amount to one
--      contra-revenue account.
--   3. The Square dashboard, by hand. Lands in (2) with no explanation.
--
-- They are all the same event. This migration makes square_refunds the single
-- record: what was refunded, against what, why, and — when the app issued it —
-- which invoice lines it came off.
--
-- The only real difference between an app-issued refund and a Square-issued one
-- is that Square gives a bare dollar amount with NO line attribution. A $47
-- refund could be beer, excise, or both, and it cannot be reverse-engineered.
-- So line detail is a nullable relationship (`refund_lines`), not a second
-- system, and a refund with none is not an error — it is a refund awaiting a
-- human. See the `needs a reason` note on reason_code below.
--
-- WHY THE LINES MATTER FOR THE GL: syncRefunds posts every refund to a single
-- contra-revenue account. That is right for a $6 taproom refund and wrong for
-- an invoice: it collapses packaging fees, excise and materials into one
-- bucket, and excise is a pass-through liability that must never net against
-- revenue. refund_lines carries no account of its own — it points at the
-- invoice line, and the account is READ THROUGH that FK. A later remap of the
-- invoice line therefore carries its credits with it, and the two can never
-- drift apart.

-- ── square_refunds: origin, reason, and what it was raised against ────────────

alter table public.square_refunds
  add column if not exists origin        text,
  add column if not exists reason_code   text,
  add column if not exists invoice_id    uuid references public.invoices(id)          on delete restrict,
  add column if not exists allocation_id uuid references public.batch_allocations(id) on delete restrict,
  add column if not exists classified_at timestamptz,
  add column if not exists classified_by uuid references auth.users(id) on delete set null;

-- Everything already in the table arrived through syncRefunds, i.e. from Square.
update public.square_refunds set origin = 'square' where origin is null;

alter table public.square_refunds alter column origin set default 'square';
alter table public.square_refunds alter column origin set not null;

-- ON DELETE RESTRICT on both FKs: a refund is a financial record. Deleting the
-- invoice or the allocation out from under it must fail loudly rather than
-- orphan the money or take it along.

-- These two enumerations are authored by this app, not passed through from a
-- vendor, so constraining them is safe — unlike an enumerated CHECK on a Square
-- field, which breaks ingestion the first time Square adds a value.
alter table public.square_refunds
  drop constraint if exists square_refunds_origin_check;
alter table public.square_refunds
  add constraint square_refunds_origin_check
  check (origin in ('app', 'square'));

alter table public.square_refunds
  drop constraint if exists square_refunds_reason_code_check;
alter table public.square_refunds
  add constraint square_refunds_reason_code_check
  check (reason_code is null or reason_code in (
    'price_correction',   -- overcharge; goods were delivered and stay delivered
    'goods_returned',     -- beer came back; inventory and excise reverse
    'never_delivered',    -- beer never left; inventory and excise reverse
    'deposit_reduction'   -- allocation percentage cut; the pre-existing flow
  ));

-- An app-issued refund always knows why it was issued. Only Square-issued ones
-- are allowed to arrive unexplained.
alter table public.square_refunds
  drop constraint if exists square_refunds_app_origin_has_reason;
alter table public.square_refunds
  add constraint square_refunds_app_origin_has_reason
  check (origin <> 'app' or reason_code is not null);

comment on column public.square_refunds.origin is
  'Who issued it: ''app'' (through issueRefund, carries refund_lines) or ''square'' (POS refund, or someone in the Square dashboard).';
comment on column public.square_refunds.reason_code is
  'Why it was issued. NULL means unclassified — only possible for origin=''square''. NULL together with a non-null invoice_id is the definition of "needs a reason": the money is booked and correct, but nobody has said whether inventory and excise should reverse. There is no separate alert table; that predicate IS the alert.';
comment on column public.square_refunds.invoice_id is
  'The invoice this refund was raised against. NULL for taproom POS refunds, which have no invoice.';
comment on column public.square_refunds.allocation_id is
  'Set for deposit_reduction refunds. Redundant with invoices.allocation_id when a deposit invoice exists, but a deposit refund predating its invoice sync would otherwise have no link at all.';
comment on column public.square_refunds.classified_at is
  'When a human supplied reason_code for a Square-origin refund. NULL on app-issued refunds — those were born classified.';

-- The alert query: unclassified refunds against an invoice.
create index if not exists square_refunds_needs_reason_idx
  on public.square_refunds (invoice_id)
  where reason_code is null and invoice_id is not null;

create index if not exists square_refunds_invoice_id_idx
  on public.square_refunds (invoice_id);
create index if not exists square_refunds_allocation_id_idx
  on public.square_refunds (allocation_id);

-- ── refund_lines: what the refund came off, when the app knows ────────────────

create table if not exists public.refund_lines (
  id                   uuid        primary key default gen_random_uuid(),
  refund_id            uuid        not null references public.square_refunds(id)    on delete cascade,
  invoice_line_item_id uuid        not null references public.invoice_line_items(id) on delete restrict,
  basis                text        not null,
  quantity             numeric,
  amount_cents         bigint      not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.refund_lines is
  'Per-line detail of an app-issued refund. Absent for Square-issued refunds, which carry no line attribution. Deliberately has NO chart_of_accounts_id: the GL account is read through invoice_line_item_id so a remap of the invoice line carries its credits with it.';

-- CASCADE up to the refund (a line is a piece of its refund), RESTRICT down to
-- the invoice line (the invoice line is not a piece of the credit, and deleting
-- one that has been credited should fail loudly).

alter table public.refund_lines
  drop constraint if exists refund_lines_basis_check;
alter table public.refund_lines
  add constraint refund_lines_basis_check
  check (basis in ('per_unit', 'derived', 'flat'));

comment on column public.refund_lines.basis is
  'How this line''s credit was computed. ''per_unit'': quantity x the price actually paid — product lines, and also Packaging Fee and Keg Cleaning, which are billed per keg. ''derived'': recomputed from what else was credited, never hand-entered — Excise Tax and Packaging Materials (both carried by Square as quantity 1 with the whole amount in unit_price_cents), plus the invoice-level Discount line, which must shrink in step with the lines it discounted. ''flat'': all-or-nothing quantity-1 service lines such as the forklift fee.';
comment on column public.refund_lines.quantity is
  'Units credited. NULL for derived and flat lines, which have no meaningful per-unit quantity — see the basis comment.';
comment on column public.refund_lines.amount_cents is
  'Cents credited off this line. Normally positive; NEGATIVE on a derived discount line, which shrinks in step with the lines it was discounting and so reduces the refund. The contra/revenue sign lives in the posting, not here.';

-- A quantity is meaningful only on a per-unit line.
alter table public.refund_lines
  drop constraint if exists refund_lines_quantity_matches_basis;
alter table public.refund_lines
  add constraint refund_lines_quantity_matches_basis
  check ((basis = 'per_unit' and quantity is not null) or (basis <> 'per_unit' and quantity is null));

-- One credit per invoice line per refund. Crediting the same line twice in one
-- refund is always a UI bug; two separate refunds against the same line (a
-- second partial later) are two rows and remain legal.
create unique index if not exists refund_lines_refund_line_uniq
  on public.refund_lines (refund_id, invoice_line_item_id);

create index if not exists refund_lines_invoice_line_item_id_idx
  on public.refund_lines (invoice_line_item_id);

-- updated_at is the trigger's job, never the app's.
drop trigger if exists set_updated_at on public.refund_lines;
create trigger set_updated_at
  before insert or update on public.refund_lines
  for each row execute function public.update_updated_at();

-- Same read gate as square_refunds and invoice_line_items.
alter table public.refund_lines enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'refund_lines' and policyname = 'finance readers'
  ) then
    create policy "finance readers" on public.refund_lines
      for all to authenticated
      using (get_my_role() = any (finance_reader_roles()))
      with check (get_my_role() = any (finance_reader_roles()));
  end if;
end $$;
