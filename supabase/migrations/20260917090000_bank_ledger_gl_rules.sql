-- supabase/migrations/20260917090000_bank_ledger_gl_rules.sql
--
-- The operator's say over which bank money movement is an accounting fact.
--
-- ── What this adds to include_in_gl, and why that column is not enough ───────
-- 20260916090000 gave ramp_bank_ledger an `include_in_gl` flag and had the
-- Plaid importer write it false, so Chase history landed outside the books.
-- That is the correct default and this migration does not disturb it.
--
-- A flag on a row can only speak for rows that already exist. "Start counting
-- the Chase account" is a decision about a FEED, including every transaction it
-- has not sent yet, so writing it as a bulk update over today's rows would be
-- wrong the next morning. The decisions live here instead, as standing rules
-- the readers consult, and lib/finance/bankLedgerInclusion.ts resolves them:
--
--     counterparty rule  ->  bank-feed rule  ->  the row's own include_in_gl
--
-- ── Why this table starts empty, and must ────────────────────────────────────
-- The profit and loss, the cash-flow statement, the transactions grid and the
-- balance sheet are verified and in production use. This table exists to let a
-- person change what they report, which is the point of the feature and also
-- the whole risk of it. So the safety property is that a rule cannot exist
-- without someone having created it: an empty table resolves to the exact
-- predicate the readers already carried, and the reading code treats a missing
-- or unreachable table the same way. Nothing here is seeded, including Ramp --
-- Ramp keeps posting because its rows say so, not because a row in this table
-- says so, and that stays true even if this migration is never applied.
--
-- ── Why it is not a column on ramp_bank_ledger ───────────────────────────────
-- Three reasons. A rule has to be able to name a feed or a counterparty that
-- has no rows yet. A rule is an operator decision with an author and a date,
-- not a property of a transaction. And the ledger table is being extended by
-- the Plaid import at the same time as this; keeping the two apart means
-- neither has to wait for the other.

create table if not exists public.bank_ledger_gl_rules (
  id               uuid        primary key default gen_random_uuid(),

  -- 'source'       — the whole feed, e.g. everything the Chase account sends.
  -- 'counterparty' — one payer or payee within one feed.
  scope            text        not null check (scope in ('source', 'counterparty')),

  -- Matches ramp_bank_ledger.source. Deliberately free text and NOT a check
  -- constraint: which banks exist is configuration, and a constraint here would
  -- have to be edited in lockstep with whatever the importers start writing.
  -- integration_connections.provider takes the same position.
  source           text        not null,

  -- Normalized counterparty key, matching ramp_bank_ledger.counterparty_key and
  -- expense_counterparty_mappings.counterparty_key. Null for a whole-feed rule.
  counterparty_key text,

  -- The human-readable name as it was on screen when the rule was made. Kept so
  -- the settings screen can still name a counterparty whose transactions have
  -- since been filtered out of every query that would have supplied the name.
  counterparty_label text,

  included         boolean     not null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- The two scopes have different shapes, and a counterparty rule with no
  -- counterparty would silently behave as a feed-wide switch.
  constraint bank_ledger_gl_rules_scope_shape check (
    (scope = 'source'       and counterparty_key is null) or
    (scope = 'counterparty' and counterparty_key is not null)
  )
);

comment on table public.bank_ledger_gl_rules is
  'Operator decisions about which bank feeds, and which counterparties within them, post to the general ledger. An empty table means "behave exactly as the importers intended" — see lib/finance/bankLedgerInclusion.ts.';

-- One decision per feed, and one per counterparty within a feed. Partial unique
-- indexes rather than a table constraint because counterparty_key is null on
-- half the rows, and a plain unique (source, counterparty_key) would let a feed
-- collect several contradictory whole-feed rules.
create unique index if not exists bank_ledger_gl_rules_source_idx
  on public.bank_ledger_gl_rules (source)
  where scope = 'source';

create unique index if not exists bank_ledger_gl_rules_counterparty_idx
  on public.bank_ledger_gl_rules (source, counterparty_key)
  where scope = 'counterparty';

create trigger bank_ledger_gl_rules_updated_at
  before update on public.bank_ledger_gl_rules
  for each row execute procedure set_expense_updated_at();

-- ── expense_counterparty_mappings: stop assuming there is one bank ───────────
-- This table was built source-aware from the start -- it has a `source` column
-- and a unique (source, counterparty_key) -- so the same payee arriving on two
-- bank accounts already gets two rows and two independent account choices. That
-- is exactly the wanted behaviour: "GUSTO, seen on the Ramp account" and
-- "GUSTO, seen on the Chase account" are not automatically the same
-- relationship, and a bookkeeper may well code them differently.
--
-- Only the check constraint stood in the way, pinning `source` to 'ramp'. It is
-- dropped rather than widened, for the reason given above on the rules table.
--
-- Note what this deliberately does NOT do: counterparty_key stays the plain
-- normalized name. Encoding the feed into the key would mean rewriting the
-- column on three tables (ramp_bank_ledger, expenses and this one) and would
-- break the payroll matcher, which joins on the bare key. The feed is already
-- the other half of the identity via the unique constraint; making the key
-- carry it too would be the same fact stored twice, with the usual consequence.
alter table public.expense_counterparty_mappings
  drop constraint if exists expense_counterparty_mappings_source_check;

comment on column public.expense_counterparty_mappings.source is
  'Which bank feed this counterparty was seen on. Half of the rule identity: the same name arriving from two banks is two rules, each with its own account.';

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Same posture as the rest of the finance tables: apply_grant_policies is
-- additive-only and bottoms out in effective_grant_level(), so this grants the
-- custom-role path and nothing else. Every application read goes through the
-- service-role admin client behind requirePermission. A SELECT matching no
-- policy returns zero rows rather than an error, which is the intended
-- lock-down default -- do not add a broad read policy to make something work.
alter table public.bank_ledger_gl_rules enable row level security;

select public.apply_grant_policies('bank_ledger_gl_rules', 'finance.transactions');
