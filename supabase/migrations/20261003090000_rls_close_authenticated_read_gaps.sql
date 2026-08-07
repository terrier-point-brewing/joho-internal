-- ============================================================================
-- Close two Data API read gaps that deviate from the documented finance
-- posture, and stop `anon` from executing coa_reference_count.
--
-- THE INTENDED POSTURE (unchanged by this file)
--   finance_reader_roles() returns an EMPTY array on purpose
--   (20260711_tax_module.sql:93, 20260709_rls_phase3_tighten_sensitive.sql:31).
--   Finance tables are service-role-only: every consumer goes through
--   createSupabaseAdminClient() behind a requirePermission() guard, and the
--   Data API surface for them is deliberately shut. This migration does not
--   change that intent -- it fixes two tables that never got it.
--
-- WHY THESE TWO WERE MISSED
--   Phase 3 (20260709) dropped every policy on the finance tables that existed
--   AT THAT TIME. ramp_bank_ledger and expense_counterparty_mappings were
--   created on 20260725 -- sixteen days later -- and their migration says, in
--   as many words, "RLS (mirror expenses: authenticated read, admin/manager
--   manage)". That mirrored the PRE-phase-3 expenses policy pair, which had
--   already been deleted. So they shipped with the old broad posture and no
--   later migration revisited them.
--
-- VERIFIED BEFORE WRITING THIS (live, against prod, as the test account):
--   * ramp_bank_ledger              -> 58 rows readable by a signed-in user
--   * expense_counterparty_mappings -> 12 rows readable by a signed-in user
--   * expenses (the control)        -> [] for the same user, as designed
--   Both tables are read and written EXCLUSIVELY through the admin client:
--     app/api/finance/bank-ledger/route.ts
--     app/api/finance/bank-ledger-rules/route.ts
--     app/api/finance/expense-counterparty-mappings/route.ts
--     lib/finance/financials/fetchSources.ts
--     lib/finance/balances/providers/transactionPostings.ts
--     lib/finance/{autoMap,bankLedger,rampSync}.ts
--     lib/finance/balances/plaidTransactionSync.ts
--   No file that touches either table imports createSupabaseServerClient or a
--   browser client, so closing the Data API surface cannot starve a UI path.
--   service_role bypasses RLS entirely, so the Ramp/Plaid sync crons are
--   unaffected.
--
-- DELIBERATELY NOT IN THIS FILE -- manual_entries "manual flow readers".
--   The security audit flagged it as a bypass of the two grant-gated policies
--   on that table. It is not a deviation; it is load-bearing, and removing or
--   grant-gating it would break two RLS-enforced read paths SILENTLY (zero
--   rows, no error):
--     * app/api/net-sales-summary/route.ts reads manual_entries through the
--       SERVER client with no finance guard at all -- it is reached from the
--       Taproom Achievement tab under CAP.targetsRead, a taproom capability.
--     * app/api/finance/pl/route.ts reads it through the SERVER client behind
--       CAP.financeStatementsRead -- a DIFFERENT scope from
--       finance.transactions, so a has_grant('finance.transactions','read')
--       gate would deny users the app layer has already admitted.
--   20260904120000_manual_entries.sql:104-127 documents exactly this trap.
--   Left in place on purpose. Do not "fix" it without moving both routes onto
--   the admin client first.
-- ============================================================================

