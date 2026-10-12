-- supabase/migrations/20261207090000_duplicate_candidate_reviews.sql
--
-- A person's answer to "is this one transaction, recorded twice?"
--
-- ── What this is for ─────────────────────────────────────────────────────────
-- lib/finance/duplicateCandidates.ts pairs records from different feeds that
-- share an exact amount and a few days: a Ramp bill and the card charge that
-- paid it, a bill and the bank line that settled it, a manual entry restating
-- a debit the feed already carries. September 2026's close found five of these
-- by hand, each one a doubled expense.
--
-- The matcher only proposes. This table is where the answer is kept, so a pair
-- somebody has looked at is not put in front of them again every month -- and
-- so "these are two real payments of the same size" is a recorded decision
-- rather than something each close has to rediscover.
--
-- ── What it is not ───────────────────────────────────────────────────────────
-- Not the mechanism that sets a duplicate aside. That stays where it already
-- lives: `expenses.excluded_at` for an expense, `bank_ledger.flow_type =
-- 'bill_settlement'` for a bank line. A row here with resolution
-- 'duplicate_set_aside' is the record that one of those was done FROM a
-- review; the statements read the feed tables, never this one.

create table if not exists public.duplicate_candidate_reviews (
  -- A surrogate key because the generic audit trigger below records `id`.
  id             uuid        primary key default gen_random_uuid(),

  -- The matcher's own stable key for the pair, e.g.
  -- "bill_vs_card:<ramp bill id>:<expense id>". One answer per pair.
  candidate_key  text        not null unique,

  -- Which rule proposed it. Free text on purpose: the matcher will grow kinds,
  -- and a CHECK here would turn a new one into a failed insert.
  kind           text        not null,

  -- not_duplicate        two separate transactions; do not ask again.
  -- duplicate_set_aside  one transaction; the extra record was set aside by
  --                      this review (excluded, or retyped bill_settlement).
  -- duplicate_corrected  one transaction, corrected some other way -- usually
  --                      a manual entry in a later month because the month it
  --                      belongs to is closed. Needs a note saying how.
  resolution     text        not null
    check (resolution in ('not_duplicate', 'duplicate_set_aside', 'duplicate_corrected')),

  note           text,

  -- Month end of the duplicate record's date: the month whose figures the
  -- double count sits in.
  period_end     date        not null,

  -- The pair exactly as it was shown to the reviewer. A set-aside pair stops
  -- being produced by the matcher, so without this the reviewed list could not
  -- say what was decided about what.
  snapshot       jsonb       not null,

  -- Nullable only so the row survives the reviewer's login being deleted.
  reviewed_by    uuid        references auth.users(id) on delete set null,
  reviewed_at    timestamptz not null default now(),

  constraint duplicate_candidate_reviews_corrected_needs_note
    check (resolution <> 'duplicate_corrected' or coalesce(btrim(note), '') <> '')
);

comment on table public.duplicate_candidate_reviews is
  'One reviewed answer per possible duplicate proposed by lib/finance/duplicateCandidates.ts. Remembers the decision; does not itself exclude anything from a statement.';
comment on column public.duplicate_candidate_reviews.resolution is
  'not_duplicate | duplicate_set_aside (the extra record was excluded / retyped from this review) | duplicate_corrected (fixed elsewhere, note required).';
comment on column public.duplicate_candidate_reviews.snapshot is
  'The candidate as the reviewer saw it (DuplicateCandidate JSON).';

create index if not exists duplicate_candidate_reviews_period_idx
  on public.duplicate_candidate_reviews (period_end);

-- Same posture as the other finance review tables: every application read goes
-- through the service-role admin client behind requirePermission, and
-- apply_grant_policies opens the custom-role path and nothing else.
alter table public.duplicate_candidate_reviews enable row level security;

select public.apply_grant_policies('duplicate_candidate_reviews', 'finance.transactions');

drop trigger if exists duplicate_candidate_reviews_audit on public.duplicate_candidate_reviews;
create trigger duplicate_candidate_reviews_audit
  after insert or update or delete on public.duplicate_candidate_reviews
  for each row execute function public.audit_trigger_fn();
