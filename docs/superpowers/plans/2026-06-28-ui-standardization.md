# UI Standardization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the three structural UI inconsistencies (subtab style, page header placement, font sizes) and introduce two shared primitives (`PageHeader`, `TabBar`) that enforce the conventions going forward.

**Architecture:** Two new shared components under `app/components/` replace ad-hoc patterns. `PageHeader` renders the h2+description block that currently lives in different places. `TabBar` renders the state-driven tab strip that currently duplicates itself with inconsistent active text color. All production and taproom pages are updated to use these components; Finance sub-navs get their active color corrected inline (no new component needed there).

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4. No new dependencies.

## Global Constraints

- Never modify `app/components/NavBar.tsx` — it is being modified by `feature/payroll-shifts` in a separate worktree.
- Never modify `app/taproom/nav-config.ts` — same worktree conflict.
- Never modify `app/production/components/RecipeLinkMatrix.tsx` — being rewritten in `feature/sku-mapping-consolidation`.
- No API routes, no DB migrations, no business logic changes.
- Only cosmetic + structural changes: component extraction, class name corrections, header relocation.
- Verify with `npm run build` and `npm run lint` after every task.
- Active tab state in production subtabs stays in the component (do NOT push to URL) — not in scope.
- Consistent active tab color across the entire app: `text-amber-400 border-amber-500`. Currently state-based tabs use `text-zinc-100` (wrong); URL-based tabs use `text-amber-400` (correct).

---

## File Structure

### New files
- `app/components/PageHeader.tsx` — renders `<h2>` title + optional description paragraph. Used in every page that previously had an inline `<div className="mt-4 mb-2"><h2>...</h2><p>...</p></div>` block.
- `app/components/TabBar.tsx` — renders the state-driven tab strip with `button` elements. Replaces the five copies of the inline tab bar pattern scattered across production components. Active style is `text-amber-400 border-amber-500`.

### Modified files (production)
- `app/production/components/IntakeTab.tsx` — remove header block, replace inline tab bar with `<TabBar>`.
- `app/production/components/InventoryTab.tsx` — same.
- `app/production/components/ExportTab.tsx` — remove header block, replace inline tab bar with `<TabBar>`.
- `app/production/components/PartnersTab.tsx` — remove h2/p from header flex row, replace inline tab bar with `<TabBar>`.
- `app/production/intake/page.tsx` — add `<PageHeader>`.
- `app/production/inventory/page.tsx` — add `<PageHeader>`.
- `app/production/export/page.tsx` — add `<PageHeader>`.
- `app/production/partners/page.tsx` — add `<PageHeader>`.
- `app/production/recipes/page.tsx` — replace inline `div/h2/p` with `<PageHeader>`.
- `app/production/recipes/variations/page.tsx` — same.
- `app/production/recipes/brew-step-templates/page.tsx` — same.
- `app/production/brewing/floorplan/page.tsx` — same.
- `app/production/brewing/batch-log/page.tsx` — same.
- `app/production/brewing/timeline/page.tsx` — same.
- `app/production/brewing/calendar/page.tsx` — same.
- `app/production/brewing/transfers/page.tsx` — same (h2 is embedded inside a 210-line page file).
- `app/production/settings/deposits/page.tsx` — same.
- `app/production/settings/export/page.tsx` — same if h2 present (verify inline).

### Modified files (taproom)
- `app/taproom/performance/sales-pulse/page.tsx` — add `<PageHeader>`.
- `app/taproom/performance/draft-stats/page.tsx` — same.
- `app/taproom/performance/events/page.tsx` — same.
- `app/taproom/targets/achievement/page.tsx` — same.
- `app/taproom/targets/target-setting/page.tsx` — same.
- `app/taproom/targets/manual-entries/page.tsx` — same.
- `app/taproom/reports/page.tsx` — replace inline h2/p flex block with `<PageHeader>`.

