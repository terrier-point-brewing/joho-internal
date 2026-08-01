# Route Manifest — UI Consistency Pass (Phase 1a)

Coverage contract for the Phase 4 migration. Every UI-bearing page below must be
visited and accounted for in the final report. Generated from a full crawl of `app/`
(no `pages/` dir exists). Co-located client components that own the actual UI are
listed under the page that renders them.

Legend: **C** = client component (`"use client"`), **S** = server component.
"redirect" / "guard" pages render no markup and are **out of scope** for styling
(listed for completeness). "content" pages are **in scope**.

---

## Root / chrome

| Path | Kind | Scope | Description |
|---|---|---|---|
| `app/layout.tsx` | S | chrome | Root layout: Geist fonts, NavBar (Suspense), scroll container. |
| `app/providers.tsx` | C | n/a | React Query provider. No UI. |
| `app/page.tsx` | S | redirect | → `/taproom/performance`. |
| `app/components/NavBar.tsx` | C | **content** | App nav: desktop sidebar + mobile top/bottom bars. |
| `app/components/SubNav.tsx` | C | **content** | Shared underline-tab nav (link-driven). |
| `app/components/TabBar.tsx` | C | **content** | Shared underline-tab nav (button-driven). |
| `app/components/PageHeader.tsx` | S | **content** | Shared page title + description. |
| `app/components/FormattedInput.tsx` | C | **content** | `react-number-format` wrapper. |
| `app/components/SquareCatalogSelect.tsx` | C | **content** | Catalog/discount `<select>`s (hand-rolled, not `.inp`). |

## Auth

| Path | Kind | Scope | Description |
|---|---|---|---|
| `app/login/page.tsx` | C | **content** | Login + request-access forms. |
| `app/auth/set-password/page.tsx` | C | **content** | Invite / set-password flow. |

## Settings (`app/settings/**`)

| Path | Kind | Scope | Description |
|---|---|---|---|
Seven groups, one per scope family, listed in `app/settings/nav-config.ts`. The
group row renders in the app sidebar (desktop) and as a `md:hidden` SubNav
inside `SettingsGroupShell` (mobile); each group then has ONE level of sub-tabs.
Every group layout is `requirePage(cap)` + `<SettingsGroupShell nav={…}>`.

| Path | Kind | Scope | Description |
|---|---|---|---|
| `app/settings/layout.tsx` | S | guard | Session gate + full-height shell. |
| `app/settings/SettingsGroupShell.tsx` | S | **content** | Shared group chrome: mobile group row + sub-tabs + padded content slot. |
| `app/settings/page.tsx` | S | redirect | → `/settings/user/account`. |
| `app/settings/user/layout.tsx` | S | shell | No gate — scope-less personal settings. |
| `app/settings/user/account/AccountSettings.tsx` | C | **content** | Change-password form. |
| `app/settings/user/appearance/AppearanceSettings.tsx` | C | **content** | Theme + brand-skin toggle. |
| `app/settings/environment/layout.tsx` | S | shell | No group gate; the four `org.*` subtabs gate individually. |
| `app/settings/environment/business/BusinessSettings.tsx` | C | **content** | Location-wide business settings. |
| `app/settings/environment/users/UserManagement.tsx` | C | **content** | User table + create/set-password modals. |
| `app/settings/environment/requests/AccessRequests.tsx` | C | **content** | Access-request review table. |
| `app/settings/environment/cron/CronMonitor.tsx` | C | **content** | Cron job run log. |
| `app/settings/finance/**` | S | `finance.transactions:manage` | Chart of Accounts, GL Mapping (Revenue/Expenses/Counterparties/Sales Tax), Balance Sheet Accounts, the three connection screens, Backfill. |
| `app/settings/payroll/**` | S | `payroll:manage` | Payroll config, Departments. |
| `app/settings/tax/**` | S | per-subtab | Tax Profile (`finance.tax`), Tax Filing (`finance.tax.filing`). |
| `app/settings/production/**` | S | `production.settings:manage` | Deposit Settings, Export Settings. |
| `app/settings/catalog/**` | S | `catalog:read` | Square Item Mappings. Single page — no sub-tab row. |

## Finance (`app/finance/**`) — admin-gated

