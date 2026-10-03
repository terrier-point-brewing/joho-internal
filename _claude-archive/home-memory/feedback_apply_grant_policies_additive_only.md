---
name: feedback_apply_grant_policies_additive_only
description: apply_grant_policies() alone denies EVERY non-custom role — it is additive-only and must be paired with a role policy or an admin-client route
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e49d81a1-294a-41a5-9d88-81d47b414a19
  modified: 2026-07-30T20:19:56.082Z
---

`public.apply_grant_policies(table, scope)` (migration 20260822) looks like a
complete one-line RLS setup. It is not. Its predicate bottoms out in
`effective_grant_level()`, which carries `and public.get_my_role() = 'custom'::user_role`
(20260822_rls_grant_aware_policies.sql:54). So for a `viewer`/`brewer`/`manager`/`admin`
it always returns false.

On the ten payroll tables it was only ever **additive**, layered on top of an
existing role policy. A NEW table that gets only the grant pair matches **no
policy for any real user**.

**Why:** a SELECT that matches no RLS policy returns **zero rows with no error**.
Not a 403, not a thrown error — an empty result. That renders as a plausible
"no entries yet" empty state in the UI, and any route doing
`const { data } = await supabase.from(...)` silently computes on `[]`. In PR #300
this would have blanked the new subtab *and* silently dropped the prorated manual
adjustment out of `/api/finance/pl` and `/api/net-sales-summary` revenue. Caught
only by the final whole-branch review; per-task reviews structurally cannot see
it, because the migration and the route are each individually correct.

**How to apply:** when adding RLS to a new table, pick one and verify it with a
real non-`custom` session before merging:
1. Add a role-based policy alongside the grant pair, or
2. Lock the table down and read it via `createSupabaseAdminClient()` behind
   `requirePermission` — the house pattern for sensitive finance tables
   (`chart-of-accounts`, `expenses` routes). Note `finance_reader_roles()`
   returns an **empty array** on purpose (20260709_rls_phase3_tighten_sensitive.sql:31-33),
   so a `"finance readers"` policy alone also denies everyone.
3. A partial policy is a good middle ground when only some rows need broad reads —
   PR #300 used `create policy ... for select to authenticated using (entry_kind = 'flow')`
   so P&L-feeding rows stay readable while balance rows stay service-role-only.

Before switching a route to the admin client, check WHO reaches it.
`/api/net-sales-summary` looks like a finance route but is called from the
Taproom Achievement tab under `CAP.targetsRead` — a taproom capability. Putting a
finance guard on it would have locked out taproom users.

Relevant to [[project_balance_sheet_gl_mapping]] (PR B creates three more tables
with RLS), [[project_rls_grant_aware_policies]], [[project_rls_rollout]].
