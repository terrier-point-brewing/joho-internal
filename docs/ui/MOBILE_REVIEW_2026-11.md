# Mobile UI Review 2 — Taproom, Finance, Settings (2026-11-12)

Code-level review at phone width (390 × 844 portrait; 667 × 375 and 844 × 390
landscape). Follows docs/ui/MOBILE_REVIEW.md (2026-10-13), whose ten global
fixes have shipped. This pass is about what those fixes don't reach.

## Verdict

The October pass fixed the primitives. The remaining problems are **three
structural patterns**, each repeated across the three areas. Fix the patterns
in shared code and most per-page issues disappear; the per-page list below
is then a short mop-up.

| # | Pattern | Where it bites |
|---|---|---|
| A | **Full-height page layouts pin their own chrome.** `h-full flex-col` + `shrink-0` header + `flex-1 overflow-auto` body bypasses StickyHeader, so the `short:` landscape unpin never fires and area tabs never scroll away. In landscape the inner scroll window is 0–145 px. | Finance Transactions (all 6 subtabs), Financials, Period Close; Settings Group Shell + 7 settings pages (CoA, GL Mapping, Balance Sheet, Depreciation, Departments, Tax Profile, Tax Filing); Taproom Inventory, Catalog/Export matrices (`max-h-[calc(100vh-…)]`). |
| B | **Desktop tables are the only table.** `px-4` cells, no sticky first column, no phone-hidden columns, `min-w-[460–540px]` that forces sideways scroll even when the data would fit, `overflow-auto` wrappers that miss the `.scroll-x` fade, and `colSpan` drawers whose editors (Save button included) sit off-screen at the table's scroll width. | Sales Pulse category table, Items, Loss, Target Setting, Achievement, Inventory; every Ledger subtab, Financials, Payroll periods; GL-mapping panels (clipped, not scrollable), Balance Sheet, Users, Export matrix. |
| C | **Fixed-width label + control rows that never stack.** `w-44`/`w-28`/`shrink-0` action clusters beside a `flex-1` name; the control (usually an AccountSelect) is what gets crushed, sometimes to ~14 px. | RevenuePanel, Deposit Settings, Registrations, CoA/Balance Sheet toolbars, Event card headers, Financials header, Draft Stats toolbar (no wrap, overflows in edit mode). |

Plus one shell issue the October pass didn't cover:

**D — Landscape chrome has no escape hatch.** Below `md` (667 × 375) the top bar
and bottom nav are a permanent 100 px of ~340. At `md` (844 × 390) the
desktop sidebar appears instead, 192 px wide unless the user has collapsed
it. Nothing auto-hides.

## Recommended order

1. **Shell (one PR).** `short:` → hide the mobile top bar (account moves into
   Settings/More), auto-hide the bottom nav on scroll-down, default the
   sidebar to collapsed under `short:`. Raise `.inp`/`.inp-sm` to 16 px under
   `pointer: coarse` (stops iOS focus-zoom on every finance editor).
2. **Pattern A (one PR).** Make the pane the scroller below `md`: drop
   `h-full`/`fill` on Transactions, Financials, Period Close and the Settings
   shell; move SettingsHeader + GL-mapping picker row inside the scroll div.
   Payroll and Tax (`<main>` + StickyHeader) are the pattern to copy.
3. **Pattern B (one PR, shared).** Add to `LedgerTable`/`Card`: `max-sm:px-2`
   cells, sticky first column, a `hideBelow="sm"` column prop, chevron folded
   into the first cell, and a drawer wrapper that is `sticky left-0` at
   viewport width. Then apply per page (table below).
4. **Pattern C + mop-up (per area PRs).** Stack label/control below `sm`,
   let action clusters wrap or fold into a ⋯ menu.

## Per-area findings

### Taproom

