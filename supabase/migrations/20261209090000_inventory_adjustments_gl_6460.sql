-- GL 6460 Inventory Shrinkage & Adjustments: where the inventory residual
-- lands on the P&L.
--
-- Cost of goods sold is now the cost of the beer that LEFT each month
-- (lib/finance/costOfBeerSold). Purchases are capitalised onto the balance
-- sheet, and whatever the shelves lost or gained that no sale explains — a
-- count correction, a missed receipt, beer poured away — posts here, below
-- gross profit, in either direction. Kept out of COGS on purpose: a line that
-- swings both ways is measuring record quality, not the cost of a sale.
--
-- The owner added this account by hand on 2026-10-12; this migration makes a
-- fresh environment match. Idempotent.

do $$
declare
  v_parent uuid;
  v_n int;
begin
  select count(*) into v_n from public.chart_of_accounts where account_number = '6400';
  if v_n <> 1 then
    raise exception 'inventory adjustments: account_number 6400 matches % rows, expected exactly 1', v_n;
  end if;
  select id into v_parent from public.chart_of_accounts where account_number = '6400';

  if not exists (select 1 from public.chart_of_accounts where account_number = '6460') then
    insert into public.chart_of_accounts
      (account_number, account_name, account_type, detail_type, parent_id, is_active)
    values
      ('6460', 'OPERATING EXPENSES:General & Administrative (G&A):Inventory Shrinkage & Adjustments',
       'Expenses', 'Other Business Expenses', v_parent, true);
  end if;
end $$;
