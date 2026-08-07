-- ============================================================================
-- Tax PII — replace an accidental guard with an explicit, durable one.
--
-- THE ACCIDENT
--   tax_legal_representative.ssn, tax_bank_account.routing_number and
--   tax_bank_account.account_number are guarded today by exactly one policy:
--
--     "finance readers"  using ( get_my_role() = any (finance_reader_roles()) )
--
--   That holds only because finance_reader_roles() happens to return an EMPTY
--   array. Nothing about it says "there is an SSN behind this". Worse,
--   20260709_rls_phase3_tighten_sensitive.sql:22-24 advertises editing that
--   function as the supported way to grant a new role finance access:
--
--     "Granting a future role (e.g. an accountant/finance role) read access to
--      all finance tables is a one-line edit to finance_reader_roles()."
--
--   That one-line edit would hand an SSN and a full bank account number to
--   whatever role was added, over the public Data API, with no review step and
--   nothing on screen to warn the person making it.
--
-- THE FIX — a RESTRICTIVE policy, not another permissive one.
--   Permissive policies OR together, so no permissive policy can ever deny
--   what another permissive policy allows — which is precisely why the current
--   guard is one edit away from failing open. Restrictive policies AND with
--   everything. `as restrictive ... using (false)` therefore denies these
--   tables over the Data API no matter what any other policy says, now or
--   later.
--
--   Specifically, this survives:
--     * finance_reader_roles() being changed to return a non-empty array
--     * effective_grant_level() / has_grant() being wired into RLS
--     * someone calling apply_grant_policies('tax_bank_account', 'finance')
--       (the "one edit-point for every future grant-gated table" from
--       20260822_rls_grant_aware_policies.sql)
--   In every one of those cases the new permissive policy is ANDed with
--   `false` and the tables stay shut. Re-opening them requires deleting a
--   policy whose name and comment both say not to.
--
-- WHY THIS COSTS NOTHING
--   service_role has BYPASSRLS, so restrictive policies do not apply to it,
--   and every consumer of these three tables uses the service-role client:
--     app/api/tax/entity-profile/route.ts
--     app/api/tax/legal-representative/route.ts        + /reveal
--     app/api/tax/bank-account/route.ts                + /reveal
--   Authorization for that data is enforced where it belongs — in the app, at
--   requirePermission(CAP.taxRead / CAP.taxManage / CAP.taxPiiReveal), with
--   the sensitive fields masked on the normal GET and unmasked only through
--   the admin-only reveal routes. This migration does not change who can see
--   an SSN in the product. It removes the possibility of the DATABASE handing
--   one out behind the app's back.
--
-- SCOPE NOTE — tax_entity_profile is included even though it holds no PII
--   today. Its `ssn` column was dropped by 20260730_tax_legal_representative
--   when the signer split into its own table, and `fein` is gone as well;
--   what remains is business identity (legal name, trade name, address,
--   phone, fax). It is service-role-only in practice and nothing reads it over
--   the Data API, so denying costs nothing and keeps the three tax singletons
--   at one uniform posture instead of two-out-of-three.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'tax_legal_representative',
    'tax_bank_account',
    'tax_entity_profile'
  ]
  loop
    if to_regclass('public.' || quote_ident(t)) is null then
      continue;
    end if;

    execute format(
      'alter table public.%I enable row level security', t);

    execute format(
      'drop policy if exists "pii_never_over_data_api" on public.%I', t);

    -- `to public` rather than `to authenticated`: covers anon, authenticated,
    -- and any role added later. service_role is unaffected (BYPASSRLS).
    -- `for all` so writes are denied too, not just reads.
    execute format($p$
      create policy "pii_never_over_data_api" on public.%I
        as restrictive
        for all
        to public
        using ( false )
        with check ( false )
    $p$, t);
  end loop;
end $$;

-- ── Loud markers on the columns themselves ──────────────────────────────────
-- These are what a person inspecting the schema, or an agent reading it, sees
-- before touching anything nearby.

comment on column public.tax_legal_representative.ssn is
  'PII — SOCIAL SECURITY NUMBER. MUST NEVER be exposed to a role-based RLS policy, a view, or any Data API surface. Denied unconditionally by the restrictive policy "pii_never_over_data_api"; do not drop it, and do not "fix" access by adding a permissive policy — permissive policies cannot override a restrictive one, which is the point. Reachable only via the service-role client behind requirePermission(CAP.taxPiiReveal) at app/api/tax/legal-representative/reveal/route.ts. See 20261003090002.';

comment on column public.tax_bank_account.routing_number is
  'PII — BANK ROUTING NUMBER. MUST NEVER be exposed to a role-based RLS policy, a view, or any Data API surface. Denied unconditionally by the restrictive policy "pii_never_over_data_api". Reachable only via the service-role client behind requirePermission(CAP.taxPiiReveal) at app/api/tax/bank-account/reveal/route.ts. See 20261003090002.';

comment on column public.tax_bank_account.account_number is
  'PII — BANK ACCOUNT NUMBER. MUST NEVER be exposed to a role-based RLS policy, a view, or any Data API surface. Denied unconditionally by the restrictive policy "pii_never_over_data_api". Reachable only via the service-role client behind requirePermission(CAP.taxPiiReveal) at app/api/tax/bank-account/reveal/route.ts. See 20261003090002.';

comment on policy "pii_never_over_data_api" on public.tax_legal_representative is
  'Unconditional deny (restrictive, ANDs with every permissive policy). Guards an SSN. Do not drop — the permissive "finance readers" policy alone is one edit to finance_reader_roles() away from exposing it.';

comment on policy "pii_never_over_data_api" on public.tax_bank_account is
  'Unconditional deny (restrictive, ANDs with every permissive policy). Guards a routing + account number. Do not drop — the permissive "finance readers" policy alone is one edit to finance_reader_roles() away from exposing them.';

comment on policy "pii_never_over_data_api" on public.tax_entity_profile is
  'Unconditional deny (restrictive, ANDs with every permissive policy). No PII column today; keeps the three tax singletons at one uniform service-role-only posture.';

-- ── Warn at the edit point the old migration pointed people to ──────────────
-- 20260709 told future maintainers to grant finance access by editing this
-- function. That advice is still fine for the finance group; this comment is
-- the missing caveat about what it does NOT reach, shown by \df+ and by every
-- schema inspector.

comment on function public.finance_reader_roles() is
  'Role set allowed to read the finance-tier tables. Editing this to a non-empty array grants those roles Data API read access to every table carrying the "finance readers" policy — review that list before you do. It deliberately does NOT reach tax_legal_representative, tax_bank_account or tax_entity_profile: those carry a restrictive "pii_never_over_data_api" deny (SSN, bank routing + account number) that no change here can override. See 20261003090002.';
