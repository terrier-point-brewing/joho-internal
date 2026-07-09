# RLS Phase 3 — Tighten sensitive tables (approach A1)

**Date:** 2026-07-09
**Status:** Design approved, pending spec review
**Depends on:** Phase 1 (#130, RLS enabled everywhere) and Phase 2 (#131, cruft dropped) — both applied to prod.

## Problem

Phase 1 enabled RLS on every table with a broad `authenticated USING(true) WITH CHECK(true)`
policy (except payroll/employees, scoped to manager+admin). That closed the **unauthenticated**
hole (the public anon key can no longer read anything). It did **not** close the **cross-role**
gap: a signed-in low-privilege user (e.g. `viewer` or `brewer`) can take their Supabase JWT and
hit the Data API (`https://drlsazatrcrdwaihjmex.supabase.co/rest/v1/...`) directly, bypassing the
app's `requireRole` checks, and read any table that still has `authenticated USING(true)`.

Middleware cannot fix this — it guards the Next.js app's own routes, not the separate Supabase
Data API host. Only RLS policies protect that surface.

## Approach: A1 — tighten the sensitive tables, keep the server client

Guiding principle: **a table is exposed to the `authenticated` role only if the app actually reads
it with the authenticated (server) client.** We do not move data access to the service-role client
(that would be approach B — a ~85-route refactor, riskier because there is no auth middleware).

Access-model facts that drive the groupings (from a route/lib audit on 2026-07-09):
- **Browser client** — auth only (login/logout). No table reads.
- **Server client** (anon key + user JWT → `authenticated` Postgres role) — used by ~85 routes and
  a couple server components for direct `.from()` queries. Affected by RLS.
- **Admin client** (service_role) — bypasses RLS. Used by all `lib/finance/*` sync modules, every
  `/api/finance/*` route, webhooks, and crons.
- Authorization is enforced in-app by `lib/auth.ts` `requireRole`. `get_my_role()` (SECURITY
  DEFINER) resolves the caller's role from `profiles`. No per-user row ownership (single tenant).

### Table groups

**Group 1 — service-role-only (deny `authenticated`).** Finance-domain tables verified as accessed
**only** via the admin (service_role) client at the route layer, so denying `authenticated` breaks
nothing and fully removes them from the authenticated Data-API surface:

- `invoice_line_items`
- `invoice_batch_links`
- `expenses`
- `expense_account_mappings`
- `chart_of_accounts`
- `pos_line_items`
- `square_orders`
- `square_refunds` (already deny-all since 20260716; formalized here for consistency)

**Group 2 — role-scoped `authenticated` (manager + admin).** Payroll/PII, already scoped in Phase 1;
refactored here to use the shared helper (below) instead of hardcoded role literals:

- `payroll_entries`, `payroll_config`, `pay_periods`, `employees`

**Group 3 — leave at `authenticated`-read (unchanged).** Everything else, because operational roles
legitimately read them via the server client, or an un-role-gated server route does:

- `invoices` (read by `brewer` deposit/allocation/export routes via server client)
- `export_transactions`, `export_transaction_taxes` (read by `brewer` export routes)
- `excise_tax_rates`, `deposit_invoice_ingredients` (operational reference)
- `invoice_item_mappings` (low-sensitivity mapping config; reached by libs whose client path isn't
  cleanly admin-only — leave to stay safe)
- `manual_net_sales_entries` (read by `api/net-sales-summary`, a server-client route with no role
  gate — locking would break the summary for non-admins)
- `quarterly_targets` (admin-gated but read via the server client, so it can't be service-role-only;
  an admin-only tightening is a possible later follow-up, out of scope for A1)
- all production / taproom / catalog / reference tables

## Mechanism: centralized role-set helpers (future-role extensibility)

Adding a future role (e.g. a `finance`/`accountant` role) must be a **one-line** change, not an
N-table edit. So the allowed-role set for each tier lives in a single SQL function, and every policy
in that tier references it:

```sql
-- Empty now => no authenticated role passes => service-role-only.
-- To grant a future finance role read access, add it here — all Group 1 tables inherit it.
create or replace function public.finance_reader_roles()
  returns user_role[] language sql immutable as $$ select array[]::user_role[] $$;

create or replace function public.payroll_reader_roles()
  returns user_role[] language sql immutable as $$ select array['manager','admin']::user_role[] $$;
```

Policy shape:

```sql
-- Group 1 (finance): restrictive today (empty set), one edit-point to open up later.
create policy "finance readers" on public.<table>
  for all to authenticated
  using ( get_my_role() = any (public.finance_reader_roles()) )
  with check ( get_my_role() = any (public.finance_reader_roles()) );

-- Group 2 (payroll): manager + admin via the shared helper.
create policy "payroll readers" on public.<table>
  for all to authenticated
  using ( get_my_role() = any (public.payroll_reader_roles()) )
  with check ( get_my_role() = any (public.payroll_reader_roles()) );
```

`finance_reader_roles()`/`payroll_reader_roles()` are pure constant functions (no table reads, not
SECURITY DEFINER), so they add no new advisor findings. `get_my_role() = any('{}')` evaluates to
false, so Group 1 denies every authenticated role today; `service_role` bypasses RLS and keeps the
app working. Anon (`get_my_role()` → null) is denied everywhere.

The migration replaces each Group 1 table's Phase-1 `"authenticated full access"` policy with the
`"finance readers"` policy, and each Group 2 table's Phase-1 policy with `"payroll readers"`. Group 3
policies are untouched. Idempotent (`drop policy if exists` + `create policy`).

## Verification

1. Re-run `get_advisors(security)` — expect no new ERRORs.
2. Anon-key probe — still 0 tables readable.
3. **Authenticated probe** with a non-admin (e.g. `viewer`/`brewer`) JWT: confirm Group 1 tables
   return 0 rows / are denied, while Group 3 tables still read. (Mint a short-lived test token or use
   an existing non-admin session.)
4. Smoke-test the app: finance pages/statements (admin-client, must still load), a brewer export/
   deposit-invoice flow (server-client reads of `invoices`/`export_transactions`, must still work).

## Rollback

Reversible: re-point the Group 1/2 policies back to `USING(true)` (or restore the Phase-1 policy
names). No data touched. Helper functions can be dropped if fully reverted.

## Out of scope (tracked separately)

- **Middleware** — a session gate for `/api/*` and protected pages, as its own PR after Phase 3
  (different layer: guards app routes, not the Data API).
- **A2** — full per-table role matrix (production→brewer+, etc.).
- **Approach B** — service-role refactor + deny `authenticated` globally.
- Optional admin-only tightening of `quarterly_targets` / `manual_net_sales_entries`.
- Advisor extras: SECURITY DEFINER functions callable by anon, mutable `search_path`, Auth
  leaked-password protection.
