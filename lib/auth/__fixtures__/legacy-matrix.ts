import type { UserRole } from "../roleGrants";
import type { CAP } from "../capabilities";

export interface LegacyRow {
  route: string;
  method: string;
  legacy: UserRole[];
  capability: keyof typeof CAP;
  intentionalChange?: Partial<Record<UserRole, boolean>> & { reason: string };
}

/**
 * Generated from docs/superpowers/specs/2026-07-25-scoped-permissions-validation/
 * (audit94.txt + scopes.js + verify.mjs's GROUP_LEVEL/ROUTE_OVERRIDE) by a
 * throwaway script — see lib/auth/__tests__/equivalence.test.ts for how it's
 * consumed. Do not hand-edit; regenerate if the validation source changes.
 *
 * 213 rows, one per (route, method) call site under app/api/**. 30 rows carry
 * an intentionalChange — together they cover all 31 assertions (out of 852)
 * that differ from legacy requireRole behaviour; one route
 * (GET production/batch-conversions) accounts for two of them (a viewer
 * loss and a brewer gain), so 31 differing assertions land on 30 rows. See
 * docs/superpowers/specs/2026-07-25-scoped-permissions-design.md, "Validation
 * result", for the reasons.
 *
 * The 28th row (GET payroll/periods/[id]/shifts) was hand-edited on 2026-07-27
 * when that route's gate was lowered from payrollManage to payrollRead; see
 * docs/superpowers/specs/2026-07-27-payroll-day-override-grid-design.md §5.
 * The 29th row (PUT payroll/periods/[id]/shift-overrides/[employeeId]) was
 * added the same day for the new day-override save route — a brand-new call
 * site with no legacy equivalent (legacy: []).
 * POST payroll/gl-reports/backfill was added on 2026-07-28 when the tips
 * balance-sheet pass-through work exposed that this route was missing from the
 * pinned matrix entirely — a call-site gap, not a change to the source spec.
 * It landed at payrollOperate, which let manager in by default; the scope
 * restructure raised it to payrollManage so it matches the /finance/payroll
 * page that hosts it. At manage, every legacy role resolves to the legacy
 * default (admin only), so it needs no intentionalChange.
 * GET production/taproom-consumption/phantom-alerts was hand-edited on
 * 2026-07-28, lowered from taproomPerformanceOperate to taproomPerformanceRead.
 * Brewer reaches the Export Bay tab that hosts this indicator (via
 * production.export: operate) but holds only taproom.performance: read, so the
 * operate gate 403'd every brewer — and the panel reported that failure as
 * "All reconciled". Reading the list is a read; resolve/dismiss stay at operate.
 * PATCH production/shipments/[id] was added on 2026-07-30 for the shipment
 * editor — a new call site with no legacy equivalent, at the same exportOperate
 * gate as every other export-mutating route.
 * PATCH and DELETE production/exports/[id] were REMOVED on 2026-07-30 along with
 * the route itself: both mutated the export ledger with no guards and no
 * compensating writes (DELETE dropped a row without restoring cold-storage
 * inventory; PATCH set volume_bbl without recomputing excise tax), and nothing
 * called either. The row count is therefore 212, not the 213 this file was
 * generated with.
 */
