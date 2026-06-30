# Dead-Code Audit — 2026-06-30

**Scope:** `app/` and `lib/` (TypeScript/TSX). **Report only — no deletions made.**

**Method:** `tsc --noEmit` is already clean (per the plan), so this leans on ripgrep for
import/reference graphs plus the existing tech-debt markers. For each candidate, "references"
counts files other than the defining file that mention the symbol/path across
`app/**` and `lib/**` (`*.ts`, `*.tsx`). Confidence reflects how certain the item is unused
(barrel re-exports, dynamic `import()`, and string-built routes were checked where relevant).

Out-of-scope-for-deletion-but-noted: anything reachable only by an external caller
(webhooks/cron) can't be proven dead from the repo alone; such items are marked accordingly.

---

## Findings ranked by confidence

### HIGH confidence — whole files / routes with zero consumers

| Item | Why it appears dead | Confidence |
|---|---|---|
| `lib/production/exportBayEquipment.ts` (entire file) | Only export `getExportBayEquipmentId` has **zero importers**. Worse, it queries `equipment WHERE type = 'export_bay'`, but the live `equipment_type_check` CHECK constraint only permits `fermenter\|brite\|brewhouse\|cold_storage\|kegging\|canning` — so `export_bay` rows can never exist and the function always returns null. Dead + logically impossible. | **HIGH** |
| `app/api/combo-sales/route.ts` | No UI fetch caller anywhere in `app/**/*.tsx` (ripgrep for `combo-sales` / `comboSales` returns nothing outside the route + its lib). `docs/production-schema.md` explicitly lists this under "Known Limitations": *"`/api/combo-sales` — legacy route, not wired to any UI report."* | **HIGH** |
| `lib/reports/combos.ts` | Sole consumer is the orphan `app/api/combo-sales/route.ts` above. If that route is removed, this becomes dead too. (Note: `docs/production-schema.md` also flags the combo-detection logic as having a known bug.) | **HIGH** (conditional on combo-sales removal) |
| `app/api/production/workflow-templates/route.ts` and `app/api/production/workflow-templates/[id]/route.ts` | Back the orphaned `workflow_templates` / `workflow_template_steps` tables (0 rows, schema finding S8). No UI fetch caller; superseded by the `brew-step-templates` routes that ARE fetched by `RecipesTab.tsx` / `BrewStepTemplatesTab.tsx`. | **HIGH** (gate: confirm no external automation hits the routes) |

### HIGH confidence — superseded named exports (function-level dead code)

These modules ARE imported, but the specific listed export is not — it's an older variant
left behind when a `*ByDay` / replacement function took over. Verified by reading the actual
`import { ... }` specifiers at every call site.

| Export | Defining file | Live replacement actually used | Confidence |
|---|---|---|---|
| `fetchTipsAndCashTake` (+ `DailyTips` type) | `lib/square/payroll.ts` | `fetchTipsAndCashTakeByDay` (imported by `app/api/payroll/periods/[id]/shifts/route.ts` and `lib/payroll/previewService.ts`) | **HIGH** |
| `fetchShiftHours` (+ `DailyShift` type) | `lib/square/labor.ts` | `fetchShiftsByDay` (same two callers) | **HIGH** |
| `getSquareProject`, `updateSquareProject` | `lib/square/projects.ts` | Only `createSquareProject` is imported (by `app/api/production/batches/route.ts`); the get/update pair has no callers | **HIGH** |
| `squarePut` | `lib/square/client.ts` | No caller (`squareGet`/`squarePost`/`squareDelete` are used; `squarePut` is not) | **HIGH** |
| `fmtUsd0` | `lib/utils/formatting.ts` | No caller anywhere (only `fmtUsd` is used) | **HIGH** |

### MEDIUM confidence — possibly-unused exports (verify before removing)

These came out of an exported-symbol-vs-reference scan. Many are **types** consumed only as
type annotations or re-exported; a few may be genuinely unused. They are lower-confidence
because type-only usage and re-export chains are easy to miss with a text scan. Recommend a
targeted `ts-prune` / `knip` run before acting on any of these.

