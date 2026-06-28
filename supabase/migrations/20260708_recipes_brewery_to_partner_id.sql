-- Replace recipes.brewery (free-text company name used as a fragile runtime join key)
-- with recipes.partner_id (proper FK to contract_brewing_partners).
-- Backfill: every existing brewery value matches exactly one partner row, so the
-- UPDATE captures all 22 rows before the old column is dropped.

alter table public.recipes
  add column if not exists partner_id uuid references public.contract_brewing_partners(id);

update public.recipes r
set partner_id = p.id
from public.contract_brewing_partners p
where p.company_name = r.brewery;

alter table public.recipes drop column if exists brewery;
