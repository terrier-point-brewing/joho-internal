---
name: project_rls_grant_aware_policies
description: 2026-07-27 grant-aware RLS (migration 20260822) unblocking role=custom on payroll tables; PR #281 MERGED, migration PENDING prod apply; enum-order coupling gotcha.
metadata: 
  node_type: memory
  type: project
  originSessionId: fcc6d10b-a948-40e5-9a97-0efbe1b3175c
  modified: 2026-07-28T02:36:44.619Z
---

**PR #281 MERGED** (squashed to `68618b2` on main). Worktree + branch cleaned up.
Design doc: `docs/superpowers/specs/2026-07-27-rls-grant-aware-policies-design.md`.

⚠️ **Migration `20260822_rls_grant_aware_policies.sql` PENDING prod apply.**
Until applied, a `role = 'custom'` user with a `payroll` grant passes
`requirePermission()` and is then denied by Postgres — the payroll UI returns
empty/500s for them. Related open gate: `20260821` (PR #277) also pending.

**The gap it closes:** PR #275 ([[project_orchestration_handoff]] era) added the
`custom` role + `user_permission_grants`, but NO RLS policy consulted that
table. Payroll policies gate on `get_my_role() = any(payroll_reader_roles())` =
`{manager, admin}`.

**Why payroll only** — the non-obvious part. RLS only bites where the app reads
through `createSupabaseServerClient()`. Payroll routes do; finance, tax,
`audit_log`, `account_requests`, `profiles` admin paths all use the **admin
client**, which bypasses RLS. So `finance_reader_roles()` returning an empty
array is *deliberate closure*, NOT the same bug — adding grant policies there
would OPEN a Data API surface that is currently shut. Don't "fix" it.

**Durable coupling (load-bearing, silent if broken):** `has_grant()` compares
`level >= p_need` and relies entirely on the `permission_level` enum being
declared in `20260820` as `('none','read','operate','manage','admin')` — the
same order as `RANK` in `lib/auth/levels.ts`. Postgres enum comparison follows
declaration order, so that IS the rank check. Reordering either side without
the other silently changes who can read payroll PII. Asserted by
`lib/auth/__tests__/rlsGrantParity.test.ts`.

**How to add a grant-gated table later:** call
`perform public.apply_grant_policies('<table>', '<scope>');` — don't hand-write
the policy pair. It is `to_regclass`-guarded and idempotent.

**Ordering hazard (still live — both are on main, neither applied to prod):**
if `20260821` (PR #277 MERGED, creates `payroll_shift_overrides`) is applied to
prod *after* `20260822`, that table gets only its "payroll readers" policy and
custom-role users stay locked out of it specifically. Apply 20260821 first, or
re-run `20260822`'s §3 DO block afterwards (idempotent).
See [[project_payroll_day_override_grid]].

No local Postgres was reachable in the worktree, so the SQL is verified by
review + the TS parity tests, **not** by execution. Worth a real apply against
a scratch DB before prod. See [[project_prod_db_migration_authorization]] —
orchestrator applies, never a subagent.
