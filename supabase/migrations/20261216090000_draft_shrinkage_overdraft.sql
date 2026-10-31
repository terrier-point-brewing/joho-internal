-- Persist the restock overdraft measured at each Draft Restock ring.
--
-- When a ring lands after more pour volume than the keg could hold, the surplus
-- (the "overdraft") belongs to kegs that went on with no ring. The sync nets it
-- out of the incoming keg's Square recount, and once the overdraft exceeds a
-- whole keg that recount floors to ZERO — Square's draft count is silently
-- wiped. Until now the only record was a warning inside one webhook run's
-- result, which nobody sees. Storing it on the shrinkage row lets Draft Stats
-- say "that ring was late by more than a keg; fix the Square count by hand".

alter table public.draft_swap_shrinkage
  add column if not exists overdraft_fl_oz numeric not null default 0;

comment on column public.draft_swap_shrinkage.overdraft_fl_oz is
  'Pour fl oz recorded beyond the keg''s full volume between the previous ring and this one. > 0 means the ring was late; >= full_fl_oz means at least one keg went on with no ring and the Square recount floored to 0.';
