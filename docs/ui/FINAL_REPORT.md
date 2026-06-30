# UI Consistency Pass — Final Report (Phase 6)

Full-codebase typography/color/spacing/structure/sizing consolidation onto a single
canonical design system. Shipped as 6 PRs so each area could be reviewed and merged
independently (other agents were working concurrently in separate areas).

## PRs

| PR | Scope | State |
|---|---|---|
| [#45](https://github.com/terrier-point-brewing/terrier-point-brewing/pull/45) | Foundation: `@theme` tokens, `.btn-*`/`.inp` redefinition, shared primitives, docs, shared-chrome migration | merged |
| [#47](https://github.com/terrier-point-brewing/terrier-point-brewing/pull/47) | Core / settings / auth / payroll components | merged |
| [#56](https://github.com/terrier-point-brewing/terrier-point-brewing/pull/56) | Finance | merged |
| [#48](https://github.com/terrier-point-brewing/terrier-point-brewing/pull/48) | Production | merged |
| [#51](https://github.com/terrier-point-brewing/terrier-point-brewing/pull/51) | Taproom + Reports | merged |
| [#57](https://github.com/terrier-point-brewing/terrier-point-brewing/pull/57) (this) | Codify into CLAUDE.md + this report | merging last |

## Coverage (vs. `ROUTE_MANIFEST.md`)

Every in-scope content surface was visited. Verified per area with
`grep -E "(bg|text|border|ring)-(zinc|amber|red|green|blue|gray)-[0-9]"` returning **zero**
hits across non-exempt files, plus `npm run build` + `npm run lint` (0 errors) on each branch.

| Area | Content surfaces | Status |
|---|---|---|
| Shared chrome (NavBar, SubNav, TabBar, PageHeader, SquareCatalogSelect) | 5 | ✅ done (#45) |
| Core / settings / auth / payroll components | settings (8), auth (2), payroll components (6), root | ✅ done (#47) |
| Finance | 17 content pages/components + 6 navs + SalesTable | ✅ done (#56), residual 0 |
| Production | 17 page shells + ~30 tab/panel components | ✅ done (#48), residual 0 |
| Taproom + Reports | 9 taproom pages/tabs + 9 report components + section layouts | ✅ done (#51), residual 0 |
| API routes (`app/api/**`, ~150) | — | ⏭ out of scope (no UI) |
| Redirect/guard pages (~20) | — | ⏭ no markup |

**No silent omissions.** Exempted surfaces (documented, intentionally not token-migrated):
EquipmentSchedule/**, FloorplanTile/**, GanttTab, CalendarTab, BrewStatus floorplan canvas
(React Flow / absolute canvases), Recharts axis/grid/series color props, and NavBar fixed-nav
`text-[10px]` micro-labels.

## Replacements by dimension (rough, across all PRs)

- **Color → token utilities:** ~3,500+ raw `zinc/amber/red/green/blue` utilities rewritten
  (production ~2,800, finance ~900, core ~200, taproom area). Residual in non-exempt code: 0.
- **Buttons → `.btn-*`:** ~200 inline buttons (3 contradictory amber languages + 1 blue
  primary unified onto solid-amber `.btn-amber`).
- **Inputs → `.inp`/`.inp-sm`:** ~150 raw inputs/selects; ~9 local `inputCls`/`selectCls`
  consts deleted (incl. two same-named-different-ring traps).
- **Page headers → `<PageHeader>`:** ~27 hand-rolled `<h1>/<h2>` titles.
- **Tabs:** 8 reimplementations of the underline-tab row collapsed onto `SubNav`/`TabBar`
  (4 finance navs, SettingsTabs, PayrollPeriodView + the 2 shared components share one primitive).
- **Banners → `<Banner>`:** ~20 copy-pasted error/success boxes.
- **Cards → `<Card>`:** ~40 hand-rolled panels.
- **Off-scale type/spacing:** arbitrary `text-[10px]/[9px]/[11px]` removed outside exempt code.

## Components created / consolidated

**Created (foundation, `app/components/ui/`):** `Card`, `Modal`/`Field`/`ModalActions`,
`Banner`, `Badge`, `tone` map, `tabStyles` (shared tab primitive). Plus `.inp-sm` and the
redefined `.btn-amber` (solid amber, dark text) in `globals.css`.

**Created (per-area extractions):**
- Finance: `app/finance/AccountSelect.tsx` (3 copies → 1), `app/finance/statements/lib.tsx`
  (pl/cash-flow/balance-sheet machinery), `app/finance/sales/SalesPageShell.tsx`,
  `app/finance/lib/` (MONTH_NAMES + category colors). On merge, `SalesPageShell` gained
  optional `unrecognized`/`exciseCoverage` props (rendering #58's `UnrecognizedBanner`), and
  the wholesale sales tab #58 added concurrently was folded onto the shell too — finance
  residual stays 0.
- Production: `app/production/lib/categoryColors.ts` (batch-color cycle + status/type badge maps).
- Reports: `app/reports/components/ReportTable.tsx` (7 copies → 1) + `categoryStyles.ts`;
  taproom `categoryStyles.ts`.

**Consolidated onto existing:** currency formatting reuses `lib/utils/formatting.ts`
(`fmtUsd`/`fmtUsd0`/`fmtCents`) — no new formatter; `production/components/shared.tsx`
`Modal`/`ModalActions` now use the canonical tokens/buttons.

**Left as-is:** `FormattedInput` (passes `className` through — callers supply `.inp`).

## Needs human review / judgment calls

1. **`taproom/reports`** keeps its two-level `<select>` view switcher (admin-only,
   category→report) rather than tabs — tokenized in place.
3. **Finance full-height shells** (`flex flex-col h-full`) kept where the scroll behavior is
   load-bearing (per UI_STANDARD §4 exception), rather than forced onto the `<main>` template.
4. **Two finance payroll page titles** kept inline (sit in a `flex justify-between` row with a
   sibling action), restyled to the PageHeader spec in place.
5. **SettingsTabs** uses the shared tab styles directly rather than `<SubNav>` (preserves its
   prop-driven role check + dynamic pending-count badge).
6. **Data-category colors** (deposit BS/PL violet, chart series, urgency ramps, badge hues)
   kept as deliberate non-token palettes, centralized into shared constants per area.
7. **Finance dense tables** had no browser spot-check (migrated in a headless worktree) — a
   visual pass on chart-of-accounts / account-mapping dense grids is recommended.

## Codified

- `CLAUDE.md` → new **UI Conventions** section (source-of-truth, no-raw-colors, no
  hand-rolled-primitives, scale-only sizing) + an Extended-Documentation trigger pointing at
  `docs/UI_STANDARD.md`.
- `docs/UI_STANDARD.md` (the contract), `docs/ui/ROUTE_MANIFEST.md`,
  `docs/ui/INCONSISTENCY_CATALOG.md`, and this report.

## Merge order (as executed)

Area PRs (#47, #56, #48, #51) and this codify PR all branch off the merged foundation and are
mutually independent. They were landed alongside concurrent perf/feature work in an
orchestrated order that let the large mechanical token PRs absorb conflicts last: structural
PRs first (e.g. #50, #58), then the token sweeps. #56 (finance) was the one PR to hit a real
conflict — against #58's `UnrecognizedBanner`/excise feature — resolved by threading the
banner through `SalesPageShell` (see Finance note above). This codify PR merges last so the
report reflects the completed pass.
