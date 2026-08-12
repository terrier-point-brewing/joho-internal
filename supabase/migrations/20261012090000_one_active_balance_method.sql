-- supabase/migrations/20261012090000_one_active_balance_method.sql
--
-- One ACTIVE method per balance-sheet account, enforced by the database.
--
-- ── This is a correctness guard, not tidiness ────────────────────────────────
-- lib/finance/balances/snapshot.ts's resolveSnapshotWrites sums every active
-- source on an account. A second active method is therefore ADDED to the first,
-- silently, with both showing a green "Calculating" badge.
--
-- It gets worse when two methods share a step. expandSources keys results
-- `${coaId}:${providerKey}` per STEP, so two methods that both carry
-- `transactionPostings` -- which is most of them -- write the same key twice.
-- The second overwrites the first in `results`, then resolveSnapshotWrites
-- reads that one value once per source row and adds it BOTH times, while
-- `contributions` records it once. The account then publishes a total its own
-- "How is this calculated?" panel cannot account for, which is precisely the
-- failure the explainer exists to make impossible.
--
-- The table's PK is (chart_of_accounts_id, provider_key), which permits this by
-- design: it was written when an account was a BAG of providers, before the
-- method layer collapsed provider pairs into one selectable thing
-- (20260912110000_balance_methods.sql). The PK stays as it is -- disabled rows
-- are the audit trail of what an account used to be worked out by, and several
-- may exist per account. Only ACTIVE rows are constrained.
--
-- ── Partial on `active`, which is the whole trick ────────────────────────────
-- A plain unique index on chart_of_accounts_id would make switching methods
-- impossible: an operator disabling Transaction postings and adding a
-- Calculation would collide with the disabled row they had just set aside. The
-- predicate is what lets history accumulate while the present stays single.
--
-- ── Safe to apply in either deploy order ─────────────────────────────────────
-- No production account has more than one source row at all, active or not, so
-- this creates cleanly today. Shipped alongside a matching check in
-- app/api/finance/balance-sources/route.ts that answers 409 with a sentence; if
-- the migration lands first, the route simply gets a 23505 instead of the nicer
-- message, and if the route lands first the rule is enforced in one place
-- instead of two. Neither ordering lets a double-counted balance through.

create unique index if not exists balance_sheet_account_sources_one_active
  on public.balance_sheet_account_sources (chart_of_accounts_id)
  where active;

comment on index public.balance_sheet_account_sources_one_active is
  'One active method per account. Two would be SUMMED by resolveSnapshotWrites, and two sharing a step would double-count it while reporting it once. Partial on `active` so disabled rows remain as the audit trail of previous methods.';
