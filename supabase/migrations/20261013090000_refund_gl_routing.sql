-- Where a refund lands, when the default contra-revenue account is wrong
--
-- ── The bug this fixes ───────────────────────────────────────────────────────
-- syncRefunds.ts posts EVERY Square refund to one account: GL 4999 Sales
-- Returns & Refunds. That is right for a $6 taproom refund, because a returned
-- beer really is contra-revenue. It is wrong the moment the thing refunded was
-- never revenue in the first place.
--
-- GL 2420 Equipment Deposits is the standing proof. The taproom takes a $30 Keg
-- Deposit and a $50 Pump Deposit at the till; both POS items are mapped to
-- 2420, so taking one CREDITS the liability. Handing the deposit back is what
-- SETTLES it — but the refund posts to 4999 instead, so 2420 only ever grows.
-- On 2026-07-10 a $53.63 refund (a $50 Pump Deposit plus its $3.63 tax) went to
-- 4999 while the pump came back through the door; the liability for that pump
-- is still on the balance sheet today.
--
-- This is the same trap the method layer was built to close on GL 2310 — an
-- accrual with no settlement side reads as an ever-growing liability, with
-- nothing in the figure to say so.
--
-- ── Why a table rather than a special case ───────────────────────────────────
-- The obvious fix is `if (account is 2420) post the refund back to 2420`, and
-- it does not survive the next deposit. A bottle deposit, a glassware deposit,
-- a tap-handle deposit, a keg-collar deposit are all the same arrangement with
-- a different account, and each one would be another branch in a sync module
-- that has no business knowing the chart of accounts.
--
-- So the rule is DATA: refunding something coded to account X posts to account
-- Y. An operator states it once in Settings → Finance → GL Mapping → Refunds,
-- and the sync reads it. Nothing here is specific to deposits — the same row
-- shape handles any account whose refunds are not contra-revenue.
--
-- The identity mapping (X → X) is the normal case and is not a no-op: it is
-- what says "a refund of this returns to this account", overriding the 4999
-- default. That is exactly the 2420 rule seeded below.
--
-- ── What this migration does NOT decide ──────────────────────────────────────
-- Whether a given refund MATCHES a rule is resolved in lib/finance/refundRouting.ts,
-- deliberately not in SQL. A Square refund is a bare dollar amount against an
-- order that may span several accounts, and `square_refunds` has one
-- chart_of_accounts_id, so routing is all-or-nothing by schema. The resolver
-- therefore routes only when the refund's amount equals the order's total for
-- the routed account exactly, and otherwise leaves the refund on the contra
-- account. A partial refund of a mixed order is genuinely ambiguous, and
-- guessing at it would misstate a liability silently — which is the failure
-- this whole migration exists to end, not one to reintroduce from the other
-- side.

create table if not exists public.refund_gl_routing (
  id                          uuid        primary key default gen_random_uuid(),
  source_chart_of_accounts_id uuid        not null references public.chart_of_accounts(id) on delete cascade,
  target_chart_of_accounts_id uuid        not null references public.chart_of_accounts(id) on delete restrict,
  active                      boolean     not null default true,
  note                        text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

comment on table public.refund_gl_routing is
  'Refunds of sales coded to source_chart_of_accounts_id post to target_chart_of_accounts_id instead of the default contra-revenue account (GL 4999). Exists because a refund is only contra-revenue when the original sale was revenue; refunding a customer deposit settles a liability instead. An identity row (source = target) is the normal shape and is not a no-op — it overrides the 4999 default.';

comment on column public.refund_gl_routing.source_chart_of_accounts_id is
  'The account the ORIGINAL sale line is coded to — e.g. GL 2420 for a Keg Deposit POS item. CASCADE: a rule about a deleted account is meaningless.';
comment on column public.refund_gl_routing.target_chart_of_accounts_id is
  'Where the refund posts instead of GL 4999. Usually the same account as the source, which is what settles a deposit liability. RESTRICT: deleting an account that refunds are actively routed to must fail loudly rather than silently send them back to contra-revenue.';
comment on column public.refund_gl_routing.active is
  'Turned off rather than deleted, so the history of what refunds used to be routed by survives. Only active rows are consulted.';
comment on column public.refund_gl_routing.note is
  'Free text for whoever reads this row in six months — why this account''s refunds are not contra-revenue.';

-- One active rule per source account. Two would make the routing decision
-- depend on row order, which is the same class of bug the one-active-method
-- index closes on balance_sheet_account_sources. Partial on `active` so a
-- superseded rule can stay as the audit trail of what used to happen.
create unique index if not exists refund_gl_routing_one_active_per_source
  on public.refund_gl_routing (source_chart_of_accounts_id)
  where active;

comment on index public.refund_gl_routing_one_active_per_source is
  'One active rule per source account. A second would make routing depend on row order. Partial on `active` so disabled rules remain as history.';

-- updated_at is the trigger's job, never the app's.
drop trigger if exists set_updated_at on public.refund_gl_routing;
create trigger set_updated_at
  before insert or update on public.refund_gl_routing
  for each row execute function public.update_updated_at();

-- Same read gate as square_refunds and refund_lines.
alter table public.refund_gl_routing enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'refund_gl_routing' and policyname = 'finance readers'
  ) then
    create policy "finance readers" on public.refund_gl_routing
      for all to authenticated
      using (get_my_role() = any (finance_reader_roles()))
      with check (get_my_role() = any (finance_reader_roles()));
  end if;
end $$;

-- ── Seed: GL 2420 Equipment Deposits ─────────────────────────────────────────
-- The rule that motivated the table. Seeded by account_number rather than a
-- hardcoded uuid so this applies cleanly to any environment whose chart of
-- accounts was loaded separately, and does nothing at all where 2420 does not
-- exist.
insert into public.refund_gl_routing (source_chart_of_accounts_id, target_chart_of_accounts_id, note)
select c.id, c.id,
       'Keg and Pump deposits are refundable. Handing one back settles the liability it created; it is not a sale being reversed.'
from public.chart_of_accounts c
where c.account_number = '2420'
on conflict do nothing;