| Path | Kind | Scope | Description |
|---|---|---|---|
| `app/finance/layout.tsx` | S | guard | Admin gate, passthrough. |
| `app/finance/page.tsx` | S | redirect | → `/finance/model`. |
| `app/finance/model/page.tsx` | C | **content** | Consolidated sales model (SalesTable). |
| `app/finance/invoices/page.tsx` | C | **content** | Invoices table; **only page using shared PageHeader**. |
| `app/finance/import/page.tsx` | S | redirect | → settings/chart-of-accounts. |
| `app/finance/chart-of-accounts/page.tsx` | S | redirect | → settings/chart-of-accounts. |
| `app/finance/sales/taproom/page.tsx` | C | **content** | Taproom sales SalesTable. |
| `app/finance/sales/contract-brewing/page.tsx` | C | **content** | Contract-brewing sales SalesTable. |
| `app/finance/sales/distribution/page.tsx` | C | **content** | Distribution sales SalesTable. |
| `app/finance/sales/events/page.tsx` | C | **content** | Events sales SalesTable. |
| `app/finance/statements/page.tsx` | S | redirect | → statements/pl. |
| `app/finance/statements/pl/page.tsx` | C | **content** | P&L MoM table. |
| `app/finance/statements/balance-sheet/page.tsx` | C | **content** | Balance sheet (div-grid). |
| `app/finance/statements/cash-flow/page.tsx` | C | **content** | Cash-flow MoM (near-dup of P&L). |
| `app/finance/transactions/page.tsx` | S | redirect | → transactions/square-transactions. |
| `app/finance/transactions/square-transactions/page.tsx` | C | **content** | POS transactions list. |
| `app/finance/payroll/page.tsx` | C | **content** | Pay-period list (`<main>` family). |
| `app/finance/payroll/[periodId]/page.tsx` | C | **content** | Wraps PayrollPeriodView. |
| `app/finance/payroll/settings/page.tsx` | S | redirect | → settings/payroll. |
| `app/finance/settings/page.tsx` | S | redirect | → settings/chart-of-accounts. |
| `app/finance/settings/chart-of-accounts/page.tsx` | C | **content** | CoA editor. |
| `app/finance/settings/account-mapping/page.tsx` | C | **content** | Square→GL mapping tree. |
| `app/finance/settings/excise-tax/page.tsx` | C | **content** | Wraps ExportSettingsPanel. |
| `app/finance/settings/payroll/page.tsx` | C | **content** | Payroll config. |
| `app/finance/FinanceNav.tsx` | C | **content** | Uses shared SubNav (canonical). |
| `app/finance/transactions/TransactionsNav.tsx` | C | **content** | Uses shared SubNav (canonical). |
| `app/finance/sales/SalesNav.tsx` | C | **content** | Hand-rolled tabs (dup of SubNav). |
| `app/finance/statements/StatementsNav.tsx` | C | **content** | Hand-rolled tabs (dup of SubNav). |
| `app/finance/settings/SettingsNav.tsx` | C | **content** | Hand-rolled tabs (dup of SubNav). |
| `app/finance/payroll/PayrollNav.tsx` | C | **content** | Hand-rolled pill nav. |
| `app/finance/sales/SalesTable.tsx` | C | **content** | Shared month-grid table (model + 4 sales pages). |

## Production (`app/production/**`) — brewer+ gated

| Path | Kind | Scope | Description |
|---|---|---|---|
| `app/production/layout.tsx` | S | guard | Auth gate. |
| `app/production/page.tsx` | S | redirect | → intake. |
| `app/production/intake/page.tsx` | C | **content** | Shell + IntakeTab. |
| `app/production/export/page.tsx` | C | **content** | Shell + ExportTab. |
| `app/production/inventory/page.tsx` | C | **content** | Shell + InventoryTab. |
| `app/production/partners/page.tsx` | C | **content** | Shell + PartnersTab. |
| `app/production/recipes/page.tsx` | C | **content** | Shell + RecipesTab. |
| `app/production/recipes/variations/page.tsx` | C | **content** | Shell + PackagingVariationsPanel. |
| `app/production/recipes/brew-step-templates/page.tsx` | C | **content** | Shell + BrewStepTemplatesTab. |
| `app/production/brewing/page.tsx` | S | redirect | → brewing/floorplan. |
| `app/production/brewing/floorplan/page.tsx` | C | **content** | Shell + BrewStatusTab (canvas-exempt internals). |
| `app/production/brewing/batch-log/page.tsx` | C | **content** | Shell + BatchLogTab. |
| `app/production/brewing/timeline/page.tsx` | C | **content** | Shell + GanttTab (canvas-exempt internals). |
| `app/production/brewing/transfers/page.tsx` | C | **content** | Shell + **inline** transfer table (structural outlier). |
| `app/production/brewing/calendar/page.tsx` | C | **content** | Admin-gated; Shell + CalendarTab (not in BREWING_NAV). |
| `app/production/settings/page.tsx` | S | redirect | → settings/deposits. |
| `app/production/settings/deposits/page.tsx` | C | **content** | Shell + DepositSettingsPanel. |
| `app/production/settings/export/page.tsx` | C | **content** | Shell + ExportSettingsPanel. |
| `app/production/settings/square-links/page.tsx` | C | **content** | Shell + MappingGrid + MappingDrawer. |

