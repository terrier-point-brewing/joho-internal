# Schema Audit — 2026-06-30

**Scope:** Supabase project `drlsazatrcrdwaihjmex` (public schema), cross-checked against
`supabase/migrations/` (source of truth) and `docs/production-schema.md`.

**Method:** Read-only. Live DB inspected via Supabase MCP read tools
(`list_tables`, `list_migrations`, `get_advisors`, and `SELECT`-only `execute_sql`
over `pg_catalog` / `information_schema`). **No DDL/DML run. No migration applied.**
Live-DB access **worked** — findings below reflect the actual live schema, not a static guess.

54 base tables + 1 view (`batch_exhaustion`). Codebase references checked with ripgrep
across `app/` and `lib/`.

---

## Severity summary

| # | Finding | Severity |
|---|---|---|
| S1 | RLS disabled on 38 of 54 public tables (PostgREST-exposed) | **HIGH (security)** |
| S2 | `batch_exhaustion` view is `SECURITY DEFINER` | **HIGH (security)** |
| S3 | 4 `SECURITY DEFINER` functions executable by `anon`/`authenticated` | MEDIUM (security) |
| S4 | 8 functions with mutable `search_path` | MEDIUM (security) |
| S5 | `account_requests` INSERT policy is `WITH CHECK (true)` | LOW (security, by design) |
| S6 | 66 foreign keys with no covering index | MEDIUM (performance) |
| S7 | Delete-rule inconsistency: `batch_conversions.*` and `recipes.partner_id` use `NO ACTION` where every sibling partner/batch FK uses `SET NULL`/`CASCADE` | MEDIUM (integrity) |
| S8 | `workflow_templates` / `workflow_template_steps` — orphaned (0 rows, no UI), superseded by `brew_step_templates` | MEDIUM (dead schema) |
| S9 | Migration-file version numbers diverge from live `supabase_migrations` ledger (squashed/renumbered) | LOW (process) |
| S10 | Leaked-password protection disabled in Auth | LOW (security) |
| S11 | Naming inconsistency: `batch_tank_assignments.tank_id` / `batch_transfers.from_tank_id`/`to_tank_id` keep `tank_*` names though they FK `equipment.id` | LOW (cosmetic, intentional back-compat) |

---

## HIGH

### S1 — RLS disabled on 38 of 54 public tables
The `get_advisors(security)` lint returns `rls_disabled_in_public` (level ERROR) for 38 tables
that PostgREST exposes, including financially/operationally sensitive ones:
`brew_batches`, `batch_transfers`, `batch_allocations`, `export_transactions`,
`export_transaction_taxes`, `excise_tax_rates`, `invoice_item_mappings`,
`payroll_config`, `payroll_entries`, `pay_periods`, `employees`, `commitments`,
`contract_brewing_partners`, `recipes`, `recipe_ingredients`, `ingredients`,
`packaging_variations`, `packaging_items`, `equipment`, `quarterly_targets`,
`manual_net_sales_entries`, and more.

Only 16 tables have RLS enabled (e.g. `profiles`, `invoices`, `invoice_line_items`,
`pos_line_items`, `square_orders`, `square_catalog_*`, `chart_of_accounts`, `events`,
`tap_assignments`, `system_settings`, `account_requests`, `audit_log`,
`brew_step_template*`).

**Evidence:** `pg_class.relrowsecurity = false` for the 38 tables; advisor lint
`0013_rls_disabled_in_public`. **Risk:** if a route ever uses the anon/auth client
instead of the service-role/admin client, these tables are world-readable/writable through
PostgREST. **Note:** the app appears to gate access at the route layer (`lib/auth.ts`)
and uses server/admin Supabase clients, so this may be an accepted posture — but it is
the single largest security-surface item and should be an explicit, documented decision.

**Remediation:** enable RLS + add policies, OR explicitly revoke PostgREST access for these
tables. *Not auto-drafted* — requires product decision on the access model and per-table
policy design; a blind `ENABLE ROW LEVEL SECURITY` with no policy would break the app.

### S2 — `batch_exhaustion` view is SECURITY DEFINER
Advisor lint `0010_security_definer_view`. The view runs with the creator's privileges,
bypassing the querying user's RLS. Because the view aggregates `batch_transfers`
(itself RLS-disabled), the exposure is currently moot, but it is a latent escalation path
once S1 is addressed. **Remediation:** recreate as `security_invoker = true`. Not drafted
(view DDL not in scope of a "clearly-safe column drop"; needs the view body, which should
be edited in its owning migration).

---

## MEDIUM

