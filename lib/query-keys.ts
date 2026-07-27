/**
 * Central query-key registry for React Query.
 *
 * Every key is a function — even no-argument ones — so static and
 * parameterized keys have a uniform call shape:
 *
 *   queryKey: queryKeys.production.batches()
 *   queryKey: queryKeys.production.allocationsByBatch(id)
 *
 * Passing the domain root (e.g. queryKeys.production.all()) to
 * invalidateQueries will invalidate every query under that domain.
 */
/**
 * staleTime for queries backed by live Square calls (orders/refunds/invoices).
 * The underlying routes are cached server-side (~90s via unstable_cache), so a
 * longer client staleTime keeps tab-to-tab navigation from issuing redundant
 * round-trips for data that barely changes. Mutations still invalidate
 * explicitly, so writes surface immediately regardless of this value.
 */
export const SALES_REPORT_STALE_TIME = 5 * 60_000;

export const queryKeys = {
  // ─── Auth ────────────────────────────────────────────────────────────────
  auth: {
    all: () => ["auth"] as const,
    me:  () => ["auth", "me"] as const,
  },

  // ─── Production ──────────────────────────────────────────────────────────
  production: {
    all:                  () => ["production"] as const,
    ingredients:          () => ["production", "ingredients"] as const,
    stockAdjustments:     () => ["production", "stock-adjustments"] as const,
    packagingAdjustments: () => ["production", "packaging-adjustments"] as const,
    recipes:              () => ["production", "recipes"] as const,
    batches:              () => ["production", "batches"] as const,
    equipment:            () => ["production", "equipment"] as const,
    tankAssignments:      () => ["production", "tank-assignments"] as const,
    packaging:            () => ["production", "packaging"] as const,
    transfers:            () => ["production", "transfers"] as const,
    batchSchedule:        () => ["production", "batch-schedule"] as const,
    scheduleConflicts:    () => ["production", "schedule-conflicts"] as const,
    exports:              () => ["production", "exports"] as const,
    /** All allocations — use for broad invalidation after a write. */
    allocations:          () => ["production", "allocations"] as const,
    /** Allocations scoped to a single batch — narrower cache entry. */
    allocationsByBatch:   (batchId: string) => ["production", "allocations", batchId] as const,
    exportBayInventory:   () => ["production", "export-bay-inventory"] as const,
    coldStorage:          () => ["production", "cold-storage"] as const,
    commitments:          () => ["production", "commitments"] as const,
    squareCatalog:        () => ["production", "square-catalog"] as const,
    recipeSquareLinks:    () => ["production", "recipe-square-links"] as const,
    packagingVariations:  () => ["production", "packaging-variations"] as const,
    recipePackagingVariations: () => ["production", "recipe-packaging-variations"] as const,
    demandCalendar:       () => ["production", "demand-calendar"] as const,
    contractRequests:     () => ["production", "contract-requests"] as const,
    contractRequestsByType: (type: string) => ["production", "contract-requests", type] as const,
    safetyStock:          () => ["production", "safety-stock"] as const,
    taproomInventory:     () => ["production", "taproom-inventory"] as const,
    batchScheduler:       () => ["production", "batch-scheduler"] as const,
    brewStepTemplates:    () => ["production", "brew-step-templates"] as const,
    taproomRecipeSettings: () => ["production", "taproom-recipe-settings"] as const,
    ingredientShortfalls:  (batchId: string) => ["production", "ingredient-shortfalls", batchId] as const,
    batchConversions:      () => ["production", "batch-conversions"] as const,
    exciseTaxRates:        (party?: string) => (party ? ["production", "excise-tax-rates", party] as const : ["production", "excise-tax-rates"] as const),
    exportServiceMappings: () => ["production", "export-service-mappings"] as const,
    exportSquareCatalog:   () => ["production", "export-square-catalog"] as const,
    exportInvoiceDueDays:  () => ["production", "export-invoice-due-days"] as const,
    depositInvoiceDueDays: () => ["production", "deposit-invoice-due-days"] as const,
    exportInvoices:        () => ["production", "export-invoices"] as const,
    depositInvoices:       () => ["production", "deposit-invoices"] as const,
    phantomAlerts:         () => ["production", "phantom-alerts"] as const,
  },

  // ─── Partners ─────────────────────────────────────────────────────────────
  partners: {
    all:            () => ["partners"] as const,
    contractBrewing: () => ["partners", "contract-brewing"] as const,
    suppliers:       () => ["partners", "suppliers"] as const,
  },

  // ─── Finance ──────────────────────────────────────────────────────────────
  finance: {
    all:            () => ["finance"] as const,
    /** Single invoice detail. */
    ledgerInvoice:  (id: string) => ["finance", "ledger", "invoice", id] as const,
    /** Invoice list filtered by date range + source. */
    ledgerInvoices: (range: string, source: string) => ["finance", "ledger", "invoices", range, source] as const,
    /** Flat chart-of-accounts list (invoice line-item GL mapping). */
    chartOfAccounts: () => ["finance", "chart-of-accounts"] as const,
    /** Consolidated Financials view (Task 7), keyed by statement kind + year. */
    financials: (statement: string, year: number) => ["finance", "financials", statement, year] as const,
  },

  // ─── Taproom ──────────────────────────────────────────────────────────────
  taproom: {
    all:           () => ["taproom"] as const,
    salesPulse:    (start: string, end: string) => ["taproom", "sales-pulse", start, end] as const,
    salesPulseDay: (date: string) => ["taproom", "sales-pulse-day", date] as const,
    targets:       () => ["taproom", "targets"] as const,
    manualEntries: () => ["taproom", "manual-entries"] as const,
    tapConfig:     () => ["taproom", "tap-config"] as const,
    tapSwaps:      () => ["taproom", "tap-swaps"] as const,
    draftStats:    () => ["taproom", "draft-stats"] as const,
    inventory:     () => ["taproom", "inventory"] as const,
    events:        () => ["taproom", "events"] as const,
    eventPours:    (id: string) => ["taproom", "event-pours", id] as const,
  },

  // ─── Payroll ──────────────────────────────────────────────────────────────
  payroll: {
    all:       () => ["payroll"] as const,
    config:    () => ["payroll", "config"] as const,
    employees: () => ["payroll", "employees"] as const,
    periods:   () => ["payroll", "periods"] as const,
    period:    (id: string) => ["payroll", "periods", id] as const,
    preview:   (id: string) => ["payroll", "preview", id] as const,
    // `shiftsAll` is a shorter prefix of `shifts` — pass it to
    // invalidateQueries to invalidate both the read-only and override-mode
    // variants at once (they cache separately since I1).
    shiftsAll: (id: string) => ["payroll", "shifts", id] as const,
    shifts:    (id: string, override: boolean) => ["payroll", "shifts", id, override] as const,
  },

  // ─── Tax ──────────────────────────────────────────────────────────────────
  tax: {
    all:       () => ["tax"] as const,
    tasks:     () => ["tax", "tasks"] as const,
    task:      (id: string) => ["tax", "tasks", id] as const,
    taskFiles: (id: string) => ["tax", "tasks", id, "files"] as const,
    schedules: () => ["tax", "schedules"] as const,
    parties:   () => ["tax", "parties"] as const,
    profile:   (party: string) => ["tax", "profile", party] as const,
    squareTaxes: () => ["tax", "square-taxes"] as const,
    entityProfile: () => ["tax", "entityProfile"] as const,
    legalRepresentative: () => ["tax", "legalRepresentative"] as const,
    bankAccount: () => ["tax", "bankAccount"] as const,
    authorities:   () => ["tax", "authorities"] as const,
    registrations: () => ["tax", "registrations"] as const,
    rates: (category?: string) => (category ? ["tax", "rates", category] as const : ["tax", "rates"] as const),
  },

  // ─── Settings (app-wide) ──────────────────────────────────────────────────
  settings: {
    all:             () => ["settings"] as const,
    breweryTimezone: () => ["settings", "brewery-timezone"] as const,
  },

  // ─── Brand ────────────────────────────────────────────────────────────────
  brandCanon: {
    all:      () => ["brand", "canon"] as const,
    draft:    () => ["brand", "canon", "draft"] as const,
    versions: () => ["brand", "canon", "versions"] as const,
  },
  brandAssets: {
    all:  () => ["brand", "assets"] as const,
    list: (kind?: string) => ["brand", "assets", "list", kind ?? "all"] as const,
  },
  brandLabels: {
    all:  () => ["brand", "labels"] as const,
    list: (status?: string) => ["brand", "labels", "list", status ?? "all"] as const,
    one:  (id: string) => ["brand", "labels", id] as const,
  },
} as const;
