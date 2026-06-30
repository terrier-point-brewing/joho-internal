# Inconsistency Catalog — UI Consistency Pass (Phase 1b)

Consolidated from a full crawl of all four areas (core/shared, finance, production,
taproom+reports). Per-area detail with exhaustive `file:line` references lives in the
scratchpad inventories; this is the cross-codebase rollup grouped by dimension. For each
dimension the **dominant** variant (canonical candidate) is marked ✅ and rare variants
🔻 are migration targets.

**Headline finding:** the design-token layer in `app/globals.css` (CSS color vars +
`.btn-*`/`.inp` classes) is **almost entirely unused by the code it was built for**. The
shared chrome components themselves (PageHeader, SubNav, TabBar, NavBar) bypass it with
raw `zinc-*`/`amber-*` classes. So the problem isn't "tokens vs ad-hoc" — it's that the
tokens are dead and every surface independently re-derived the palette, producing shade
drift, off-palette colors, and ~4–5 copies of every primitive.

---

## 1. Typography

### Page titles — the same role, 3 patterns
| Variant | Count | Where | Verdict |
|---|---|---|---|
| `PageHeader` → `<h2 text-base font-medium text-zinc-100>` | ~19 pages | All production (12) + taproom perf/targets (6) + finance/invoices (1) | ✅ canonical (shared component) |
| Hand-rolled `<h1 text-base font-semibold text-zinc-100>` | ~12 | finance model/sales×4/statements×3/settings×3, square-transactions | 🔻 → PageHeader |
| Hand-rolled `<h2 text-base font-semibold>` | ~9 | settings (account/users/requests/SettingsTabs), auth (login/set-password) | 🔻 → PageHeader |
| `<h1 text-lg font-semibold>` | 3 | finance/payroll, finance/payroll/[id], taproom/payroll/[id] | 🔻 → PageHeader |

Conflict to resolve: PageHeader enforces **font-medium**; ~24 hand-rolled titles use
**font-semibold**. Pick one (see UI_STANDARD §1).

### Page descriptions
- ✅ `text-sm text-zinc-500` (PageHeader) — production/taproom.
- 🔻 `text-xs text-zinc-500` — ~12 finance headers. (size mismatch)

### Section / sub-headings (`<h3>`)
`text-sm font-semibold text-zinc-200` (most common, ~3+), `text-sm font-medium text-zinc-300`
(~3), `text-sm font-semibold text-zinc-400` (~2), `text-sm font-medium text-zinc-200` (~5
production). Split across zinc-200/300/400 × medium/semibold with no rule.

### Eyebrow / uppercase labels
`text-xs font-semibold uppercase tracking-wide text-zinc-400/500` (~10) vs
`text-[11px] font-bold uppercase tracking-widest` (4, finance) vs
`text-[10px] font-semibold uppercase tracking-wider` (3). Mixed sizes/tracking.

### KPI / stat values
✅ `text-base sm:text-xl font-semibold text-zinc-100` (taproom KPI cards) vs 🔻 `text-xl
font-semibold` (no responsive step — AchievementTab:381, inconsistent within one row) vs
`text-lg font-semibold` (report chips).

### Captions / muted body — **~6 interchangeable variants**
`text-xs text-zinc-500`, `text-xs text-zinc-600`, `text-sm text-zinc-500`,
`text-sm text-zinc-600`, `+italic` variants. Empty/placeholder copy flips zinc-500↔600
with no rule.

### Numeric cells
`font-mono tabular-nums` consistent in finance/taproom tabs, but **all 7 report tables
render currency in plain sans** (no mono). `tabular-nums` applied ad-hoc per file.

### Off-scale type (FORBID outside canvas/chart exempt)
`text-[10px]` (≈104 production + 80+ finance), `text-[11px]` (~15), `text-[9px]` (~7),
`text-[8px]` (1). Bypass the Tailwind type scale.

---

## 2. Color

**CSS `--color-*` vars: ~0 references in feature code** (consumed only by `.btn-*`/`.inp`
rules). 100% of feature color is raw Tailwind. Most maps to the intended zinc/amber/red
palette, but with shade drift and off-palette additions.

