-- Square sales refunds → finance.
--
-- Refunds do NOT change a Square order's state (a fully refunded order stays
-- COMPLETED), so they can't be captured by the order sync. They arrive as
-- separate refund.* webhook events and are persisted here, then netted against
-- revenue on the financial statements via a contra-revenue account.
--
-- One row per Square PaymentRefund, idempotent on square_refund_id.

create table if not exists public.square_refunds (
  id                    uuid primary key default gen_random_uuid(),
  square_refund_id      text not null unique,
  square_order_id       text,                       -- Square order id (string)
  square_payment_id     text,
  order_id              uuid references public.square_orders(id) on delete set null,
  amount_cents          integer not null default 0, -- positive; subtracted from revenue
  currency              text not null default 'USD',
  status                text,                        -- PENDING | COMPLETED | REJECTED | FAILED
  reason                text,
  refunded_at           timestamptz,                 -- Square refund created/updated time
  chart_of_accounts_id  uuid references public.chart_of_accounts(id) on delete set null,
  raw_data              jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists square_refunds_square_order_id_idx on public.square_refunds (square_order_id);
create index if not exists square_refunds_order_id_idx        on public.square_refunds (order_id);
create index if not exists square_refunds_refunded_at_idx     on public.square_refunds (refunded_at);
create index if not exists square_refunds_coa_id_idx          on public.square_refunds (chart_of_accounts_id);

comment on table public.square_refunds is
  'Square sales refunds (one row per PaymentRefund). Netted against revenue on financial statements via a contra-revenue chart-of-accounts account. Refunds do not change order state, so they are synced from refund.* webhook events, not the order sync.';

-- Finance tables are read/written exclusively via the service-role admin client,
-- which bypasses RLS. Enable RLS with no policies so the anon/authenticated
-- roles cannot reach it directly (matches invoices / pos_line_items).
alter table public.square_refunds enable row level security;

-- Contra-revenue account so refunds net against sales on the P&L. account_type
-- 'Income' places it in the revenue section; refund amounts are subtracted, so
-- the account carries a negative balance that reduces net revenue. Created only
-- if a QuickBooks import hasn't already provided a returns account by this name.
insert into public.chart_of_accounts
  (account_name, account_number, account_type, detail_type, description, is_active)
select
  'Sales Returns & Refunds', '4999', 'Income', 'Discounts/Refunds given',
  'Contra-revenue: Square POS/invoice sales refunds (app-managed).', true
where not exists (
  select 1 from public.chart_of_accounts where account_name = 'Sales Returns & Refunds'
);