### S3 — SECURITY DEFINER functions callable by anon/authenticated
`audit_trigger_fn`, `backfill_recipe_link_variation_ids`, `get_my_role`,
`handle_new_user` are `SECURITY DEFINER` and reachable via `/rest/v1/rpc/...` by
`anon` and `authenticated`. `audit_trigger_fn` and `handle_new_user` are trigger
functions that should never be called directly; `backfill_recipe_link_variation_ids` is a
one-shot backfill that should not remain callable. **Remediation:** `REVOKE EXECUTE ... FROM
anon, authenticated` (and `PUBLIC`). Drafted: see `..._draft_revoke_internal_function_execute.sql`.
(`get_my_role` is intentionally callable by `authenticated` — it powers role checks — so the
draft leaves `authenticated` EXECUTE on `get_my_role` and only revokes `anon`.)

### S4 — Mutable search_path on 8 functions
`backfill_recipe_link_variation_ids`, `create_batch_with_consumption`, `set_updated_at`,
`record_batch_transfer` (two overloads), `recompute_variation_total_volume`,
`set_payroll_entries_updated_at` lack a pinned `search_path` (lint
`0011_function_search_path_mutable`) — a privilege-escalation vector for SECURITY DEFINER
functions. **Remediation:** `ALTER FUNCTION ... SET search_path = public, pg_temp`. Not
auto-drafted because the exact argument signatures (esp. the two `record_batch_transfer`
overloads) must be confirmed against each function's owning migration before `ALTER`.

### S6 — 66 foreign keys without a covering index
Every FK column reported by the `pg_constraint`/`pg_index` cross-check lacks a leading-column
index, so cascade deletes and joins on the parent do sequential scans. Highest-traffic
offenders (by row count / join frequency):
`pos_line_items.chart_of_accounts_id`, `batch_transfers.batch_id`/`from_tank_id`/`to_tank_id`/`to_batch_id`/`variation_id`,
`stock_adjustments.ingredient_id`/`batch_id`, `recipe_ingredients.recipe_id`/`ingredient_id`,
`export_transactions.recipe_id`/`recipient_id`/`source_transfer_id`/`packaging_item_id`,
`invoice_line_items.bs_chart_of_accounts_id`/`pl_chart_of_accounts_id`/`delivery_invoice_id`,
`square_catalog_variations.{chart_of_accounts_id,_pos,_invoice,bs_,pl_}`,
`batch_status_history.batch_id`, `batch_tank_assignments.batch_id`,
`commitments.recipe_id`/`partner_id`, `cold_storage_inventory.recipe_id`/`source_transfer_id`,
`packaging_variations.{lid_id,label_id,paktech_id,tray_id}`, `payroll_entries.employee_id`,
plus ~40 more (full list in the draft migration). **Adding an index is non-destructive and
low-risk.** Drafted: see `..._draft_add_missing_fk_indexes.sql` (`CREATE INDEX IF NOT EXISTS`,
no `CONCURRENTLY` since these tables are tiny today — reviewer may switch to `CONCURRENTLY`
if running against prod under load).

### S7 — Inconsistent FK delete rules
`batch_conversions.source_batch_id`, `.target_batch_id`, `.source_equipment_id` use
`NO ACTION`, and `recipes.partner_id` uses `NO ACTION`, whereas every other
batch-referencing FK uses `CASCADE` (e.g. `batch_status_history.batch_id`,
`batch_transfers.batch_id`) and every other `partner_id` FK uses `SET NULL`
(`commitments.partner_id`, `ingredients.partner_id`, `invoices.partner_id`,
`packaging_items.partner_id`, `batch_allocations.partner_id`). Result: deleting a partner
or a batch can fail with an FK violation in these specific spots while succeeding elsewhere —
inconsistent operator experience. **Remediation:** decide the intended rule per FK and
`ALTER ... DROP CONSTRAINT / ADD CONSTRAINT`. **Not auto-drafted** — changing a delete rule
is a semantic decision (cascade-delete conversions vs. block deletion), not a "provably safe"
mechanical fix. Flagged for human decision.

### S8 — `workflow_templates` / `workflow_template_steps` orphaned tables
Both tables have **0 live rows**. They are the *original* batch-workflow system; the live
system is `brew_step_templates` + `brew_step_template_steps` (used by `RecipesTab.tsx` and
`BrewStepTemplatesTab.tsx`) and `recipe_brew_activity_templates`. The two API route files
`app/api/production/workflow-templates/route.ts` and `.../[id]/route.ts` have **no UI
fetch callers** (verified: no `.tsx` under `app/` fetches `workflow-templates`, whereas
`brew-step-templates` is fetched by `RecipesTab.tsx` and `BrewStepTemplatesTab.tsx`).
**Remediation:** drop both tables (and the two route files — see dead-code report). Drafted
as `..._draft_drop_workflow_templates.sql`, headed DO-NOT-APPLY and gated on confirming no
external/automation consumer hits the routes.