- `lib/finance/qb-csv.ts`: `ColumnMap`, `ParseResult`, `autoDetectColumns`, `buildImportPayloads`
- `lib/finance/qb-pdf.ts`: `PDFParseResult`
- `lib/finance/invoiceSalesReport.ts`: `ReportChannel`, `InvoiceSalesReport`
- `lib/finance/syncSquareInvoices.ts`: `SyncSquareInvoicesResult`
- `lib/production/squareMappingGrid.ts`: `ColumnDef`, `CellVariation`, `GridCell`, `GridRow`
- `lib/production/exportInvoicePreview.ts`: `InvoicePreviewResult`
- `lib/production/exciseTax.ts`: `ExciseTaxLine`
- `lib/reports/contract-brewing.ts`: `ContractBrewingCategoryRow`, `ContractBrewingCustomerRow`, `ContractBrewingResult`
- `lib/reports/bbl-tracker.ts`: `BBLStyleRow`, `BBLChannelRow`, `BBLTrackerResult`
- `lib/reports/distribution.ts`: `DistributionSize`, `DistributionSizeRow`, `DistributionCustomerRow`, `DistributionResult`
- `lib/reports/cocktails.ts`: `CocktailDetectionResult`
- `lib/square/square-invoices.ts`: `CreateDepositInvoiceParams`, `DepositInvoiceResult`, `CreateExportInvoiceParams`, `ExportInvoiceResult`
- `lib/square/teamMembers.ts`: `SquareTeamMember`
- `lib/square/skuMappings.ts`: `SkuDbClient`, `ProductSku`, `ServiceSku`, `CatalogMeta`, `resolveServiceSku`, `resolveCatalog`
  (NOTE: `resolveServiceSku`/`resolveCatalog` are runtime fns — but the consumer
  `lib/production/exportInvoicePreview.ts` imports from `skuMappings`; confirm which named
  exports it actually pulls before treating these as dead. The module is the documented
  "unified resolver", so removals here are risky.)
- `lib/square/catalogUnits.ts`: `InventoryUnit`
- `lib/payroll/types.ts`: `TipDistributionModel`, `PayPeriodStatus`
- `lib/ramp.ts`: `getRampToken`, `RampTransaction`, `RampStatement` (module IS used — these
  are likely internal-only or type exports; do not remove the file)
- `lib/resend.ts`: `RESEND_FROM` (module IS used by `app/api/admin/requests/route.ts`)
- `lib/utils/datetime.ts`: `BREWERY_TZ`, `dayStartUtc`, `dayEndUtc`

### LOW confidence / informational — over-exported but NOT dead

- `lib/hooks/useUserRole.ts` :: `useAuthMeQuery` — flagged by the scan, but it is used
  **internally** (line 28) by `useUserRole`. Only the `export` keyword is unnecessary;
  the code is live. Demote to a non-exported helper at most. **Not dead.**

---

## Tech-debt markers (30 total in `app/` + `lib/`)

Almost all are `eslint-disable` for React-hooks lint rules
(`react-hooks/set-state-in-effect`, `exhaustive-deps`, `preserve-manual-memoization`) in
client components — these are deliberate suppressions of the new React 19 / Next 16 hook
lints, not dead code. Notable non-React ones:

- `app/api/finance/pl/route.ts:99` — `// TODO: align both to "COGS on cold-storage arrival"
  by joining stock_adjustments` (genuine open work item, not dead code).
- `lib/finance/qb-pdf.ts:15` — `eslint-disable @typescript-eslint/no-require-imports`
  (intentional CJS require for the PDF parser).
- `lib/ramp.ts:77`, `lib/square/sell-through.ts` (4×), `lib/square/skuMappings.ts:13` —
  `eslint-disable @typescript-eslint/no-explicit-any` around Square/Ramp raw JSON shapes
  (acceptable boundary `any`s; the ~6 `any`s the plan mentions).

No unreachable code (post-`return`/`throw` blocks, `if (false)`) was found; `tsc` strict +
the existing lint config would already flag most of it.

---

## Recommended removal order (for a future cleanup PR — NOT done here)

1. Delete `app/api/combo-sales/route.ts`, then `lib/reports/combos.ts` (HIGH).
2. Delete `lib/production/exportBayEquipment.ts` (HIGH; also fixes a logically-impossible query).
3. Remove superseded exports: `fetchTipsAndCashTake`/`DailyTips`, `fetchShiftHours`/`DailyShift`,
   `getSquareProject`/`updateSquareProject`, `squarePut`, `fmtUsd0` (HIGH).
4. Delete the two `workflow-templates` route files **together with** the
   `drop_workflow_templates` migration (gate on no external automation) (HIGH).
5. Run `knip`/`ts-prune` to confirm/triage the MEDIUM type-export list before touching it.

All of the above are recommendations. **No files were deleted and no code was changed** in
this audit (per the landing policy: report + draft, the human decides removals).
