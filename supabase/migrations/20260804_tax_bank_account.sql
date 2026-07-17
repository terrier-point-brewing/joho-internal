-- Tax Profile: Bank Account
--
-- The account filings are paid from/refunded to — a new singleton, same
-- pattern as tax_entity_profile / tax_legal_representative (id boolean
-- primary key default true). Routing/account numbers are sensitive in the
-- app layer (masked to present/absent on the regular GET, real value only
-- via the admin-only reveal endpoint — same convention as
-- tax_legal_representative.ssn).
--
-- Human-gated (do not auto-apply).

create table if not exists public.tax_bank_account (
  id             boolean     primary key default true check (id),
  account_name   text,
  account_type   text        check (account_type in ('personal_checking', 'business_checking', 'personal_savings', 'business_savings')),
  account_holder text,
  routing_number text,
  account_number text,
  updated_at     timestamptz not null default now()
);

alter table public.tax_bank_account enable row level security;
create policy "finance readers" on public.tax_bank_account
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );

comment on column public.tax_bank_account.id is 'singleton guard: boolean PK fixed true so only one row can exist';
comment on column public.tax_bank_account.routing_number is 'treated as sensitive in the app layer, same convention as tax_legal_representative.ssn';
comment on column public.tax_bank_account.account_number is 'treated as sensitive in the app layer, same convention as tax_legal_representative.ssn';
comment on table public.tax_bank_account is 'the bank account filings are paid from/refunded to — referenced (not fully shown) on every worksheet''s Filing Identity header';