### Raw zinc/amber usage volume (production area alone)
`text-zinc-500` ×446, `text-zinc-600` ×224, `text-zinc-400` ×207, `text-zinc-300/200`
×136 each, `border-zinc-700/800` ×128/112, `text-red-400` ×96, `bg-zinc-800` ×89,
`text-amber-400` ×71, `text-amber-300` ×48, `bg-zinc-900/{20..80}` ×~110. Finance is
comparable (`border-zinc-800*` alone 100+). ~2,800 raw color tokens in production; similar
order in finance. Most are role-correct — the issue is they're hardcoded and shade-drifted.

### Shade drift on the accent (amber)
Tokens define accent = amber-400, accent-border = amber-600. In practice:
- Active tab underline uses **amber-500** (SubNav/TabBar/SettingsTabs + finance navs).
- Accent text flips amber-300/400/500/600 interchangeably.
- Chart amber `#f59e0b` ≠ token `#fbbf24`.

### Primary button — **3 contradictory "amber" languages** 🔴 biggest decision
| Language | Count | Where |
|---|---|---|
| `.btn-amber` (dark amber bg `rgb(120 53 15/.3)` + amber-300 text) | ~5 | the *token* class — EventsTab, a few production |
| Solid `bg-amber-600 hover:bg-amber-500 text-white` | ~35+ | finance (~16), production `shared.tsx ModalActions`, taproom (DraftStats/TargetSetting/ManualEntries) |
| Solid `bg-amber-500 hover:bg-amber-400 text-zinc-950` | ~8 | auth + settings (AccountSettings/UserManagement/login/set-password) |
| Solid `bg-amber-800/600 text-white` (payroll) | 2 | PayrollPeriodView |

The de-facto dominant is a **solid amber button**, but in two shades with two text colors;
the official `.btn-amber` class (dark/ghost style) is barely used. Must pick one.

### Off-palette colors (NO token exists)
- **Blue** as primary + semantic: `bg-blue-600` Run-Report button (ReportControls),
  `focus:ring-blue-500` inputs (reports), `text-blue-400` sort indicator, role badge
  (UserManagement), `text-blue-300` BBL columns. 🔻 → amber primary / new info token.
- **Green** as "positive/success": pervasive in AchievementTab, DraftStatsTab, KegSales,
  BBLTracker, settings (approved), TargetSetting. **No `--color-success` token.** → define one.
- **Purple/violet** (Combo badge, contract-BBL, QB/deposit chips), **orange/yellow**
  (DraftStats urgency ramp), **emerald** (ShiftTimeline tips), **cyan** (transfer types).
- Off-palette uses split between "needs a real semantic token" (success, info, warning) and
  "data-category coloring" (badge maps, BBL channel columns).

### Danger / error — split
Token danger = red-300 / red-950/.3 / red-700. Feature code uses `text-red-400` (most
common), red-300, red-500, `bg-red-950 border-red-700` (reports ×7), `bg-red-900/30
border-red-700` (finance ×5). At least 3 error-box recipes. → one ErrorBanner + one shade.

