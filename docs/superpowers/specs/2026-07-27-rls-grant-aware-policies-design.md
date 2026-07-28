# Grant-aware RLS — unblocking `role = 'custom'` at the database layer

**Date:** 2026-07-27
**Migration:** `supabase/migrations/20260822_rls_grant_aware_policies.sql`
**Tests:** `lib/auth/__tests__/rlsGrantParity.test.ts`
**Prior art:** `2026-07-25-scoped-permissions-design.md` (PR #275), `20260709_rls_phase3_tighten_sensitive.sql`

---

## 1. The gap

PR #275 added a fifth role, `custom`, whose permissions come from per-user
`(scope, level)` rows in `user_permission_grants` rather than from a static
bundle. The app layer honors it: `getSessionUser()` loads the grant rows,
`can()` resolves longest-prefix-wins, `requirePermission()` gates the route.

The database layer does not. Every RLS policy on a payroll table reads:

```sql
using ( public.get_my_role() = any (public.payroll_reader_roles()) )
```

and `payroll_reader_roles()` returns `array['manager','admin']`. No RLS policy
anywhere consults `user_permission_grants` — the only migration that references
that table is `20260820`, which created it.

Payroll API routes query through `createSupabaseServerClient()` (the
`authenticated` Postgres role, RLS enforced), **not** the admin client. So a
user with `role = 'custom'` and a `payroll: operate` grant passes
`requirePermission(CAP.payrollOperate)` in the route handler and is then handed
zero rows — or a write rejection — by Postgres.

---

## 2. System-wide inventory of role-name-based policies

Before choosing a fix, every policy in `supabase/migrations/` that discriminates
between *authenticated* roles was enumerated, along with which Supabase client
the app actually uses to reach those tables. RLS only matters where the app
reads through the **server** client; the **admin** (`service_role`) client
bypasses RLS entirely.

| Policy group | Predicate | Tables | App client | Affected by `custom`? |
|---|---|---|---|---|
| `payroll readers` | `get_my_role() = any(payroll_reader_roles())` → `{manager, admin}` | `payroll_entries`, `payroll_config`, `pay_periods`, `employees` (`20260709_rls_phase3`); `payroll_department_gl_mappings`, `payroll_gl_settings`, `payroll_gl_reports`, `payroll_gl_report_employees`, `payroll_gl_report_totals` (`20260714`); `payroll_shift_overrides` (PR #277, `20260821`) | **server** | **YES — real lockout** |
| `finance readers` | `get_my_role() = any(finance_reader_roles())` → `{}` (empty) | 8 finance tables (`20260709_rls_phase3`), ~12 tax tables (`20260711`, `20260713`, `20260728`, `20260730`, `20260804`), plus `payroll_period_expense_matches` and `expense_gl_splits` (`20260714`) | **admin** | No — see §3.3 |
| audit log | `get_my_role() = 'admin'` | `audit_log` | admin | No |
| account requests | `exists(profiles p where p.id = auth.uid() and p.role = 'admin')` | `account_requests` | admin | No |
| profiles | same `exists(...role='admin')` for read-all / update | `profiles` | admin (`/api/admin/users*`) | No — the separate `auth.uid() = id` self-read policy is what `getSessionUser()` needs, and it is role-agnostic |
| catch-all | `true` | every other base table (`20260709_enable_rls_phase1` §3) | server | No — DB is permissive, app layer gates |

**Conclusion: payroll is the only group where the gap is load-bearing.** It is
the single place in the schema where a role-name check both discriminates among
authenticated roles *and* sits in front of a server-client read path.

---

## 3. Decision

**Option 2b — additive, grant-aware policies, scoped to the payroll group,
resolved by a shared SQL helper that mirrors `lib/auth/resolve.ts`.**

Two new `SECURITY DEFINER` functions plus one applicator:

```sql
public.effective_grant_level(p_scope text) returns permission_level
public.has_grant(p_scope text, p_need permission_level) returns boolean
public.apply_grant_policies(p_table text, p_scope text) returns void
```

Each payroll table gains two **permissive** policies alongside the untouched
`payroll readers` policy (permissive policies OR together):

```sql
create policy "grant read"  ... for select using ( has_grant('payroll','read') );
create policy "grant write" ... for all    using ( has_grant('payroll','operate') )
                                           with check ( has_grant('payroll','operate') );
```

### 3.1 Why not the coarse fix (add `'custom'` to `payroll_reader_roles()`)

One line, but it grants *every* custom user unconditional access to all payroll
PII regardless of what their grants actually say. It converts the app-layer
grant model into advisory metadata for precisely the most sensitive table group
in the schema — a custom user granted only `production.brewing: read` would be
able to read `employees` and `payroll_entries` straight off the Data API with
their own JWT. Rejected.

### 3.2 Why not move payroll onto the admin client

A third option exists and was considered: swap the ~11 payroll routes to
`createSupabaseAdminClient()` and set `payroll_reader_roles()` to `{}`, matching
what finance and tax already do. It needs no SQL/TS logic mirror at all.

Rejected because it **removes** the defense-in-depth that currently exists. The
payroll policies are the one place where a forgotten `requirePermission()` in a
route is still caught by Postgres. Making the tables service-role-only would
delete that backstop for the most sensitive data in the system, right as the
first sub-admin write path is being introduced. The grant-aware fix moves in the
opposite direction: it makes the DB enforce the *same* model the app enforces,
so a route-level miss is still denied and per-user grants become genuinely
load-bearing rather than advisory.

### 3.3 Why finance and tax are deliberately left alone

`finance_reader_roles()` returns an empty array. That is not a bug and not the
same gap: every consumer of those tables uses the admin client, which bypasses
RLS. The empty array is a **deliberately closed** Data API surface — no
authenticated role, including `admin`, can reach those tables with a user JWT.

Adding grant-aware policies there would *open* a surface that is currently shut,
for zero functional gain (nothing reads them through the server client). If a
future feature moves a finance or tax route onto the server client, the
applicator built here makes it a one-line call —
`perform public.apply_grant_policies('expenses', 'finance.transactions')` — but
that is a decision for the migration that introduces the need, not this one.

Same reasoning for `audit_log`, `account_requests`, and `profiles`: admin-client
only, so the role-name predicates never gate a real request path.

### 3.4 Why `custom`-only, and why additive

`effective_grant_level()` returns `NULL` unless `get_my_role() = 'custom'`,
exactly mirroring `getSessionUser()`, which consults `user_permission_grants`
only for that role. This matters beyond symmetry: without the role gate, a user
switched from `custom` back to `viewer` while stale grant rows remain would
silently retain DB access the app layer has already revoked.

The existing `payroll readers` policy is left byte-for-byte intact. Manager and
admin behavior is unchanged, so this migration cannot regress the working path —
it can only add access for `custom`.

---

## 4. Mirroring `lib/auth/resolve.ts` in SQL

The SQL must reproduce three behaviors. Each has a corresponding assertion in
`rlsGrantParity.test.ts`.

**Longest-prefix-wins, dot-delimited.** `order by length(g.scope) desc limit 1`
over rows matching `scope = '' OR scope = p_scope OR starts_with(p_scope, scope || '.')`.
`starts_with()` is used rather than `LIKE scope || '.%'` because `LIKE` would
treat an `_` in a future scope key as a wildcard. The `scope = ''` arm is ROOT,
which has length 0 and therefore sorts last — correct, since ROOT is the
weakest match.

Ties are theoretically possible only between two equal-length keys that both
match the same scope, which cannot happen (an exact match is strictly longer
than any dot-prefix of it). TS resolves ties first-wins; SQL resolves them by
whatever `order by` returns. Not reachable, noted for completeness.

**Rank comparison.** `permission_level` was declared in `20260820` as
`enum ('none','read','operate','manage','admin')` — the same order as
`RANK` in `lib/auth/levels.ts`. Postgres enum comparison operators follow
declaration order, so `level >= p_need` *is* the rank check, for free. **This is
a load-bearing, non-obvious coupling**: reordering the enum or reordering `RANK`
without the other silently changes who can read payroll. The test asserts the
two orders match.

**`none` and absent grants both deny.** `none` is rank 0 and loses every
`>= p_need` comparison for a real `need`; an absent grant yields `NULL`, and
`coalesce(..., false)` denies. Same two-paths-one-outcome shape as `can()`.

---

## 5. Consequences and follow-ups

- **`payroll: read` now confers DB-level `SELECT` on `employees`.** That is
  parity with what `manager` has today, not a new exposure. If employee PII
  should be separable from payroll numbers, the fix is a distinct
  `payroll.employees` scope — flagged, not built here.
- **Ordering hazard with PR #277.** `payroll_shift_overrides` is created by
  `20260821` on an unmerged branch. This migration guards every table behind
  `to_regclass`, so it applies cleanly whether or not #277 has landed. If #277
  lands *after* this migration is applied to prod, its table will be created
  with only the `payroll readers` policy — re-run the §3 `DO` block of this
  migration (it is idempotent) or have #277 call
  `perform public.apply_grant_policies('payroll_shift_overrides','payroll')`.
- **Per-row function cost.** Both policy predicates are wrapped in
  `(select ...)` so the planner caches them as an InitPlan rather than
  re-evaluating per row — the same technique
  `20260709_enable_rls_phase1.sql:45` used, and it matters on `payroll_entries`
  scans.
- **Not applied to prod.** Prod migration application is human-gated in this
  repo. `20260821` (PR #277) is also still pending.