---

## LOW

### S5 — `account_requests` permissive INSERT
Policy `Anyone can submit a request` is `WITH CHECK (true)` for INSERT (lint
`0024_permissive_rls_policy`). This is **intentional** — the public account-request form must
allow anonymous inserts. Recorded for completeness; recommend leaving as-is but adding a
rate-limit / captcha at the route layer.

### S9 — Migration-file ↔ live-ledger version divergence
The live `supabase_migrations.schema_migrations` ledger uses different version strings than
the filenames in `supabase/migrations/` (e.g. live ledger has `20260710_recipe_square_links_variation_grain`,
`20260709_catalog_variation_units`, `20260708_drop_*`, `20260711_packaging_material_service_type`,
plus bare-date entries like `20260621`, `20260627`, `20260628`, `20260630`). The **content**
appears reconciled — every drift name has a matching file in `supabase/migrations/` — so this
is process/hygiene, not missing schema. **Remediation:** none required for correctness;
consider `supabase migration repair` to align version strings so future `db push` diffs are
clean. No draft (touching the migration ledger is exactly the kind of DDL we must not run).

### S10 — Leaked-password protection disabled
Auth lint `auth_leaked_password_protection`. Enable HaveIBeenPwned checks in Auth settings
(dashboard toggle, not a migration).

### S11 — `tank_*` column names on `equipment`-referencing FKs
`batch_tank_assignments.tank_id`, `batch_transfers.from_tank_id`/`to_tank_id` keep the
`tank_*` naming although the `tanks` table was renamed to `equipment`
(`docs/production-schema.md` notes this is **deliberate back-compat**). No action; documented
so a future reader doesn't "fix" it and break code that hardcodes the column names.

---

## Items explicitly checked and found OK (no finding)

- **Leftover Square/Ramp sync columns:** `batch_allocations.square_deposit_invoice_id` /
  `square_deposit_order_id` / `square_payment_id` / `square_refund_id`,
  `brew_batches.square_invoice_id`, `contract_brewing_partners.square_customer_id`,
  `employees.square_team_member_id` / `gusto_employee_id`,
  `excise_tax_rates.square_catalog_*`, the `square_catalog_*` mirror tables, and the
  `chart_of_accounts_id{,_pos,_invoice}` / `bs_`/`pl_` quad on `square_catalog_variations`
  and `invoice_line_items` are **all still referenced** in `app/`/`lib/` — these are live
  integration columns, not orphans. (The 4-way COA mapping is intentional: POS vs invoice vs
  balance-sheet vs P&L account assignment.) No Ramp-specific columns exist in the schema;
  Ramp data is fetched live via `lib/ramp.ts`, not persisted.
- **`recipe_square_links` legacy columns** (`square_variation_id`, `square_item_id`,
  `variation_name`, `item_name`, `packaging_item_id`): still read by the unified resolver
  `lib/square/skuMappings.ts` and others; `docs/production-schema.md` confirms
  `packaging_item_id` is intentionally kept denormalized for legacy readers. Not dropped.
- **No duplicate/near-duplicate tables** beyond S8 (the workflow→brew-step supersession).
- **No type mismatches** found on join keys: every FK pair is `uuid → uuid`; money is
  consistently `bigint` cents in finance tables (`*_cents`) and `numeric` for rate/volume
  elsewhere.

---

## What was drafted (none applied — see `supabase/migrations/*_draft_*.sql`)

Only mechanically-safe, non-semantic fixes were drafted:
1. `20260630_draft_add_missing_fk_indexes.sql` — additive indexes for high-value unindexed FKs (S6).
2. `20260630_draft_revoke_internal_function_execute.sql` — `REVOKE EXECUTE` on trigger/backfill
   SECURITY DEFINER functions from `anon`/`authenticated`/`public` (S3).
3. `20260630_draft_drop_workflow_templates.sql` — drop the two orphaned, 0-row, no-UI tables (S8),
   gated on confirming no automation consumer.

**Not drafted (need a human semantic decision):** S1 (RLS model), S2 (view rewrite),
S4 (search_path — needs exact signatures), S7 (delete-rule intent), S9 (ledger repair),
S10 (Auth dashboard toggle). Rationale per finding above.
