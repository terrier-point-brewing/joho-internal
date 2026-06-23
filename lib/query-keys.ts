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
export const queryKeys = {
  // ─── Production ──────────────────────────────────────────────────────────
  production: {
    all:                  () => ["production"] as const,
    ingredients:          () => ["production", "ingredients"] as const,
    stockAdjustments:     () => ["production", "stock-adjustments"] as const,
    packagingAdjustments: () => ["production", "packaging-adjustments"] as const,
    brewAdjustments:      () => ["production", "brew-adjustments"] as const,
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
    exciseTaxRates:        () => ["production", "excise-tax-rates"] as const,
    exportServiceMappings: () => ["production", "export-service-mappings"] as const,
    exportSquareCatalog:   () => ["production", "export-square-catalog"] as const,
    exportInvoiceDueDays:  () => ["production", "export-invoice-due-days"] as const,
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
    /** Year-scoped taproom sales (used in model + taproom sales page). */
    salesTaproom:   (year: number) => ["finance", "sales", "taproom", year] as const,
    salesEvents:    (year: number) => ["finance", "sales", "events",  year] as const,
    /** Year-scoped invoice sales (used in model, contract-brewing, distribution). */
    salesInvoices:  (year: number) => ["finance", "sales", "invoices", year] as const,
    /** Single invoice detail. */
    ledgerInvoice:  (id: string) => ["finance", "ledger", "invoice", id] as const,
    /** Invoice list filtered by year + source. */
    ledgerInvoices: (year: number, source: string) => ["finance", "ledger", "invoices", year, source] as const,
  },

  // ─── Taproom ──────────────────────────────────────────────────────────────
  taproom: {
    all:           () => ["taproom"] as const,
    salesPulse:    (start: string, end: string) => ["taproom", "sales-pulse", start, end] as const,
    salesPulseDay: (date: string) => ["taproom", "sales-pulse-day", date] as const,
    targets:       () => ["taproom", "targets"] as const,
    manualEntries: () => ["taproom", "manual-entries"] as const,
    tapConfig:     () => ["taproom", "tap-config"] as const,
    draftStats:    () => ["taproom", "draft-stats"] as const,
    events:        () => ["taproom", "events"] as const,
    eventPours:    (id: string) => ["taproom", "event-pours", id] as const,
  },
} as const;
