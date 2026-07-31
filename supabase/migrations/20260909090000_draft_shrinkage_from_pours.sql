-- Draft shrinkage becomes definitional rather than inferred.
--
-- Shrinkage is beer that left the keg with no transaction behind it, measured
-- over the keg's whole life:
--
--   shrinkage = full_keg_fl_oz − Σ(recorded pour fl oz while that keg was on)
--
-- Square's on-hand for the draft SKU is the same quantity, but computed by
-- Square: it starts at whatever the last recount wrote and decrements per pour.
-- That identity only holds while nothing ELSE touches the SKU — a manual stock
-- adjustment, a correction, a failed prior recount — and when it breaks, the
-- error lands silently in the headline metric. Summing our own transactions
-- removes that whole class of drift, which is why this migration adds the
-- per-tap window anchor the sum needs.
--
-- Three changes:
--   1. tap_assignments.last_restock_at — the "since" bound for the pour window.
--   2. draft_swap_shrinkage.remaining_fl_oz → unaccounted_fl_oz. The number was
--      always right; the name encoded the wrong mental model ("what got dumped
--      at the end"). Kegs come off empty, so it is untransacted beer.
--   3. draft_swap_shrinkage.cause — separates a deliberate beer-change dump from
--      genuine shrinkage, which otherwise share one chart and one average.

-- 1 ─ Pour-window anchor ------------------------------------------------------

alter table public.tap_assignments
  add column if not exists last_restock_at timestamptz;

comment on column public.tap_assignments.last_restock_at is
  'When this tap last had a Draft Restock rung. Lower bound of the pour window whose fl oz are subtracted from the full keg to get shrinkage.';

-- Seed from the swap history we already have, so taps with a prior restock get a
-- real window on the first run instead of falling back to the Square read.
update public.tap_assignments t
   set last_restock_at = s.max_at
  from (
    select tap_number, max(occurred_at) as max_at
      from public.draft_swap_shrinkage
     where tap_number is not null
     group by tap_number
  ) s
 where s.tap_number = t.tap_number
   and t.last_restock_at is null;

-- 2 ─ Rename to what the column actually holds ---------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'draft_swap_shrinkage'
       and column_name  = 'remaining_fl_oz'
  ) then
    alter table public.draft_swap_shrinkage
      rename column remaining_fl_oz to unaccounted_fl_oz;
  end if;
end $$;

comment on column public.draft_swap_shrinkage.unaccounted_fl_oz is
  'Beer that left the keg with no transaction behind it: full_fl_oz minus recorded pour fl oz. Never negative — a negative balance means a late restock, recorded as an overdraft against the incoming keg instead.';

-- Historical rows captured before the overdraft split existed can be negative,
-- which the definition above makes impossible: those readings measured a restock
-- rung late, not beer lost. Floor them so the column holds only what it claims —
-- the surplus they encoded belonged to the following keg and is long since gone.
update public.draft_swap_shrinkage
   set unaccounted_fl_oz = 0
 where unaccounted_fl_oz < 0;

-- 3 ─ Why the beer left --------------------------------------------------------

alter table public.draft_swap_shrinkage
  add column if not exists cause text not null default 'keg_emptied';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'draft_swap_shrinkage_cause_chk'
  ) then
    alter table public.draft_swap_shrinkage
      add constraint draft_swap_shrinkage_cause_chk
      check (cause in ('keg_emptied', 'beer_change'));
  end if;
end $$;

comment on column public.draft_swap_shrinkage.cause is
  'keg_emptied = keg blew, the balance is true shrinkage (foam, giveaways, line cleaning). beer_change = keg pulled early to change beers, so the balance is dominated by a deliberate dump and does not belong in a shrinkage average.';

-- Backfill: a swap row whose source_ref was consumed by a queued transition was
-- a beer change. Everything else is a like-for-like restock — a blown keg.
update public.draft_swap_shrinkage s
   set cause = 'beer_change'
  from public.tap_swap_transitions t
 where t.consumed_source_ref = s.source_ref
   and s.cause = 'keg_emptied';
