---
name: project-brewer-deposit-invoices-and-inventory-gates
description: "PR #290 — invoices carries an admin-only RLS policy so its routes must use the admin client; production.inventory has two tiers and the create routes sat on the wrong one"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6fd46b71-c72f-498f-b60c-1e151377ba4e
  modified: 2026-07-29T02:39:50.297Z
---

2026-07-28, **PR #290 OPEN**, branch `claude/brewer-deposit-invoices-visibility-56167c`. No migration, no backfill — safe to merge on review alone.

Rebased onto main after #288/#289 landed (`ac4f2e7`, `63616c7`). #288 "unify inventory tab controls" restyled and REORDERED the exact toolbars this PR gates, so both tabs conflicted in the toolbar hunk — resolved by keeping main's layout (`min-w-32`, Bulk Receive promoted to `btn-primary`, Bulk Upload moved to second position) and re-applying the gates on top. Per [[project_scope_structure_restructure]]'s lesson, the resolution was checked by grepping for every changed symbol (`canOperate`, the three route gates, the admin client, the `res.ok` guards) rather than trusting a clean build — a rebase can drop a change silently and still compile.

**Durable gotcha 1 — `invoices` is admin-only at the DB layer.** `invoices` and `deposit_invoice_ingredients` still carry the admin-only RLS policy from `20260609_invoices.sql` / `20260709_deposit_invoice_ingredients.sql`. The Phase-1 sweep (`20260709_enable_rls_phase1.sql`) deliberately SKIPPED already-RLS-enabled tables, and the grant-aware `20260822` covers only payroll — so that 2026-06-09 policy is still live. **Any route reading `invoices` must use `createSupabaseAdminClient()` with `requirePermission` as the real gate.** Every sibling already did (`export/invoices`, `export/invoice`, `deposit-invoices/backfill`, and the `invoices` writes inside `allocations/[id]/invoice`); `deposit-invoices/route.ts` was the lone holdout, which is why brewers saw an empty tab while 18 rows existed. RLS FILTERS rows rather than erroring — a permissions bug presents as "no data", never as a 403.

**Durable gotcha 2 — `fetch` resolves on 4xx.** Three separate silent failures in this one investigation, all the same root cause: `DepositInvoicesTab` discarded the query `error` channel; `saveBulkEdit`'s `Promise.all` fulfilled on a rejected PATCH and exited bulk-edit mode as if every row saved; `toggleDefault` refetched and snapped the star back with no message. When auditing a "button does nothing" report, grep the handler for a missing `res.ok` check before suspecting anything else.

**Durable gotcha 3 — `production.inventory` is two tiers on one scope.** `manage` = master data (create/edit/delete an ingredient or packaging item); `operate` = stock movements (adjust, receive). Brewer holds `operate`. The create routes (`POST /ingredients`, `/ingredients/bulk`, `/packaging`) were gated at `operate` while `PATCH`/`DELETE` on the same resources were at `manage` — so a brewer could bulk-create what they could not edit one at a time. **A pure grant edit cannot separate these**: demoting brewer to `read` also removes their day-to-day adjustments. The split has to happen at the capability the control is wired to. Pinned now by `app/api/production/inventory-write-gates.test.ts`, which asserts the `(scope, level)` COORDINATE, not the CAP name.

Also from this session: the UI convention is that write affordances resolve a flag per tier and hang off it — `canEditMaster` + `canOperate` in both `IngredientsTab` and `PackagingTab`. Operate-level controls used to render unconditionally, so a `custom` role with `production.inventory: read` saw buttons that could only 403.

Unverified: the button visibility was never click-tested as a brewer — that needs a brewer login, and every page redirects to `/login` unauthenticated. Route gates and `can()` resolution are test-covered; only the rendering is unconfirmed.

Related: [[project_scope_structure_restructure]], [[project_rls_rollout]], [[project_rls_grant_aware_policies]], [[project_deposit_invoice_breakdown]].