export const LEGACY_MATRIX: LegacyRow[] = [
  { route: "admin/cron-runs", method: "GET", legacy: [], capability: "cronRead" },
  { route: "admin/requests", method: "GET", legacy: [], capability: "usersManage" },
  { route: "admin/requests", method: "PATCH", legacy: [], capability: "usersManage" },
  { route: "admin/users/[id]", method: "PATCH", legacy: [], capability: "usersManage" },
  { route: "admin/users/[id]", method: "DELETE", legacy: [], capability: "usersManage" },
  { route: "admin/users", method: "GET", legacy: [], capability: "usersManage" },
  { route: "admin/users", method: "POST", legacy: [], capability: "usersManage" },
  { route: "brand/assets/[id]", method: "PATCH", legacy: [], capability: "brandAssetsManage" },
  { route: "brand/assets", method: "GET", legacy: [], capability: "brandAssetsRead" },
  { route: "brand/assets", method: "POST", legacy: [], capability: "brandAssetsManage" },
  { route: "brand/canon/draft", method: "GET", legacy: [], capability: "brandGuideManage" },
  { route: "brand/canon/draft", method: "PUT", legacy: [], capability: "brandGuideManage" },
  { route: "brand/canon/publish", method: "POST", legacy: [], capability: "brandGuideManage" },
  { route: "brand/canon/versions", method: "GET", legacy: [], capability: "brandGuideManage" },
  { route: "brand/chrome", method: "PUT", legacy: [], capability: "appearanceManage" },
  { route: "brand/labels/[id]", method: "GET", legacy: [], capability: "brandReleasesRead" },
  { route: "brand/labels/[id]", method: "PATCH", legacy: [], capability: "brandReleasesManage" },
  { route: "brand/labels", method: "GET", legacy: [], capability: "brandReleasesRead" },
  { route: "brand/labels", method: "POST", legacy: [], capability: "brandReleasesManage" },
  { route: "finance/account-mappings/bulk", method: "POST", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/account-mappings", method: "GET", legacy: ["viewer"], capability: "financeTransactionsRead", intentionalChange: { viewer: false, reason: "API-only; app/finance/layout.tsx already redirects every non-admin" } },
  { route: "finance/account-mappings", method: "PATCH", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/bank-ledger", method: "GET", legacy: ["viewer"], capability: "financeTransactionsRead", intentionalChange: { viewer: false, reason: "API-only; app/finance/layout.tsx already redirects every non-admin" } },
  { route: "finance/bank-ledger", method: "PATCH", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/catalog-with-categories", method: "GET", legacy: ["viewer"], capability: "financeTransactionsRead", intentionalChange: { viewer: false, reason: "API-only; app/finance/layout.tsx already redirects every non-admin" } },
  { route: "finance/chart-of-accounts", method: "GET", legacy: ["viewer"], capability: "financeTransactionsRead", intentionalChange: { viewer: false, reason: "API-only; app/finance/layout.tsx already redirects every non-admin" } },
  { route: "finance/chart-of-accounts", method: "POST", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/chart-of-accounts", method: "PATCH", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/chart-of-accounts", method: "DELETE", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/cogs", method: "GET", legacy: [], capability: "financeStatementsRead" },
  { route: "finance/expense-counterparty-mappings", method: "GET", legacy: ["viewer"], capability: "financeTransactionsRead", intentionalChange: { viewer: false, reason: "API-only; app/finance/layout.tsx already redirects every non-admin" } },
  { route: "finance/expense-counterparty-mappings", method: "PATCH", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/expense-mappings", method: "GET", legacy: ["viewer"], capability: "financeTransactionsRead", intentionalChange: { viewer: false, reason: "API-only; app/finance/layout.tsx already redirects every non-admin" } },
  { route: "finance/expense-mappings", method: "PATCH", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/expenses/[id]/exclude", method: "POST", legacy: ["manager"], capability: "financeTransactionsManage", intentionalChange: { manager: false, reason: "Decision 6. Dead code — every caller is under app/finance/transactions/expenses/*, behind the admin-only Finance layout" } },
  { route: "finance/expenses/[id]/exclude", method: "DELETE", legacy: ["manager"], capability: "financeTransactionsManage", intentionalChange: { manager: false, reason: "Decision 6. Dead code — every caller is under app/finance/transactions/expenses/*, behind the admin-only Finance layout" } },
  { route: "finance/expenses/[id]/payroll-match", method: "POST", legacy: ["manager"], capability: "financeTransactionsManage", intentionalChange: { manager: false, reason: "Decision 6. Dead code — every caller is under app/finance/transactions/expenses/*, behind the admin-only Finance layout" } },
  { route: "finance/expenses/[id]/splits", method: "PUT", legacy: ["manager"], capability: "financeTransactionsManage", intentionalChange: { manager: false, reason: "Decision 6. Dead code — every caller is under app/finance/transactions/expenses/*, behind the admin-only Finance layout" } },
  { route: "finance/expenses/[id]/splits", method: "DELETE", legacy: ["manager"], capability: "financeTransactionsManage", intentionalChange: { manager: false, reason: "Decision 6. Dead code — every caller is under app/finance/transactions/expenses/*, behind the admin-only Finance layout" } },
  { route: "finance/expenses/auto-map-payroll", method: "POST", legacy: ["manager"], capability: "financeTransactionsManage", intentionalChange: { manager: false, reason: "Decision 6. Dead code — every caller is under app/finance/transactions/expenses/*, behind the admin-only Finance layout" } },
  { route: "finance/expenses/auto-map", method: "POST", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/expenses", method: "GET", legacy: ["viewer"], capability: "financeTransactionsRead", intentionalChange: { viewer: false, reason: "API-only; app/finance/layout.tsx already redirects every non-admin" } },
  { route: "finance/expenses", method: "PATCH", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/expenses/sync", method: "POST", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/financials", method: "GET", legacy: [], capability: "financeStatementsRead" },
  { route: "finance/import/parse-pdf", method: "POST", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/ledger/invoice-batch-links/[id]", method: "DELETE", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/ledger/invoice-batch-links", method: "POST", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/ledger/invoice-batch-links", method: "GET", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/ledger/invoice-line-items", method: "PATCH", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/ledger/invoices/auto-map", method: "POST", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/ledger/invoices", method: "GET", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/ledger/invoices", method: "PATCH", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/ledger/invoices", method: "POST", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/ledger/sync-square", method: "POST", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/payroll-periods/[periodId]/recompute-splits", method: "POST", legacy: ["manager"], capability: "payrollOperate" },
  { route: "finance/pl", method: "GET", legacy: [], capability: "financeStatementsRead" },
  { route: "finance/ramp/statements", method: "GET", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/ramp/transactions", method: "GET", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/settings/payroll-department-mappings", method: "GET", legacy: ["manager"], capability: "payrollRead" },
  { route: "finance/settings/payroll-department-mappings", method: "PUT", legacy: ["manager"], capability: "payrollOperate" },
  { route: "finance/sync-catalog", method: "POST", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/taxes", method: "GET", legacy: [], capability: "financeStatementsRead" },
  { route: "finance/transactions/auto-map", method: "POST", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/transactions/line-items", method: "PATCH", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/transactions", method: "GET", legacy: ["viewer"], capability: "financeTransactionsRead", intentionalChange: { viewer: false, reason: "API-only; app/finance/layout.tsx already redirects every non-admin" } },
  { route: "finance/transactions", method: "PATCH", legacy: [], capability: "financeTransactionsManage" },
  { route: "finance/transactions/sync", method: "POST", legacy: [], capability: "financeTransactionsManage" },
  { route: "manual-entries", method: "POST", legacy: [], capability: "targetsEdit" },
  { route: "manual-entries", method: "DELETE", legacy: [], capability: "targetsEdit" },
  { route: "partners/contract-brewing/[id]", method: "PATCH", legacy: [], capability: "partnersManage" },
  { route: "partners/contract-brewing/[id]", method: "DELETE", legacy: [], capability: "partnersManage" },
  { route: "partners/contract-brewing", method: "POST", legacy: [], capability: "partnersManage" },
  { route: "partners/contract-brewing/square-import", method: "POST", legacy: [], capability: "partnersManage" },
  { route: "partners/suppliers/[id]", method: "PATCH", legacy: [], capability: "partnersManage" },
  { route: "partners/suppliers/[id]", method: "DELETE", legacy: [], capability: "partnersManage" },
  { route: "partners/suppliers", method: "POST", legacy: [], capability: "partnersManage" },
  { route: "payroll/config", method: "GET", legacy: [], capability: "payrollManage" },
  { route: "payroll/config", method: "PATCH", legacy: [], capability: "payrollManage" },
  { route: "payroll/employees/[id]", method: "PATCH", legacy: [], capability: "payrollManage" },
  { route: "payroll/employees", method: "GET", legacy: [], capability: "payrollManage" },
  { route: "payroll/employees", method: "POST", legacy: [], capability: "payrollManage" },
  { route: "payroll/employees/sync-square", method: "POST", legacy: [], capability: "payrollManage" },
  { route: "payroll/gl-reports/backfill", method: "POST", legacy: [], capability: "payrollManage" },
  { route: "payroll/periods/[id]/entries/[employeeId]", method: "PATCH", legacy: [], capability: "payrollManage" },
  { route: "payroll/periods/[id]/gusto-report", method: "POST", legacy: ["manager"], capability: "payrollOperate" },
  { route: "payroll/periods/[id]/gusto-report", method: "GET", legacy: ["manager"], capability: "payrollRead" },
  { route: "payroll/periods/[id]/lock", method: "POST", legacy: [], capability: "payrollManage" },
  { route: "payroll/periods/[id]/preview", method: "GET", legacy: ["manager"], capability: "payrollRead" },
  { route: "payroll/periods/[id]", method: "GET", legacy: ["manager"], capability: "payrollRead" },
  { route: "payroll/periods/[id]/shift-overrides/[employeeId]", method: "PUT", legacy: [], capability: "payrollDayOverride", intentionalChange: { manager: true, reason: "New route (day-level payroll overrides on the Shifts tab) — no legacy role had it. manager: ROLE_BUNDLES already grants payroll: \"operate\" (same level as payrollDayOverride), so managers gain access by default; reviewed and intended for the Shifts override feature" } },
  { route: "payroll/periods/[id]/shifts", method: "GET", legacy: [], capability: "payrollRead", intentionalChange: { manager: true, reason: "Gate lowered from payrollManage (admin-only) to payrollRead: app/taproom/payroll/layout.tsx gates the page at payrollRead, so managers could see the Shifts tab but got a 403 fetching it" } },
  { route: "payroll/periods", method: "GET", legacy: ["manager"], capability: "payrollRead" },
  { route: "payroll/periods", method: "POST", legacy: [], capability: "payrollManage" },
  { route: "production/allocations/[id]/adjust", method: "POST", legacy: ["brewer"], capability: "exportOperate" },
  { route: "production/allocations/[id]/invoice", method: "GET", legacy: ["brewer"], capability: "exportOperate" },
  { route: "production/allocations/[id]/invoice", method: "POST", legacy: ["brewer"], capability: "exportOperate" },
  { route: "production/allocations/[id]", method: "PATCH", legacy: ["brewer"], capability: "exportOperate" },
  { route: "production/allocations/[id]", method: "DELETE", legacy: ["brewer"], capability: "exportOperate" },
  { route: "production/allocations/[id]/write-off", method: "POST", legacy: ["brewer"], capability: "exportOperate" },
  { route: "production/allocations/[id]/write-off", method: "DELETE", legacy: ["brewer"], capability: "exportOperate" },
  { route: "production/allocations", method: "GET", legacy: ["viewer", "brewer", "manager"], capability: "exportRead", intentionalChange: { viewer: false, reason: "API-only; app/production/layout.tsx already redirects viewers" } },
  { route: "production/allocations", method: "POST", legacy: ["brewer"], capability: "exportOperate" },
  { route: "production/batch-conversions", method: "GET", legacy: ["viewer"], capability: "brewingRead", intentionalChange: { viewer: false, brewer: true, reason: "Two changes on one route. viewer: API-only; app/production/layout.tsx already redirects viewers. brewer: batch-conversions: brewer could POST but not GET — an artifact of [\"viewer\"] not meaning \"viewer and above\"" } },
  { route: "production/batch-conversions", method: "POST", legacy: ["brewer"], capability: "brewingOperate" },
  { route: "production/batch-schedule/[id]", method: "PATCH", legacy: ["brewer"], capability: "brewingOperate" },
  { route: "production/batch-schedule/[id]", method: "DELETE", legacy: ["brewer"], capability: "brewingOperate" },
  { route: "production/batch-schedule", method: "POST", legacy: ["brewer"], capability: "brewingOperate" },
  { route: "production/batch-scheduler/suggest", method: "POST", legacy: ["brewer"], capability: "brewingOperate" },
  { route: "production/batches/[id]", method: "PATCH", legacy: ["brewer"], capability: "brewingOperate" },
  { route: "production/batches/[id]", method: "DELETE", legacy: [], capability: "batchDelete" },
  { route: "production/batches", method: "POST", legacy: ["brewer"], capability: "brewingOperate" },
  { route: "production/brew-activities", method: "POST", legacy: ["brewer"], capability: "brewingOperate" },
  { route: "production/brew-activities", method: "PATCH", legacy: ["brewer"], capability: "brewingOperate" },
  { route: "production/brew-activities", method: "DELETE", legacy: ["brewer"], capability: "brewingOperate" },
  { route: "production/contract-requests", method: "GET", legacy: ["viewer", "brewer", "manager"], capability: "partnersRead", intentionalChange: { viewer: false, reason: "API-only; app/production/layout.tsx already redirects viewers" } },
  { route: "production/contract-requests", method: "POST", legacy: ["brewer"], capability: "partnersOperate" },
  { route: "production/contract-requests", method: "PATCH", legacy: ["brewer"], capability: "partnersOperate" },
  { route: "production/contract-requests", method: "DELETE", legacy: ["brewer"], capability: "partnersOperate" },
  { route: "production/deposit-invoices/backfill", method: "POST", legacy: [], capability: "exportManage" },
  { route: "production/deposit-invoices", method: "GET", legacy: ["viewer", "brewer", "manager"], capability: "exportRead", intentionalChange: { viewer: false, reason: "API-only; app/production/layout.tsx already redirects viewers" } },
  { route: "production/deposit-settings/invoice-due-days", method: "PUT", legacy: ["brewer"], capability: "productionSettingsManage" },
  { route: "production/equipment/[id]", method: "PATCH", legacy: [], capability: "equipmentManage" },
  { route: "production/equipment/[id]", method: "DELETE", legacy: [], capability: "equipmentManage" },
  { route: "production/equipment", method: "POST", legacy: [], capability: "equipmentManage" },
  { route: "production/export-bay/active-allocation-check", method: "GET", legacy: ["brewer"], capability: "exportOperate" },
  { route: "production/export-bay/ship-adhoc", method: "POST", legacy: ["brewer"], capability: "exportOperate" },
  { route: "production/export-bay/ship/preview", method: "POST", legacy: ["brewer"], capability: "exportOperate" },
  { route: "production/export-bay/ship", method: "POST", legacy: ["brewer"], capability: "exportOperate" },
  { route: "production/export-settings/excise-tax-rates", method: "GET", legacy: ["viewer", "brewer", "manager"], capability: "taxFilingRead", intentionalChange: { viewer: false, manager: false, reason: "API-only; app/production/layout.tsx already redirects viewers. Excise rates re-keyed to finance.tax.filing (tax reference data): brewer keeps read via a leaf grant, manager does not - Q-W4" } },
  { route: "production/export-settings/invoice-due-days", method: "PUT", legacy: ["brewer"], capability: "productionSettingsManage" },
  { route: "production/export-settings/packaging-fee-class", method: "POST", legacy: ["manager"], capability: "productionSettingsOperate", intentionalChange: { brewer: true, reason: "packaging-fee-class: brewer manages every other export setting; this one was arbitrarily manager-only. Reviewed and accepted" } },
  { route: "production/export-settings/service-mappings", method: "GET", legacy: ["viewer", "brewer", "manager"], capability: "productionSettingsRead", intentionalChange: { viewer: false, reason: "API-only; app/production/layout.tsx already redirects viewers" } },
  { route: "production/export-settings/service-mappings", method: "PUT", legacy: ["brewer"], capability: "productionSettingsManage" },
  { route: "production/export-settings/square-catalog", method: "GET", legacy: ["viewer", "brewer", "manager"], capability: "productionSettingsRead", intentionalChange: { viewer: false, reason: "API-only; app/production/layout.tsx already redirects viewers" } },
  { route: "production/export/invoice-preview", method: "GET", legacy: ["brewer"], capability: "exportOperate" },
  { route: "production/export/invoice", method: "POST", legacy: ["brewer"], capability: "exportOperate" },
  { route: "production/export/invoices/[id]/line-items", method: "PATCH", legacy: ["brewer"], capability: "exportOperate" },
  { route: "production/export/invoices", method: "GET", legacy: ["viewer", "brewer", "manager"], capability: "exportRead", intentionalChange: { viewer: false, reason: "API-only; app/production/layout.tsx already redirects viewers" } },
  { route: "production/floorplan-settings", method: "PUT", legacy: [], capability: "equipmentManage" },
  { route: "production/shipments/[id]", method: "PATCH", legacy: ["brewer"], capability: "exportOperate" },
  { route: "production/ingredients/[id]", method: "PATCH", legacy: ["brewer"], capability: "ingredientMasterEdit", intentionalChange: { brewer: false, reason: "ingredients/packaging PATCH and DELETE — decision 5" } },
  { route: "production/ingredients/[id]", method: "DELETE", legacy: ["brewer"], capability: "ingredientMasterEdit", intentionalChange: { brewer: false, reason: "ingredients/packaging PATCH and DELETE — decision 5" } },
  { route: "production/ingredients/bulk", method: "POST", legacy: ["brewer"], capability: "inventoryOperate" },
  { route: "production/ingredients", method: "POST", legacy: ["brewer"], capability: "inventoryOperate" },
  { route: "production/packaging-adjustments/bulk", method: "POST", legacy: ["brewer"], capability: "inventoryOperate" },
  { route: "production/packaging-adjustments", method: "POST", legacy: ["brewer"], capability: "inventoryOperate" },
  { route: "production/packaging-variations/[id]", method: "PATCH", legacy: ["brewer"], capability: "recipesOperate" },
  { route: "production/packaging-variations/[id]", method: "DELETE", legacy: ["brewer"], capability: "recipesOperate" },
  { route: "production/packaging-variations/bulk", method: "POST", legacy: ["brewer"], capability: "recipesOperate" },
  { route: "production/packaging-variations", method: "POST", legacy: ["brewer"], capability: "recipesOperate" },
  { route: "production/packaging/[id]", method: "PATCH", legacy: ["brewer"], capability: "packagingMasterEdit", intentionalChange: { brewer: false, reason: "ingredients/packaging PATCH and DELETE — decision 5" } },
  { route: "production/packaging/[id]", method: "DELETE", legacy: ["brewer"], capability: "packagingMasterEdit", intentionalChange: { brewer: false, reason: "ingredients/packaging PATCH and DELETE — decision 5" } },
  { route: "production/packaging", method: "POST", legacy: ["brewer"], capability: "inventoryOperate" },
  { route: "production/recipe-packaging-variations", method: "POST", legacy: ["brewer"], capability: "recipesOperate" },
  { route: "production/recipe-packaging-variations", method: "DELETE", legacy: ["brewer"], capability: "recipesOperate" },
  { route: "production/recipe-square-link-ignores", method: "POST", legacy: ["brewer", "manager"], capability: "catalogOperate", intentionalChange: { manager: false, reason: "Square Item Mappings re-keyed from production.settings to the shared `catalog` scope; manager holds no catalog grant. Restoring it is a grant edit - Q-W2" } },
  { route: "production/recipe-square-link-ignores", method: "DELETE", legacy: ["brewer", "manager"], capability: "catalogOperate", intentionalChange: { manager: false, reason: "Square Item Mappings re-keyed from production.settings to the shared `catalog` scope; manager holds no catalog grant. Restoring it is a grant edit - Q-W2" } },
  { route: "production/recipe-square-links", method: "POST", legacy: ["brewer", "manager"], capability: "catalogOperate", intentionalChange: { manager: false, reason: "Square Item Mappings re-keyed from production.settings to the shared `catalog` scope; manager holds no catalog grant. Restoring it is a grant edit - Q-W2" } },
  { route: "production/recipe-square-links", method: "DELETE", legacy: ["brewer", "manager"], capability: "catalogOperate", intentionalChange: { manager: false, reason: "Square Item Mappings re-keyed from production.settings to the shared `catalog` scope; manager holds no catalog grant. Restoring it is a grant edit - Q-W2" } },
  { route: "production/recipes/[id]", method: "PATCH", legacy: ["brewer"], capability: "recipesOperate" },
  { route: "production/recipes/[id]", method: "DELETE", legacy: ["brewer"], capability: "recipesOperate" },
  { route: "production/recipes", method: "POST", legacy: ["brewer"], capability: "recipesOperate" },
  { route: "production/safety-stock", method: "POST", legacy: [], capability: "safetyStockManage" },
  { route: "production/safety-stock", method: "DELETE", legacy: [], capability: "safetyStockManage" },
  { route: "production/stock-adjustments/bulk", method: "POST", legacy: ["brewer"], capability: "inventoryOperate" },
  { route: "production/stock-adjustments", method: "POST", legacy: ["brewer"], capability: "inventoryOperate" },
  { route: "production/tank-assignments/[id]", method: "PATCH", legacy: ["brewer"], capability: "brewingOperate" },
  { route: "production/tank-assignments", method: "POST", legacy: ["brewer"], capability: "brewingOperate" },
  { route: "production/tank-assignments", method: "PATCH", legacy: [], capability: "tankReassign" },
  { route: "production/taproom-consumption/dismiss-phantom", method: "POST", legacy: ["manager"], capability: "taproomPerformanceOperate" },
  { route: "production/taproom-consumption/phantom-alerts", method: "GET", legacy: ["manager"], capability: "taproomPerformanceRead", intentionalChange: { brewer: true, viewer: true, reason: "Read-only reconciliation indicator on a tab brewer already reaches via production.export:operate; at operate every brewer was 403'd and the panel rendered the failure as 'All reconciled'" } },
  { route: "production/taproom-consumption/reconcile-phantom", method: "POST", legacy: ["manager"], capability: "taproomPerformanceOperate" },
  { route: "production/taproom-consumption/sync", method: "POST", legacy: ["brewer"], capability: "brewingOperate" },
  { route: "production/transfers", method: "POST", legacy: ["brewer"], capability: "brewingOperate" },
  { route: "settings/timezone", method: "PUT", legacy: [], capability: "businessSettingsManage" },
  { route: "taproom/events/[id]", method: "PUT", legacy: ["manager"], capability: "taproomPerformanceOperate" },
  { route: "taproom/events/[id]", method: "DELETE", legacy: ["manager"], capability: "taproomPerformanceOperate" },
  { route: "taproom/events", method: "POST", legacy: ["manager"], capability: "taproomPerformanceOperate" },
  { route: "taproom/tap-swaps", method: "POST", legacy: ["manager"], capability: "taproomPerformanceOperate" },
  { route: "taproom/tap-swaps", method: "DELETE", legacy: ["manager"], capability: "taproomPerformanceOperate" },
  { route: "targets", method: "POST", legacy: [], capability: "targetsEdit" },
  { route: "tax/authorities", method: "GET", legacy: ["manager"], capability: "taxRead", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/bank-account/reveal", method: "GET", legacy: [], capability: "taxPiiReveal" },
  { route: "tax/bank-account", method: "GET", legacy: ["manager"], capability: "taxRead", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/bank-account", method: "PUT", legacy: [], capability: "taxManage" },
  { route: "tax/entity-profile", method: "GET", legacy: ["manager"], capability: "taxRead", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/entity-profile", method: "PUT", legacy: [], capability: "taxManage" },
  { route: "tax/legal-representative/reveal", method: "GET", legacy: [], capability: "taxPiiReveal" },
  { route: "tax/legal-representative", method: "GET", legacy: ["manager"], capability: "taxRead", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/legal-representative", method: "PUT", legacy: [], capability: "taxManage" },
  { route: "tax/parties", method: "GET", legacy: ["manager"], capability: "taxRead", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/profiles/[party]/reveal", method: "GET", legacy: [], capability: "taxPiiReveal" },
  { route: "tax/profiles/[party]", method: "GET", legacy: ["manager"], capability: "taxRead", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/profiles/[party]", method: "PUT", legacy: [], capability: "taxManage" },
  { route: "tax/rates", method: "GET", legacy: ["manager"], capability: "taxRead", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/registrations", method: "GET", legacy: ["manager"], capability: "taxRead", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/registrations", method: "PUT", legacy: [], capability: "taxManage" },
  { route: "tax/schedules/[id]", method: "PATCH", legacy: [], capability: "taxManage" },
  { route: "tax/schedules/[id]", method: "DELETE", legacy: [], capability: "taxManage" },
  { route: "tax/schedules", method: "GET", legacy: ["manager"], capability: "taxRead", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/schedules", method: "POST", legacy: [], capability: "taxManage" },
  { route: "tax/square-taxes", method: "GET", legacy: ["manager"], capability: "taxRead", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/tasks/[id]/complete", method: "POST", legacy: ["manager"], capability: "taxOperate", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/tasks/[id]/files/[fileId]", method: "GET", legacy: ["manager"], capability: "taxRead", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/tasks/[id]/files/[fileId]", method: "DELETE", legacy: ["manager"], capability: "taxOperate", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/tasks/[id]/files", method: "POST", legacy: ["manager"], capability: "taxOperate", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/tasks/[id]/files", method: "GET", legacy: ["manager"], capability: "taxRead", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/tasks/[id]/recompute", method: "POST", legacy: ["manager"], capability: "taxOperate", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/tasks/[id]", method: "GET", legacy: ["manager"], capability: "taxRead", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/tasks/[id]", method: "PATCH", legacy: ["manager"], capability: "taxOperate", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
  { route: "tax/tasks", method: "GET", legacy: ["manager"], capability: "taxRead", intentionalChange: { manager: false, reason: "manager's tax grant is removed: every tax screen lives under /finance, which manager cannot enter, so the grant satisfied APIs no manager-reachable UI ever called. Removed rather than made real - see the 2026-07-28 scope structure spec, Q-W1" } },
];
