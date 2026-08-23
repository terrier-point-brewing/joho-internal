-- Clear the settings that were stored but could never fire.
--
-- The Counterparties screen showed four controls, and at least one was always
-- dead on every row -- which one depending on the bank feed, a column the panel
-- hides when there is only one feed:
--
--   * `routing` is read by resolveExpenseMapping, which loads counterparty rules
--     with .eq("source", 'ramp'). On a PLAID counterparty nothing reads it.
--   * `flow_type` is applied by resolveBankBackfill, which only ever FILLS an
--     unclassified row. Ramp classifies every line at import, so on a RAMP
--     counterparty nothing can apply it.
--
-- The screen no longer offers either dead control. This clears what the old one
-- managed to store, because a value that is invisible AND inert is the worst of
-- both: a future change to either resolver would silently activate a rule nobody
-- remembers setting, and there would be nothing on screen to explain the result.
--
-- No reported figure moves. Every value cleared here is one that no reader
-- consults today -- that is precisely why it is being cleared.

begin;

-- Ramp counterparties: a stored flow that the importer's per-line classification
-- always beat. Six rows.
update public.expense_counterparty_mappings
   set flow_type = null
 where source = 'ramp'
   and flow_type is not null;

-- Plaid counterparties: a stored routing that resolveExpenseMapping never sees,
-- because `expenses` holds only Ramp rows. Chase Gusto is the one case, and it
-- read as though the payroll split covered its bank lines when nothing did.
--
-- See the note below: those lines still need an account, and this is what makes
-- the screen say so instead of implying they are handled.
update public.expense_counterparty_mappings
   set routing = 'single_account'
 where source = 'plaid'
   and routing <> 'single_account';

-- The last counterparty-level exclusion. Its lines are already
-- `internal_transfer` with no account, so dropping the exclusion changes no
-- reported figure -- only that the lines become visible in the bank ledger grid,
-- which is the better default: money that moved should be seeable.
--
-- Scoped to `scope = 'counterparty'`. The FEED-level rows are the Bank Feeds
-- panel's switch and are untouched.
delete from public.bank_ledger_gl_rules
 where scope = 'counterparty'
   and source = 'ramp'
   and counterparty_key = 'tpb operating funds (···· 4077)';

commit;

-- ── Known gap this surfaces but does not fix ─────────────────────────────────
-- Payroll split does not reach `bank_ledger` rows: payroll matching reads
-- `expenses` only. Chase Gusto's three lines will sit as operating expenses with
-- no account until either a human codes them or payroll matching learns to read
-- the bank ledger. Before this migration the screen implied the split covered
-- them; now it asks for an account, which is the truth.