### Canvas/chart-exempt (flagged, NOT migrated)
Inline hex/rgb in EquipmentSchedule/**, GanttTab, CalendarTab, BrewStatusTab floorplan,
and Recharts axis/grid/series props (SalesPulseTab, DraftStatsTab, AchievementTab). These
can't easily consume CSS-var classes. Exempt — but the **batch-color hex cycle is
copy-pasted** between GanttTab and CalendarTab (→ one shared constant).

---

## 3. Spacing

### Consistent (keep)
- Horizontal page padding `px-4 sm:px-6` — ~universal. ✅
- `gap-2/3/4`, `py-1.5/2/3`, modal `p-6`, `space-y-*` on a 1–6 scale.

### Page vertical rhythm — split
✅ `<main className="px-4 sm:px-6 py-4 sm:py-8">` — all production + taproom (canonical).
🔻 Finance flex pages use `pt-4 sm:pt-5 pb-3` header blocks (no `<main>`); finance payroll
+ taproom payroll fallback use `py-8` (no responsive `py-4`).

### Half-step / one-off outliers
`py-2.5` (×181 production), `px-2.5`, `gap-1.5`, `gap-0.5`, `gap-0` (no-op smell),
`mt-0.5` on ~12 finance descriptions, `mb-8`/`mb-10` (finance payroll only),
arbitrary widths `min-w-[144px]/[208px]/[260px]/[80px]…`, `max-w-[300px]/[360px]`,
inline `style={{paddingLeft}}` tree indents (pl/cash-flow/balance-sheet/CoA).

### Section gap on tab bodies — inconsistent
`space-y-6` vs `space-y-4` vs `space-y-3` vs bare margins (`mb-5`/`mb-8`) — no rule.

### Mobile horizontal-bleed idioms — 3 variants
`-mx-5 px-5`, `-mx-4 sm:mx-0 px-4 sm:px-0`, plain `overflow-x-auto`.

### Sticky offsets — magic numbers
`top-11` (SubNav), `top-[5.25rem]` (TabBar) — independent constants tied to nav height.

---

## 4. Page structure

### Wrapper families
| Family | Count | Pattern |
|---|---|---|
| ✅ `<main className="px-4 sm:px-6 py-4 sm:py-8">` + SubNav + PageHeader | ~24 | all production + taproom perf/targets |
| 🔻 `flex flex-col h-full bg-zinc-950 text-zinc-100` + FinanceNav + header block | ~12 | finance flex pages |
| 🔻 `<main className="px-4 sm:px-6 py-8">` | 4 | finance payroll, taproom payroll fallback |
| 🔻 `p-4 sm:p-6 max-w-{md,4xl}` / centered flex | ~6 | settings + auth |

Production is the **healthiest** area (shell 100% consistent, PageHeader 100% adopted) —
its shell is the canonical template.

### Section layouts missing
No `layout.tsx` for taproom performance/targets/reports or finance sub-sections → the
`PageHeader` + dual-`SubNav` shell **and the description strings** are copy-pasted across
6 taproom leaf pages (identical desc strings) and ~12 finance pages.

### Navigation paradigm outliers
- `taproom/reports` uses `<select>` dropdowns to switch views while every sibling
  multi-view page uses SubNav tabs.
- `brewing/transfers` builds its feature inline instead of a `*Tab` component.

### Container max-width — no shared constant
`max-w-5xl` / `4xl` / `3xl` / `md` / none, picked per tab/page.

### Card/panel chrome — copy-pasted, no component
`bg-zinc-900 border border-zinc-800 rounded-lg` repeated ~15× finance, ~24× production,
plus settings/auth. One stray `border-zinc-700` variant.

---

## 5. Component sizing

### Buttons — `.btn-*` mostly unused; many bespoke sizes
Primary paddings seen for the same role: `px-3 py-1`, `px-3 py-1.5`, `px-4 py-1.5`,
`px-4 py-2`, `px-2 py-1`, full-width `py-2`. `.btn-amber/.btn-ghost/.btn-danger` used in a
handful of production + taproom places; **never in finance/settings/auth**. `.btn-sm`
adopted in finance invoices/square-transactions only. `shared.tsx ModalActions` (the
canonical modal footer) itself hand-rolls instead of `.btn-*`.

### Inputs — `.inp` exists, bypassed everywhere
`.inp` adopted: AccountSettings, finance invoices/square-transactions (~8), taproom
EventsTab/DraftStatsTab, production transfers. Bypassed: **67 raw inputs in production**
(dense `px-2 py-1 text-xs` micro-input ×10 in ExportSettingsPanel), ~30+ in finance,
5 separate `*Cls` constants in taproom/reports (two named `selectCls` with **different
focus rings — blue vs amber**), auth/settings/payroll hand-rolled, SquareCatalogSelect.

### Table cell padding — **no standard, 5+ sizes**
`px-3 py-2` (×96), `px-4 py-2.5` (×87), `px-3 py-2.5` (×63), `px-3 py-1.5`, `px-4 py-2`,
`px-2 py-1.5`, `px-4 py-3`. Reports use `px-4 py-3` th / `px-4 py-2` td (the `tdCls`
literal redeclared in all 7 report files). Payroll/admin tables use yet other values.

### Cards — inner padding + radius drift
Inner padding `p-3`/`p-4`/`p-5`/`p-6` no rule; radius `rounded`/`rounded-md`/`rounded-lg`
for visually-similar cards.

### Badges / pills
`px-2 py-0.5 rounded-full` vs `px-2 py-0.5 rounded` vs `px-1.5 py-0.5 rounded-full` for the
same status-pill role; per-feature color maps.

### Nav-item padding
✅ tabs `px-4 py-2.5 text-sm` (SubNav/TabBar/SettingsTabs) — but PayrollPeriodView tabs
`px-4 py-2` (off by .5) and finance hand-rolled navs `px-3 py-1.5 text-xs` (smaller).

---

## 6. Shared-component gaps & duplication (extract targets for Phase 3)

| Pattern | Copies | Locations | Replacement |
|---|---|---|---|
| **Underline-tab nav** | **4** | SubNav, TabBar, SettingsTabs, PayrollPeriodView (+4 finance hand-rolled navs: Sales/Statements/Settings/Payroll) | one shared tab primitive; SubNav (link) + TabBar (button) share it |
| Hand-rolled page header | ~24 | finance ×12, settings/auth ×9, payroll ×3 | adopt `PageHeader` |
| Error banner | ~12+ | finance ×5, reports ×7, core ×7, payroll | `<ErrorBanner>` |
| Modal shell | ~6+ | core ×3, production (`shared.tsx Modal` + 4 re-impls) | one `<Modal>` (fix `shared.tsx`) |
| Card/panel chrome | ~40+ | every area | `<Card>` |
| Primary/ghost/danger button | 100s | every area | `.btn-*` (reshaped) + adopt |
| Input/select | 100s | every area | `.inp` + adopt; delete `*Cls` consts |
| Report table chrome + `tdCls` + `currency()` | 7 | reports/components/* | `<ReportTable>` + `formatCurrency` util |
| Searchable CoA account picker | 3 | invoices `CoASelect`, square-transactions + account-mapping `AccountSelect` | shared `<AccountSelect>` (finance) |
| Statement table machinery (`buildTree`/`MoneyCell`/`MONTH_NAMES`…) | 3 | pl, cash-flow, balance-sheet | shared finance statement util/components |
| Money/number formatters (`currency`/`fmtUsd`/`formatCurrency`) | ~10 | reports + taproom tabs + finance | one `formatCurrency` util |
| Batch-color hex cycle | 2 | GanttTab, CalendarTab | one shared constant |
| Status/type badge color maps | 3 | `shared.tsx`, transfers, BatchLog | one shared semantic map + `StatusBadge` |
| Toggle/segmented control (`toggleBtn`) | ~4 | SalesPulseTab, AchievementTab | reuse TabBar or a `<SegmentedControl>` |
| Auth page shell | 2 | login, set-password (divergent min-height) | shared auth layout |
| `MONTH_NAMES`/`MONTH_LABELS` | 4 | pl, cash-flow, balance-sheet, square-transactions | one shared constant |

---

## Biggest consolidation decisions (require a ruling — see UI_STANDARD.md)
1. **Primary button identity:** solid amber (dominant) vs the token `.btn-amber` ghost
   style. If solid → `text-zinc-950` (a11y) or `text-white`?
2. **Page-title weight:** `font-medium` (PageHeader, ~19) vs `font-semibold` (~24).
3. **New semantic tokens:** add `success` (green) and `info` (blue)? Green is used as a
   first-class state everywhere with no token.
4. **Color migration depth:** full CSS-var rewrite of all ~5,000 raw classes vs.
   "lock the shade map + fix off-palette/wrong-shade/duplication only" (lower risk).