### Modified files (finance + cleanup)
- `app/finance/settings/SettingsNav.tsx` — fix active: `text-zinc-100` → `text-amber-400`.
- `app/finance/transactions/TransactionsNav.tsx` — same.
- `app/finance/statements/StatementsNav.tsx` — same.
- `app/production/components/PackagingVariationsPanel.tsx` — replace `text-[10px]` / `text-[11px]` with `text-xs`.
- `app/taproom/components/EventsTab.tsx` — same.
- `app/taproom/components/DraftStatsTab.tsx` — same.
- `app/production/components/shared.tsx` — add `aria-label="Close"` to `×` close button.
- `app/production/components/RecipesTab.tsx` — change accordion header `<div onClick>` to `<button>`, add `aria-label` to variation remove buttons.

---

## Task 1: Shared primitives — PageHeader and TabBar

**Files:**
- Create: `app/components/PageHeader.tsx`
- Create: `app/components/TabBar.tsx`

**Interfaces:**
- Produces: `PageHeader({ title: string; description?: string })` — default export
- Produces: `TabBar<K extends string>({ tabs: TabDef<K>[]; activeKey: K; onSelect: (k: K) => void; sticky?: boolean; className?: string })` — default export
- Produces: `TabDef<K>` interface — named export from `TabBar.tsx`

- [ ] **Step 1: Create PageHeader**

```tsx
// app/components/PageHeader.tsx
export default function PageHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mt-4 mb-2">
      <h2 className="text-base font-medium text-zinc-100">{title}</h2>
      {description && <p className="text-sm text-zinc-500 mt-0.5">{description}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Create TabBar**

```tsx
// app/components/TabBar.tsx
"use client";
import { type ReactNode } from "react";

export interface TabDef<K extends string> {
  key: K;
  label: ReactNode;
}