**Production co-located components (39 tsx, all in scope unless noted):**
`components/shared.tsx` (Modal/ModalActions/StatusBadge), `IntakeTab`, `ExportTab`,
`InventoryTab`, `PartnersTab`, `RecipesTab`, `BatchLogTab`, `BrewStatusTab`,
`BatchStatusTab`, `IngredientsTab`, `ExportBayTab`, `ExportInvoicesTab`, `ShipmentsTab`,
`ExportSettingsPanel`, `DepositSettingsPanel`, `PackagingVariationsPanel`,
`BrewStepTemplatesTab`, `MappingGrid`, `MappingDrawer`, modals (`DepositInvoiceModal`,
`InvoicePreviewModal`, `RefundAdjustmentModal`, `TransferModal`), `intake/*`
(`CommitmentsTab`, `BatchSchedulerTab`, …).
**Canvas-exempt** (flagged, not migrated): `GanttTab`, `CalendarTab`, `BrewStatusTab`
floorplan canvas, all of `EquipmentSchedule/**`, `FloorplanTile/**`.

## Taproom (`app/taproom/**`) — viewer+ / manager-gated payroll

| Path | Kind | Scope | Description |
|---|---|---|---|
| `app/taproom/page.tsx` | S | redirect | → performance. |
| `app/taproom/performance/page.tsx` | S | redirect | → performance/sales-pulse. |
| `app/taproom/performance/sales-pulse/page.tsx` | C | **content** | Shell + SalesPulseTab. |
| `app/taproom/performance/draft-stats/page.tsx` | C | **content** | Shell + DraftStatsTab. |
| `app/taproom/performance/events/page.tsx` | C | **content** | Shell + EventsTab (already uses `.btn-*`/`.inp`). |
| `app/taproom/targets/page.tsx` | S | redirect | → targets/achievement. |
| `app/taproom/targets/achievement/page.tsx` | C | **content** | Shell + AchievementTab. |
| `app/taproom/targets/target-setting/page.tsx` | C | **content** | Shell + TargetSettingTab. |
| `app/taproom/targets/manual-entries/page.tsx` | C | **content** | Shell + ManualEntriesTab. |
| `app/taproom/reports/page.tsx` | C | **content** | Admin; select-driven report switcher (paradigm outlier). |
| `app/taproom/payroll/layout.tsx` | S | guard | Manager/admin gate. |
| `app/taproom/payroll/page.tsx` | S | redirect+ | Redirect to period; bare `<main>` fallback (minor content). |
| `app/taproom/payroll/[periodId]/page.tsx` | C | **content** | Payroll detail; hand-rolled `<h1>`. |
| `app/reports/page.tsx` | S | redirect | → `/taproom/reports`. |

**Taproom/reports co-located components (in scope):** `taproom/components/*`
(`SalesPulseTab`, `DraftStatsTab`, `EventsTab`, `AchievementTab`, `TargetSettingTab`,
`ManualEntriesTab`); `reports/components/*` (`ReportControls`, `SortControls`,
`TaproomModelReport`, `CocktailSalesReport`, `KegSalesReport`, `GiftCardReport`,
`ContractBrewingReport`, `DistributionReport`, `BBLTrackerReport`).
**Chart-exempt** (Recharts internals only): series/axis hexes inside SalesPulseTab,
DraftStatsTab, AchievementTab.

## Shared payroll components (`app/components/payroll/**`) — in scope

`GustoSummaryPanel`, `PayrollEntryRow`, `PayrollPeriodView` (hand-rolled tabs — dup of
TabBar), `PeriodSelector`, `SalariedConfirmationList`, `ShiftTimeline`.

## API routes (`app/api/**`) — OUT OF SCOPE (no UI)

~150 route handlers under `app/api/**` (admin, auth, finance, payroll, production,
taproom, square, targets, cron, …). These are server route handlers with no
presentation layer and are explicitly excluded from the styling pass. Listed here as a
category for coverage completeness; none will be visited in Phase 4.

---

## Coverage summary

- **In-scope content surfaces:** ~41 content pages + ~70 co-located UI components.
- **Out of scope:** ~20 redirect/guard pages, ~150 API routes, plus canvas/chart-exempt
  internals (EquipmentSchedule, Gantt/Calendar, floorplan canvas, Recharts props).