- **Sales Pulse** (already improved in #727). Remaining: 6-column category
  table is `min-w-[540px]`. On phones show Category + Net only, tap a row to
  reveal Gross/Discounts/Returns/Tax. KPI tiles and chart are fine now.
- **Inventory.** `max-h-[calc(100vh-290px)]` inner scroller (InventoryTab:220)
  shows 1–2 rows in landscape. Sticky Recipe (170 px) + sticky Total (76 px)
  leave one data column at 390. Drop the cap below `md`, narrow Recipe,
  unpin Total.
- **Items / Loss.** 11 chips + 2 filters = 4–5 toolbar rows; fixed 300 px
  charts ignore `short:`; tables use `overflow-auto` (no fade/bleed); row
  drill is `onDoubleClick`, which is zoom on touch. Range and Grouping →
  selects on phones; hide Category/Avg (Items) and Avg %/Kegs (Loss);
  replace double-click with a 44 px Details button; drills drop `max-h-96`
  and `min-w-[480–520px]`.
- **Draft Stats.** Toolbar `flex gap-2` with no wrap overflows in edit mode
  (:521). One full card per tap ≈ 1,500 px for 8 taps; use a compact row or
  2 columns. Three `btn-xxs` per card wrap to two lines.
- **Events.** Three `btn-xxs` in the card title row leave ~140 px for the
  name; move them into the expanded body. UnallocatedPoursPanel renders a
  full card when there's nothing to fix; hide at 0. Pour KPI strip is 5
  tiles in `grid-cols-2` (orphan). Long date format wraps 2–3 lines.
- **Achievement.** `min-w-[460px]` on a 4-column table that fits without it.
  Weekly chart forces 52 tick labels (`interval={0}`). Tile 2 is `text-xl`
  with no `sm:` step.
- **Target Setting.** Edit mode is a 480 px horizontal input grid with no
  sticky quarter label. Phones need one card per quarter with stacked tiers.
- **Payroll.** PeriodSelector beside the title squeezes it to ~120 px; stack
  below `md`. Bartender table has no sticky name column. ShiftTimeline
  banners sit inside the horizontal scroller.

### Finance

- **Transactions (worst).** Layout + `LedgerTable fill` pin FinanceNav, title,
  subnav, FilterBar, Pagination, SummaryStatBar. Portrait ≈ 6 rows;
  **landscape shows zero rows.** Fix per Pattern A.
- **Ledger tables.** 6–10 columns, `px-4` everywhere, 56 px chevron column,
  no sticky column. Essentials per subtab: Orders Date/Customer/Mapping/Total;
  Invoices #+Customer/Status/Total; Expenses Date/Merchant/GL/Amount; Bank
  Date/Counterparty/Flow/Amount; Manual Account/Date/Amount/actions;
  Duplicates Month/Amount/sides/Review. Everything else hides or folds.
- **Expanded-row editors.** Manual/Bank/Payroll split panels and order/invoice
  line grids render at ~900 px inside the `colSpan` drawer; Save is
  off-screen. Pin the drawer to viewport width or open a bottom sheet.
- **FilterBar is a catch-all.** "+ Add entry", Sync, Auto-map, Refresh and the
  Duplicates view switch all fold behind "Filters" on phones. Split into
  filters (foldable) and actions (always visible).
- **Financials.** 14-column table with `minWidth = months*96+280` (1432 px).
  Phone mode: label + one month + optional YTD with a pinned ‹ Oct › stepper.
  The `sticky top-0` month header never sticks (wrong scroll container, also
  on desktop). Header cluster (⚑ review, year, Refresh ≈ 276 px) overruns.
  CloseTasksBanner is pinned. KPI strip is 3 rows on a phone → `scroll-x`.
- **Spend Watch.** 12 month chips → select or stepper.
- **Period Close.** Header permanently pinned (≈110 px) plus `py-8`; index
  table → stacked cards; footer stat grid should stay 3-up at 390.
- **Tax.** ScheduleList action cluster squeezes the label to ~100 px. TTB and
  NC Sales/Use worksheets crush money inputs to ~50 px: show read-only on
  phones with Total Due near the top and a "edit on a wider screen" notice.
  Wake County and NC Beer Excise stay editable.
- **AccountSelect.** Portal positioned from `window.innerHeight`, so the iOS
  keyboard covers it; `onMouseDown` selection. Bottom-sheet list on touch.

### Settings

- **Shell.** SettingsGroupShell pins the area tabs (`shrink-0` above a
  `flex-1 min-h-0` slot), and 7 pages put SettingsHeader outside their
  scroller. ≈264 px pinned portrait (31 %); GL Mapping adds a non-wrapping
  picker + banner row → 45–60 % pinned, ~0–35 px of content in landscape.
- **GL Mapping.** MappingFrame tables are `overflow-hidden`, so Payees,
  Sales Tax and Refunds are **clipped with no way to reach the right
  columns**. RevenuePanel variation rows give the AccountSelect ~14 px.
  Stack name / select / chips vertically below `sm`; bulk tools into a
  second line or sheet; picker row → scrolling chip row.
- **Drawers.** MappingDrawer and the Export drawer are `z-40` under the
  `z-50` top bar and bottom nav: the × and the Save/Remove buttons are
  covered. Export drawer is still `w-[400px]`. Move both onto Modal's bottom
  sheet.
- **Export Settings matrix.** 320 px sticky label column + `max-h-[calc(100vh-300px)]`
  → ~75 px window with ~40 px for partner columns. Reuse Catalog's (#725)
  card-per-row layout below `md`.
- **Balance Sheet.** Same clipped `overflow-hidden` table; toolbar doesn't
  wrap. Reconciliation modal shows amounts at 10 px.
- **Payroll Config.** Four `grid-cols-2` with no prefix; inline employee edit
  is a `colSpan=7` form that scrolls sideways → Modal. Always-visible 7-line
  formula block → collapsible.
- **Label-left rows.** Deposit Settings (`w-28` + `min-w-[16rem]` = 376 px,
  page scrolls sideways), Registrations, CoA toolbar, CronMonitor.
- **10 px explanations.** Counterparties, Balance Sheet, MethodSetupPanel and
  CronMonitor carry their "why" in `text-2xs` or hover-only `title=`,
  unreachable on touch. Catalog/Export chips are 8–10 px primary content.
- **Fine already:** GrantMatrix (bottom-sheet modal), Chart of Accounts
  (3 columns on phones), Catalog grid (#725), everything built on Modal.

## Reusable patterns to adopt

- **Card-per-row below `md`** (Catalog #725) for every wide editable table.
- **Priority columns + expandable row** for read-only tables, instead of
  sideways scroll.
- **`<main>` + StickyHeader** for page framing; never `h-full` + inner scroll
  below `md`.
- **Actions out of FilterBar**; a ⋯ menu for per-row/per-card action strips.