-- ── 1. ramp_bank_ledger + expense_counterparty_mappings ─────────────────────
-- Drop BOTH policies per table, not just the read one. "Admins can manage ..."
-- is `for all`, and FOR ALL INCLUDES SELECT -- dropping only the read policy
-- would leave admin/manager still reading 58 rows of bank flow over the Data
-- API, i.e. the finding half-closed.
--
-- apply_grant_policies() is the replacement, matching the neighbours the audit
-- named: bank_ledger_gl_rules (20260917090000:122) and integration_connections
-- both call it and add nothing else.
--
-- READ THE LIVE RESOLVER, NOT THIS REPO'S COPY OF IT. effective_grant_level()
-- in prod is NOT the custom-only version in 20260822_rls_grant_aware_policies.sql:46.
-- 20260826_role_permission_grants.sql added a second arm that also resolves
-- role_permission_grants by get_my_role(), so has_grant() is true for any ROLE
-- holding the scope, not just for role = 'custom'. Verified against prod at the
-- time of writing -- resolved finance.transactions level per role:
--     admin   -> 'admin'  (root '' grant)  => reads
--     manager -> null                      => denied
--     viewer  -> null                      => denied
--     brewer  -> null                      => denied
--     custom  -> null unless an explicit user_permission_grants row says otherwise
-- So this is a real tightening rather than a full lock-out: viewer, brewer and
-- MANAGER lose the read they had, admin keeps it, and a custom user with a real
-- finance.transactions grant keeps it. Dropping "Admins can manage ..." is what
-- removes manager -- that policy was admin OR manager, and manager holds no
-- finance.transactions grant.
--
-- Safe precisely BECAUSE no server-client path reads these tables, so nothing in
-- the UI depends on the roles that just lost access.
drop policy if exists "Authenticated users can read bank ledger"          on public.ramp_bank_ledger;
drop policy if exists "Admins can manage bank ledger"                     on public.ramp_bank_ledger;
drop policy if exists "Authenticated users can read counterparty mappings" on public.expense_counterparty_mappings;
drop policy if exists "Admins can manage counterparty mappings"           on public.expense_counterparty_mappings;

select public.apply_grant_policies('ramp_bank_ledger',              'finance.transactions');
select public.apply_grant_policies('expense_counterparty_mappings', 'finance.transactions');

-- RLS is already enabled on both (20260725_ramp_bank_ledger.sql:74-75). Re-assert
-- rather than assume: a table with policies but RLS disabled enforces nothing.
alter table public.ramp_bank_ledger              enable row level security;
alter table public.expense_counterparty_mappings enable row level security;

-- ── 2. coa_reference_count: revoke anon EXECUTE ─────────────────────────────
-- SECURITY DEFINER and reachable unauthenticated at
-- /rest/v1/rpc/coa_reference_count, where it returns per-GL-account row counts
-- across expenses, payroll, invoices and bank lines. Confirmed live: an anon
-- call returns HTTP 200 with the full per-source breakdown.
--
-- anon holds EXECUTE via the PUBLIC default, not via a direct grant --
-- 20260802_coa_reference_count.sql:63 granted only to service_role and
-- authenticated -- so PUBLIC has to be named or the revoke is a no-op. Same
-- idiom as get_my_role() in 20260630_draft_revoke_internal_function_execute.sql:22.
-- Explicit grants to service_role/authenticated survive this.
--
-- Safe: the only caller is app/api/finance/chart-of-accounts/route.ts:125,
-- which runs on the ADMIN client behind CAP.financeTransactionsManage.
revoke execute on function public.coa_reference_count(uuid) from anon, public;

-- ── NOT IN THIS FILE -- the blanket `anon` DML grants ───────────────────────
-- anon holds SELECT/INSERT/UPDATE/DELETE/TRUNCATE on every public table
-- (confirmed live: an anon PATCH and DELETE against expenses and profiles
-- return 204, not 403 -- PostgREST reached the statement and RLS filtered it
-- to zero rows). That is stock Supabase default-privilege posture, and RLS is
-- currently the thing holding it, so it is defense-in-depth rather than a live
-- breach. Revoking it schema-wide needs its own migration and its own
-- verification pass, because at minimum account_requests must keep anon INSERT
-- (app/api/admin/requests/route.ts:30 posts the request-access form through the
-- SERVER client while unauthenticated, backed by the intentional "Anyone can
-- submit a request" policy), and the fix is incomplete without also correcting
-- ALTER DEFAULT PRIVILEGES so new tables stop reinheriting the grant.
