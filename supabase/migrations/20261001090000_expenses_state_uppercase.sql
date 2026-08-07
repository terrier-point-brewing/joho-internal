-- expenses.state: make the casing invariant enforceable instead of remembered.
--
-- `expenses.state` carries three separate vocabularies, one per ramp_object:
--   card -> CLEARED | PENDING | DECLINED   (Ramp transaction API, upper-case)
--   bill -> PAID | OPEN                    (Ramp bill API, upper-case)
--   bank -> cleared                        (lib/finance/bankLedger.ts, LOWER-case)
--
-- That lone lower-case writer already caused a shipped bug: a case-sensitive
-- .eq("state","CLEARED") on the cash-flow statement silently dropped every bank
-- row -- which is every Gusto payroll withdrawal -- and its GL splits. The fix
-- at the time was to match with ilike. That works, but nothing stops the next
-- query from reaching for .eq() and reintroducing the bug.
--
-- So: normalize the 30 lower-case rows and enforce upper-case from here on.
-- With the constraint in place, .eq("state","CLEARED") is provably correct and
-- the trap is gone rather than merely avoided.
--
-- Deliberately NOT an enumerated CHECK over the five values seen today. Ramp's
-- `state`/`status` fields are passed straight through by lib/ramp.ts with no
-- allow-list, so enumerating them would turn any new Ramp value (a bill in
-- DRAFT, say) into a hard ingestion failure. The bug is about casing, so the
-- constraint is about casing.

begin;

-- 30 bank rows written as 'cleared'. Row-set proof that this is semantics-
-- preserving: the set selected by state ILIKE 'cleared' and the set selected by
-- upper(state) = 'CLEARED' are the same 162 rows both before and after.
update public.expenses
   set state = upper(state)
 where state is not null
   and state <> upper(state);

alter table public.expenses
  add constraint expenses_state_upper_check
  check (state is null or (state = upper(state) and state <> ''));

commit;
