-- Work in process becomes a balance-sheet shelf.
--
-- Ingredients leave Raw Materials (1210) the day a batch is brewed, and until
-- now reappeared only when the beer was packaged into Finished Goods (1230).
-- Everything in a fermenter was therefore cost of goods sold weeks before the
-- beer was sold. GL 1250 holds that beer at the share of its batch's
-- raw-material cost still in tank (lib/finance/batchCost), and its monthly
-- change relieves against 5110 Raw Materials COGS the same way the other
-- three inventory shelves do.
--
-- The first month this shelf has a value relieves the whole of it — the same
-- one-time catch-up the other shelves had in July 2026, and the deliberate
-- consequence of bringing tank beer onto the books.

do $$
declare
  v_parent uuid;
  v_wip    uuid;
  v_cogs   uuid;
  v_n      int;
begin
  select count(*) into v_n from public.chart_of_accounts where account_number = '1200';
  if v_n <> 1 then
    raise exception 'wip inventory: account_number 1200 matches % rows, expected exactly 1', v_n;
  end if;
  select id into v_parent from public.chart_of_accounts where account_number = '1200';

  select count(*) into v_n from public.chart_of_accounts where account_number = '5110';
  if v_n <> 1 then
    raise exception 'wip inventory: account_number 5110 matches % rows, expected exactly 1', v_n;
  end if;
  select id into v_cogs from public.chart_of_accounts where account_number = '5110';

  -- The account, unless the operator already added it by hand.
  select id into v_wip from public.chart_of_accounts where account_number = '1250';
  if v_wip is null then
    insert into public.chart_of_accounts
      (account_number, account_name, account_type, detail_type, parent_id, is_active)
    values
      ('1250', 'Inventory Assets:Work in Process', 'Other Current Assets', 'Inventory', v_parent, true)
    returning id into v_wip;
  end if;

  -- Idempotent: an existing row keeps whatever the operator set.
  insert into public.balance_sheet_account_sources (chart_of_accounts_id, provider_key, config, active)
  values (
    v_wip,
    'inventoryOnHand',
    jsonb_build_object('inventoryPool', 'workInProcess', 'cogsOffsetCoaId', v_cogs),
    true
  )
  on conflict (chart_of_accounts_id, provider_key) do nothing;

  raise notice 'wip inventory: GL 1250 sourced from the Inventory on hand method, relieving to 5110';
end $$;