export default function TabBar<K extends string>({
  tabs,
  activeKey,
  onSelect,
  sticky = false,
  className = "",
}: {
  tabs: TabDef<K>[];
  activeKey: K;
  onSelect: (key: K) => void;
  sticky?: boolean;
  className?: string;
}) {
  const stickyClasses = sticky
    ? "sticky top-[5.25rem] md:static z-30 bg-zinc-950/95 -mx-4 sm:mx-0 px-4 sm:px-0"
    : "";

  return (
    <div
      className={`flex gap-1 mb-6 border-b border-zinc-800 overflow-x-auto overflow-y-hidden scrollbar-none ${stickyClasses} ${className}`.trim()}
    >
      {tabs.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onSelect(key)}
          className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
            key === activeKey
              ? "text-amber-400 border-amber-500"
              : "text-zinc-500 border-transparent hover:text-zinc-300"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Verify build passes**

```bash
npm run build 2>&1 | tail -20
```

Expected: no errors (these are new files, nothing imports them yet).

- [ ] **Step 4: Commit**

```bash
git add app/components/PageHeader.tsx app/components/TabBar.tsx
git commit -m "feat(ui): add PageHeader and TabBar shared components"
```

---

## Task 2: Standardize production state-based tabs (Intake, Inventory, Export, Partners)

**Files:**
- Modify: `app/production/components/IntakeTab.tsx`
- Modify: `app/production/components/InventoryTab.tsx`
- Modify: `app/production/components/ExportTab.tsx`
- Modify: `app/production/components/PartnersTab.tsx`
- Modify: `app/production/intake/page.tsx`
- Modify: `app/production/inventory/page.tsx`
- Modify: `app/production/export/page.tsx`
- Modify: `app/production/partners/page.tsx`

**Interfaces:**
- Consumes: `TabBar` from `@/app/components/TabBar` (Task 1)
- Consumes: `PageHeader` from `@/app/components/PageHeader` (Task 1)

**What changes in each component:**
- Remove the `<div className="mt-4 mb-4"><h2>...</h2><p>...</p></div>` block.
- Replace the inline `<div className="flex gap-1 mb-6 border-b ...">` tab bar with `<TabBar>`.
- The corresponding `page.tsx` receives the header via `<PageHeader>`.

- [ ] **Step 1: Update IntakeTab — remove header, use TabBar**

In `app/production/components/IntakeTab.tsx`, replace everything from line 1 to just before the `return (` up to `</> )`:

The file currently starts with:
```tsx
"use client";
import { useState } from "react";
...

export default function IntakeTab() {
  ...
  return (
    <>
      <div className="mt-4 mb-4">
        <h2 className="text-base font-medium text-zinc-100">Intake</h2>
        <p className="text-sm text-zinc-500 mt-0.5">Demand planning across taproom, distribution, and contract brewing</p>
      </div>

      <div className="flex gap-1 mb-6 border-b border-zinc-800 sticky top-[5.25rem] md:static z-30 bg-zinc-950/95 -mx-4 sm:mx-0 px-4 sm:px-0 overflow-x-auto overflow-y-hidden scrollbar-none">
        {SUBTABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setSub(key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
              sub === key
                ? "border-amber-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      ...
    </>
  );
}
```

Add import at top:
```tsx
import TabBar, { type TabDef } from "@/app/components/TabBar";
```

Change `SUBTABS` type annotation to match `TabDef`:
```tsx
const SUBTABS: TabDef<IntakeSubtab>[] = [
  { key: "taproom",     label: "Taproom" },
  { key: "commitments", label: "Commitments" },
  { key: "safety",      label: "Safety Stock" },
  { key: "demand",      label: "Demand Calendar" },
  { key: "scheduler",   label: "Batch Scheduler" },
];
```

Replace the return block:
```tsx
  return (
    <>
      <TabBar tabs={SUBTABS} activeKey={sub} onSelect={setSub} sticky />
      {sub === "taproom"     && <TaproomTab recipes={recipes} />}
      {sub === "commitments" && <CommitmentsTab recipes={recipes} partners={partners} />}
      {sub === "safety"      && <SafetyStockTab recipes={recipes} transfers={transfers} tanks={tanks} batches={batches} />}
      {sub === "demand"      && <DemandCalendarTab />}
      {sub === "scheduler"   && <BatchSchedulerTab recipes={recipes} tanks={tanks} partners={partners} />}
    </>
  );
```

- [ ] **Step 2: Update intake/page.tsx — add PageHeader**

```tsx
// app/production/intake/page.tsx
"use client";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import IntakeTab from "@/app/production/components/IntakeTab";

export default function IntakePage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <PageHeader
        title="Intake"
        description="Demand planning across taproom, distribution, and contract brewing"
      />
      <IntakeTab />
    </main>
  );
}
```

- [ ] **Step 3: Update InventoryTab — remove header, use TabBar**

In `app/production/components/InventoryTab.tsx`:

Add import:
```tsx
import TabBar, { type TabDef } from "@/app/components/TabBar";
```

Change `SUBTAB_LABELS` to a `TabDef` array:
```tsx
const SUBTABS: TabDef<SubTab>[] = [
  { key: "ingredients", label: "Ingredients" },
  { key: "packaging",   label: "Packaging" },
  { key: "adjustments", label: "Stock Adjustments" },
];
```

Replace the return block (remove old `SUBTAB_LABELS` record and the header div, replace the tab div):
```tsx
export default function InventoryTab() {
  const [sub, setSub] = useState<SubTab>("ingredients");

  return (
    <>
      <TabBar tabs={SUBTABS} activeKey={sub} onSelect={setSub} sticky />
      {sub === "ingredients"  && <IngredientsTab />}
      {sub === "packaging"    && <PackagingTab />}
      {sub === "adjustments"  && <StockAdjustmentsTab />}
    </>
  );
}
```

- [ ] **Step 4: Update inventory/page.tsx — add PageHeader**

```tsx
// app/production/inventory/page.tsx
"use client";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import InventoryTab from "@/app/production/components/InventoryTab";

export default function InventoryPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <PageHeader
        title="Inventory"
        description="Ingredients, packaging materials, and stock adjustments"
      />
      <InventoryTab />
    </main>
  );
}
```

- [ ] **Step 5: Update ExportTab — remove header, use TabBar**

In `app/production/components/ExportTab.tsx`, find the section around line 198–228:

```tsx
      {/* Header */}
      <div className="mt-4 mb-4">
        <h2 className="text-base font-medium text-zinc-100">Export</h2>
        <p className="text-sm text-zinc-500 mt-0.5">Commitments and fulfillment — track what has been allocated and what has shipped.</p>
      </div>

      {/* Top tab bar */}
      <div className="flex gap-1 mb-6 border-b border-zinc-800 overflow-x-auto overflow-y-hidden scrollbar-none">
        {TOP_TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === key
                ? "border-amber-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {label}
            {key === "taproom" && (
              <span className="ml-1.5 text-xs text-zinc-600">
                ({exports.filter(e => e.channel === key).length})
              </span>
            )}
          </button>
        ))}
      </div>
```

Add import at top of file:
```tsx
import TabBar, { type TabDef } from "@/app/components/TabBar";
```

Change `TOP_TABS` from a plain array to a `TabDef` array constructed inside the component (since the taproom tab needs a live count). Move the array inside the component function, after `exports` is available:

```tsx
// Inside ExportTab component, after `const [tab, setTab] = ...`:
const topTabs: TabDef<TopTab>[] = [
  { key: "export_bay",          label: "Export Bay" },
  {
    key: "taproom",
    label: (
      <>
        Taproom{" "}
        <span className="ml-1.5 text-xs text-zinc-600">
          ({exports.filter((e) => e.channel === "taproom").length})
        </span>
      </>
    ),
  },
  { key: "export_transactions", label: "Export Transactions" },
];
```

Remove the old `TOP_TABS` constant outside the component. Replace the header div + tab bar div with:

```tsx
      <TabBar tabs={topTabs} activeKey={tab} onSelect={setTab} />
```

- [ ] **Step 6: Update export/page.tsx — add PageHeader**

```tsx
// app/production/export/page.tsx
"use client";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import ExportTab from "@/app/production/components/ExportTab";

export default function ExportPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <PageHeader
        title="Export"
        description="Commitments and fulfillment — track what has been allocated and what has shipped."
      />
      <ExportTab />
    </main>
  );
}
```

- [ ] **Step 7: Update PartnersTab — remove h2/p, use TabBar**

In `app/production/components/PartnersTab.tsx`, find the return block around line 317:

```tsx
      {/* Header + kind switcher */}
      <div className="flex items-center justify-between mt-4 mb-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">Partners</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Contract brewing partners and ingredient/packaging suppliers</p>
        </div>
        <div className="flex gap-2">
          {kind === "contract" && (
            <button onClick={openSquareImport} className="btn-amber">
              ↓ Import from Square
            </button>
          )}
          <button onClick={openNew} className="btn-amber">+ New {kindLabel}</button>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 mb-5 border-b border-zinc-800">
        {(["contract", "supplier"] as PartnerKind[]).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              kind === k
                ? "border-amber-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {k === "contract" ? "Contract Brewing" : "Suppliers"}
            <span className="ml-1.5 text-xs text-zinc-600">
              ({k === "contract" ? contractPartners.length : suppliers.length})
            </span>
          </button>
        ))}
      </div>
```

Add import at top:
```tsx
import TabBar, { type TabDef } from "@/app/components/TabBar";
```

Add inside the component (before return):
```tsx
  const kindTabs: TabDef<PartnerKind>[] = [
    {
      key: "contract",
      label: (
        <>
          Contract Brewing{" "}
          <span className="ml-1.5 text-xs text-zinc-600">({contractPartners.length})</span>
        </>
      ),
    },
    {
      key: "supplier",
      label: (
        <>
          Suppliers{" "}
          <span className="ml-1.5 text-xs text-zinc-600">({suppliers.length})</span>
        </>
      ),
    },
  ];
```

Replace the header div + tab switcher div with:
```tsx
      {/* Action buttons */}
      <div className="flex justify-end gap-2 mb-4">
        {kind === "contract" && (
          <button onClick={openSquareImport} className="btn-amber">
            ↓ Import from Square
          </button>
        )}
        <button onClick={openNew} className="btn-amber">+ New {kindLabel}</button>
      </div>

      <TabBar tabs={kindTabs} activeKey={kind} onSelect={setKind} />
```

- [ ] **Step 8: Update partners/page.tsx — add PageHeader**

```tsx
// app/production/partners/page.tsx
"use client";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import PartnersTab from "@/app/production/components/PartnersTab";

export default function PartnersPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <PageHeader
        title="Partners"
        description="Contract brewing partners and ingredient/packaging suppliers"
      />
      <PartnersTab />
    </main>
  );
}
```

- [ ] **Step 9: Build and lint**

```bash
npm run build 2>&1 | tail -30
npm run lint 2>&1 | tail -20
```

Expected: no TypeScript or lint errors.

- [ ] **Step 10: Commit**

```bash
git add \
  app/production/components/IntakeTab.tsx \
  app/production/components/InventoryTab.tsx \
  app/production/components/ExportTab.tsx \
  app/production/components/PartnersTab.tsx \
  app/production/intake/page.tsx \
  app/production/inventory/page.tsx \
  app/production/export/page.tsx \
  app/production/partners/page.tsx
git commit -m "refactor(ui): extract headers to page.tsx and standardize tab bars in production"
```

---

## Task 3: Replace inline h2/p blocks with PageHeader across production URL-routed pages

These pages already have the header in the right location (page.tsx between two SubNavs) — this task only replaces the verbose `<div className="mt-4 mb-2"><h2>...</h2><p>...</p></div>` with `<PageHeader>`.

**Files:**
- Modify: `app/production/recipes/page.tsx`
- Modify: `app/production/recipes/variations/page.tsx`
- Modify: `app/production/recipes/brew-step-templates/page.tsx`
- Modify: `app/production/brewing/floorplan/page.tsx`
- Modify: `app/production/brewing/batch-log/page.tsx`
- Modify: `app/production/brewing/timeline/page.tsx`
- Modify: `app/production/brewing/calendar/page.tsx`
- Modify: `app/production/brewing/transfers/page.tsx`
- Modify: `app/production/settings/deposits/page.tsx`
- Modify: `app/production/settings/export/page.tsx` (verify h2 present first)

**Interfaces:**
- Consumes: `PageHeader` from `@/app/components/PageHeader` (Task 1)

**Pattern:** In every file, add `import PageHeader from "@/app/components/PageHeader";` and replace:
```tsx
<div className="mt-4 mb-2">
  <h2 className="text-base font-medium text-zinc-100">{TITLE}</h2>
  <p className="text-sm text-zinc-500 mt-0.5">{DESCRIPTION}</p>
</div>
```
with:
```tsx
<PageHeader title="{TITLE}" description="{DESCRIPTION}" />
```

The exact titles and descriptions for each file:

| File | title | description |
|---|---|---|
| `recipes/page.tsx` | `"Recipes"` | `"Beer recipes, packaging variations, and brew step templates"` |
| `recipes/variations/page.tsx` | `"Recipes"` | `"Beer recipes, packaging variations, and brew step templates"` |
| `recipes/brew-step-templates/page.tsx` | `"Recipes"` | `"Beer recipes, packaging variations, and brew step templates"` |
| `brewing/floorplan/page.tsx` | `"Brewing"` | `"Batch tracking, fermentation monitoring, and equipment scheduling"` |
| `brewing/batch-log/page.tsx` | `"Brewing"` | `"Batch tracking, fermentation monitoring, and equipment scheduling"` |
| `brewing/timeline/page.tsx` | `"Brewing"` | `"Batch tracking, fermentation monitoring, and equipment scheduling"` |
| `brewing/calendar/page.tsx` | `"Brewing"` | `"Batch tracking, fermentation monitoring, and equipment scheduling"` |
| `brewing/transfers/page.tsx` | `"Brewing"` | `"Batch tracking, fermentation monitoring, and equipment scheduling"` |
| `settings/deposits/page.tsx` | `"Settings"` | `"Deposits, export configuration, and Square integrations"` |
| `settings/export/page.tsx` | `"Settings"` | `"Deposits, export configuration, and Square integrations"` |

Note: `brewing/transfers/page.tsx` is 210 lines with all content in a single page file (no separate component). The h2 block is at approximately line 86. Replace only that block; leave everything else unchanged.

Note: `settings/export/page.tsx` — verify h2 is present before editing. If it uses the same pattern, apply the same substitution.

- [ ] **Step 1: Update all 10 files**

Apply the pattern above to each file. For `transfers/page.tsx`, confirm the h2 block location with:
```bash
grep -n "h2\|mt-4 mb-2" app/production/brewing/transfers/page.tsx
```
Then replace only that block.

For `settings/export/page.tsx`, confirm h2 presence:
```bash
grep -n "h2\|text-base" app/production/settings/export/page.tsx
```
Apply substitution if present.

- [ ] **Step 2: Build and lint**

```bash
npm run build 2>&1 | tail -30
npm run lint 2>&1 | tail -20
```

- [ ] **Step 3: Commit**

```bash
git add \
  app/production/recipes/page.tsx \
  app/production/recipes/variations/page.tsx \
  app/production/recipes/brew-step-templates/page.tsx \
  app/production/brewing/floorplan/page.tsx \
  app/production/brewing/batch-log/page.tsx \
  app/production/brewing/timeline/page.tsx \
  app/production/brewing/calendar/page.tsx \
  app/production/brewing/transfers/page.tsx \
  app/production/settings/deposits/page.tsx \
  app/production/settings/export/page.tsx
git commit -m "refactor(ui): replace inline h2/p header blocks with PageHeader across production pages"
```

---

## Task 4: Add PageHeader to all taproom pages

Taproom pages currently have **no section header at all** — just a primary `<SubNav>` then a secondary `<SubNav>` then the component. This task adds a `<PageHeader>` between the two SubNavs, matching the established production pattern.

**Files:**
- Modify: `app/taproom/performance/sales-pulse/page.tsx`
- Modify: `app/taproom/performance/draft-stats/page.tsx`
- Modify: `app/taproom/performance/events/page.tsx`
- Modify: `app/taproom/targets/achievement/page.tsx`
- Modify: `app/taproom/targets/target-setting/page.tsx`
- Modify: `app/taproom/targets/manual-entries/page.tsx`
- Modify: `app/taproom/reports/page.tsx`

**Interfaces:**
- Consumes: `PageHeader` from `@/app/components/PageHeader` (Task 1)

**Pattern for performance pages:** Insert `<PageHeader>` between `<SubNav entries={TAPROOM_NAV} mobile />` and `<SubNav entries={PERFORMANCE_NAV} sticky />`.

**Pattern for targets pages:** Insert `<PageHeader>` between `<SubNav entries={TAPROOM_NAV} mobile />` and `<SubNav entries={TARGETS_NAV} sticky />`.

**Pattern for reports page:** Replace the existing inline `div/h2/p` block (which wraps both the title and the controls row) — extract only the h2/p part into `<PageHeader>`, keep the controls row below.

The current `app/taproom/reports/page.tsx` header block is:
```tsx
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">Reports</h2>
          <p className="text-sm text-zinc-500 mt-0.5">
            Net sales, cocktail, keg, gift card, production, and inventory reports
          </p>
        </div>
      </div>
```
Replace with:
```tsx
      <PageHeader
        title="Reports"
        description="Net sales, cocktail, keg, gift card, production, and inventory reports"
      />
```
(The outer flex container with no right-side content adds no visual value — remove it.)

Titles and descriptions per page:

| File | title | description |
|---|---|---|
| `performance/sales-pulse/page.tsx` | `"Performance"` | `"Sales trends, draft throughput, and event summaries"` |
| `performance/draft-stats/page.tsx` | `"Performance"` | `"Sales trends, draft throughput, and event summaries"` |
| `performance/events/page.tsx` | `"Performance"` | `"Sales trends, draft throughput, and event summaries"` |
| `targets/achievement/page.tsx` | `"Targets"` | `"Sales goals, achievement tracking, and manual entries"` |
| `targets/target-setting/page.tsx` | `"Targets"` | `"Sales goals, achievement tracking, and manual entries"` |
| `targets/manual-entries/page.tsx` | `"Targets"` | `"Sales goals, achievement tracking, and manual entries"` |
| `reports/page.tsx` | `"Reports"` | `"Net sales, cocktail, keg, gift card, production, and inventory reports"` |

- [ ] **Step 1: Update all 7 files**

For each of the 6 performance/targets pages, add the import and insert `<PageHeader>` between the two `<SubNav>` elements. For `reports/page.tsx`, also add the import and replace the existing inline block.

- [ ] **Step 2: Build and lint**

```bash
npm run build 2>&1 | tail -30
npm run lint 2>&1 | tail -20
```

- [ ] **Step 3: Commit**

```bash
git add \
  app/taproom/performance/sales-pulse/page.tsx \
  app/taproom/performance/draft-stats/page.tsx \
  app/taproom/performance/events/page.tsx \
  app/taproom/targets/achievement/page.tsx \
  app/taproom/targets/target-setting/page.tsx \
  app/taproom/targets/manual-entries/page.tsx \
  app/taproom/reports/page.tsx
git commit -m "feat(ui): add PageHeader to all taproom pages"
```

---

## Task 5: Finance nav color, font size cleanup, and accessibility

**Files:**
- Modify: `app/finance/settings/SettingsNav.tsx`
- Modify: `app/finance/transactions/TransactionsNav.tsx`
- Modify: `app/finance/statements/StatementsNav.tsx`
- Modify: `app/production/components/PackagingVariationsPanel.tsx`
- Modify: `app/taproom/components/EventsTab.tsx`
- Modify: `app/taproom/components/DraftStatsTab.tsx`
- Modify: `app/production/components/shared.tsx`
- Modify: `app/production/components/RecipesTab.tsx`

**Interfaces:** No new interfaces — purely in-place fixes.

- [ ] **Step 1: Fix Finance sub-nav active text color**

In all three Finance nav components (`SettingsNav.tsx`, `TransactionsNav.tsx`, `StatementsNav.tsx`), find the active class:
```tsx
? "text-zinc-100 border-amber-500"
```
Replace with:
```tsx
? "text-amber-400 border-amber-500"
```

Each file has exactly one occurrence of this pattern in the active ternary.

- [ ] **Step 2: Fix non-standard font sizes in PackagingVariationsPanel**

In `app/production/components/PackagingVariationsPanel.tsx`:

2a. In the `Chips` component (line ~51), change `text-[11px]` → `text-xs`:
```tsx
// Before:
className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${...}`}
// After:
className={`text-xs px-2 py-0.5 rounded border transition-colors ${...}`}
```

2b. In the `ComponentPill` component (line ~73), change `text-[10px]` → `text-xs`:
```tsx
// Before:
<span className={`text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap ${...}`}>
// After:
<span className={`text-xs px-1.5 py-0.5 rounded border whitespace-nowrap ${...}`}>
```

2c. In the table body container type badges (lines ~342–345), change `text-[10px]` → `text-xs`:
```tsx
// Before (Keg badge):
<span className="text-[10px] px-1.5 py-0.5 rounded border border-orange-700 bg-orange-900/30 text-orange-300 font-medium uppercase shrink-0">Keg</span>
// After:
<span className="text-xs px-1.5 py-0.5 rounded border border-orange-700 bg-orange-900/30 text-orange-300 font-medium uppercase shrink-0">Keg</span>

// Before (Can badge):
<span className="text-[10px] px-1.5 py-0.5 rounded border border-blue-700 bg-blue-900/30 text-blue-300 font-medium uppercase shrink-0">Can</span>
// After:
<span className="text-xs px-1.5 py-0.5 rounded border border-blue-700 bg-blue-900/30 text-blue-300 font-medium uppercase shrink-0">Can</span>
```

Verify no remaining `text-[10px]` or `text-[11px]` in the file:
```bash
grep -n "text-\[1[01]px\]" app/production/components/PackagingVariationsPanel.tsx
```
Expected: no output.

- [ ] **Step 3: Fix non-standard font sizes in EventsTab**

In `app/taproom/components/EventsTab.tsx`, replace all occurrences of `text-[10px]` with `text-xs` and `text-[11px]` with `text-xs`:

```bash
# Count occurrences first to verify:
grep -c "text-\[10px\]\|text-\[11px\]" app/taproom/components/EventsTab.tsx
```

Use find-and-replace-all for each pattern (8+ occurrences). The contexts are form field labels, stat labels, and list item text — all should be `text-xs` (same visual weight, standard Tailwind class).

After replacement:
```bash
grep -n "text-\[1[01]px\]" app/taproom/components/EventsTab.tsx
```
Expected: no output.

- [ ] **Step 4: Fix non-standard font sizes in DraftStatsTab**

In `app/taproom/components/DraftStatsTab.tsx`, replace all `text-[10px]` with `text-xs`:

```bash
grep -c "text-\[10px\]" app/taproom/components/DraftStatsTab.tsx
```

Replace all occurrences (3 occurrences: two badges, one filter button). After:
```bash
grep -n "text-\[10px\]" app/taproom/components/DraftStatsTab.tsx
```
Expected: no output.

- [ ] **Step 5: Add aria-label to modal close button in shared.tsx**

In `app/production/components/shared.tsx`, find the modal `×` close button (line ~50):
```tsx
// Before:
<button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-lg leading-none">
  ×
</button>
// After:
<button onClick={onClose} aria-label="Close" className="text-zinc-500 hover:text-zinc-300 text-lg leading-none">
  ×
</button>
```

- [ ] **Step 6: Fix accordion row and variation remove button in RecipesTab**

In `app/production/components/RecipesTab.tsx`:

6a. The accordion header row (line ~271) uses a `<div onClick>`. Replace with `<button>`:
```tsx
// Before (line ~271):
<div
  className="px-4 py-3 cursor-pointer hover:bg-zinc-900/40 transition-colors"
  onClick={() => setExpanded(isOpen ? null : r.id)}
>
// After:
<button
  type="button"
  className="w-full text-left px-4 py-3 hover:bg-zinc-900/40 transition-colors"
  onClick={() => setExpanded(isOpen ? null : r.id)}
>
```
Also change the closing `</div>` for this element to `</button>`. The `cursor-pointer` class is no longer needed since `<button>` has a pointer cursor by default.

6b. The variation chip remove button (line ~467) is missing `aria-label`:
```tsx
// Before:
<button onClick={() => unlinkVariation(link.id)} className="text-zinc-600 hover:text-red-400 leading-none">×</button>
// After:
<button
  onClick={() => unlinkVariation(link.id)}
  aria-label={`Remove ${link.packaging_variations?.name ?? "variation"}`}
  className="text-zinc-600 hover:text-red-400 leading-none"
>
  ×
</button>
```

- [ ] **Step 7: Build and lint**

```bash
npm run build 2>&1 | tail -30
npm run lint 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add \
  app/finance/settings/SettingsNav.tsx \
  app/finance/transactions/TransactionsNav.tsx \
  app/finance/statements/StatementsNav.tsx \
  app/production/components/PackagingVariationsPanel.tsx \
  app/taproom/components/EventsTab.tsx \
  app/taproom/components/DraftStatsTab.tsx \
  app/production/components/shared.tsx \
  app/production/components/RecipesTab.tsx
git commit -m "fix(ui): standardize font sizes, finance nav colors, and accessibility labels"
```

---

## Self-Review

**Spec coverage check:**
- ✓ Two subtab styles → TabBar component with `text-amber-400` active color used in all state-based tabs
- ✓ Header inconsistency → PageHeader in page.tsx for all production and taproom pages
- ✓ Button sizing mismatches → not fully addressed — the Chips/filter button height difference vs search input was noted in review but this plan defers button height normalization (`.btn-sm` CSS class) to a follow-up: the `text-[11px]` → `text-xs` fix in step 5 partially closes the gap, and the Chips buttons share the same `py-0.5` as before. Full button grid normalization (search bar + Chips at same visual height) is a layout decision left for a future plan.
- ✓ Font size inconsistency → all `text-[10px]` and `text-[11px]` replaced with `text-xs` across 3 files
- ✓ Finance active color → fixed in 3 nav components
- ✓ Accessibility → `aria-label` on close buttons, accordion `<div>` → `<button>`

**Placeholder scan:** No TBDs, no "implement later", all code shown.

**Conflict check:**
- `app/components/NavBar.tsx` — NOT touched (payroll branch owns it)
- `app/taproom/nav-config.ts` — NOT touched (payroll branch owns it)
- `app/production/components/RecipeLinkMatrix.tsx` — NOT touched (SKU branch owns it)
- All new files (`PageHeader.tsx`, `TabBar.tsx`) are net-new and have no conflicts

**Note on FinanceNav desktop style:** The `app/finance/FinanceNav.tsx` desktop variant uses a pill style (`bg-zinc-800 text-zinc-100` rounded, no border-bottom). This is intentional — Finance has a compact horizontal pill nav below the mobile bar — and is left unchanged. Only the sub-level navs (Settings, Transactions, Statements) are standardized.
