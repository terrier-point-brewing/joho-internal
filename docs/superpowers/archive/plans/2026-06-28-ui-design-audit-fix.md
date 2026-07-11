# UI Design Audit Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all visual inconsistencies identified in the 2026-06-28 UI audit: fix the broken Geist font, add a CSS token layer, consolidate 3 duplicate nav implementations into SubNav, align SettingsTabs with the app-wide underline style, normalize input/button sizes, and add focus rings.

**Architecture:** Changes are layered bottom-up: globals.css gets the token system first, then shared components are updated to use tokens, then duplicate nav implementations are replaced with the shared `SubNav`, then page-level ad-hoc patterns are normalized.

**Tech Stack:** Next.js App Router, Tailwind CSS v4, TypeScript, `app/globals.css` for shared CSS classes.

## Global Constraints

- No functional behavior, routing logic, or data fetching changes.
- No copy/content changes.
- All Tailwind arbitrary values (`text-[10px]`, `w-7`) are acceptable; only off-scale standalone values (e.g. `text-[9px]`, `font-size: 0.85rem`) need replacement.
- Dark theme only — no light mode changes.
- Worktree: `/Users/will-liao/Desktop/Coding/Git/tpb-square-reports/.claude/worktrees/naughty-black-cdee28`

---

### Task 1: CSS Foundation — Font, Tokens, Focus Rings

**Files:**
- Modify: `app/globals.css`

**Interfaces:**
- Produces: CSS custom properties `--color-surface`, `--color-border`, `--color-text-primary`, `--color-text-muted`, `--color-accent`, `--color-accent-muted`, `--color-danger`; updated `.btn-*` and `.inp` with focus-visible rings and font var

**Findings addressed:** T1, C1, C2, G1, G2

- [ ] **Step 1: Apply Geist font to body**

  In `app/globals.css`, change the `body` rule's `font-family`:

  ```css
  body {
    background: #09090b;
    color: #f4f4f5;
    font-family: var(--font-geist-sans), Arial, Helvetica, sans-serif;
  }
  ```

- [ ] **Step 2: Add CSS custom property token layer**

  Add after the `@import "tailwindcss";` line, before `:root`:

  ```css
  :root {
    color-scheme: dark;

    /* Surface */
    --color-bg:            #09090b; /* zinc-950 */
    --color-surface:       #18181b; /* zinc-900 */
    --color-surface-mid:   #27272a; /* zinc-800 */
    --color-surface-high:  #3f3f46; /* zinc-700 */

    /* Borders */
    --color-border:        #27272a; /* zinc-800 */
    --color-border-mid:    #3f3f46; /* zinc-700 */
    --color-border-subtle: #52525b; /* zinc-600 */

    /* Text */
    --color-text-primary:  #f4f4f5; /* zinc-100 */
    --color-text-secondary:#a1a1aa; /* zinc-400 */
    --color-text-muted:    #71717a; /* zinc-500 */
    --color-text-faint:    #52525b; /* zinc-600 */

    /* Accent (amber) */
    --color-accent:        #fbbf24; /* amber-400 */
    --color-accent-border: #d97706; /* amber-600 */
    --color-accent-bg:     rgb(120 53 15 / 0.3);
    --color-accent-text:   #fcd34d; /* amber-300 */

    /* Danger */
    --color-danger:        #fca5a5; /* red-300 */
    --color-danger-border: #b91c1c; /* red-700 */
    --color-danger-bg:     rgb(69 10 10 / 0.3);
  }
  ```

  Remove the old separate `:root { color-scheme: dark; }` block.

- [ ] **Step 3: Rewrite .btn-* using CSS vars + focus-visible**

  Replace the entire `@layer components` block content (keep the layer wrapper):

  ```css
  @layer components {

  /* ── Button tiers ─────────────────────────────────────────────────────── */

  /* md (default) */
  .btn-amber {
    padding: 0.375rem 0.75rem;
    background: var(--color-accent-bg);
    color: var(--color-accent-text);
    font-size: 0.875rem;
    font-weight: 500;
    border-radius: 0.375rem;
    border: 1px solid var(--color-accent-border);
    transition: background 0.15s;
    cursor: pointer;
  }
  .btn-amber:hover:not(:disabled) { background: rgb(120 53 15 / 0.5); }
  .btn-amber:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-amber:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }

  .btn-ghost {
    padding: 0.375rem 0.75rem;
    background: var(--color-surface-mid);
    color: var(--color-text-secondary);
    font-size: 0.875rem;
    font-weight: 500;
    border-radius: 0.375rem;
    border: 1px solid var(--color-surface-high);
    transition: color 0.15s, border-color 0.15s;
    cursor: pointer;
  }
  .btn-ghost:hover:not(:disabled) { color: #e4e4e7; border-color: var(--color-border-subtle); }
  .btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-ghost:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }

  .btn-danger {
    padding: 0.375rem 0.75rem;
    background: var(--color-danger-bg);
    color: var(--color-danger);
    font-size: 0.875rem;
    font-weight: 500;
    border-radius: 0.375rem;
    border: 1px solid var(--color-danger-border);
    transition: background 0.15s;
    cursor: pointer;
  }
  .btn-danger:hover:not(:disabled) { background: rgb(69 10 10 / 0.5); }
  .btn-danger:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-danger:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }

  /* sm tier — for dense table toolbars */
  .btn-sm {
    padding: 0.25rem 0.625rem;
    font-size: 0.75rem;
    font-weight: 500;
    border-radius: 0.375rem;
    border: 1px solid var(--color-border-mid);
    background: var(--color-surface-mid);
    color: var(--color-text-primary);
    transition: background 0.15s;
    cursor: pointer;
  }
  .btn-sm:hover:not(:disabled) { background: var(--color-surface-high); }
  .btn-sm:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-sm:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }

  /* ── Input ────────────────────────────────────────────────────────────── */

  .inp {
    width: 100%;
    background: var(--color-surface-mid);
    border: 1px solid var(--color-surface-high);
    border-radius: 0.375rem;
    padding: 0.375rem 0.5rem;
    font-size: 0.875rem;
    color: var(--color-text-primary);
    outline: none;
    touch-action: manipulation;
  }
  .inp:focus { border-color: var(--color-border-subtle); }
  .inp:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
  .inp option { background: var(--color-surface-mid); }

  } /* end @layer components */
  ```

- [ ] **Step 4: Fix .prose-steps off-scale font sizes**

  Replace the `.prose-steps` block at the bottom of globals.css:

  ```css
  /* Markdown brew steps rendering */
  .prose-steps h1, .prose-steps h2, .prose-steps h3 {
    color: #d4d4d8; font-weight: 600; margin: 0.25rem 0 0.1rem;
  }
  .prose-steps h1 { font-size: 0.875rem; } /* text-sm */
  .prose-steps h2 { font-size: 0.8125rem; } /* between text-xs and text-sm */
  .prose-steps h3 { font-size: 0.75rem; } /* text-xs */
  .prose-steps p  { margin: 0.15rem 0; }
  .prose-steps ul { list-style: none; padding: 0; margin: 0.1rem 0; }
  .prose-steps li { padding-left: 1rem; position: relative; margin: 0.1rem 0; }
  .prose-steps li::before { content: "·"; position: absolute; left: 0.25rem; color: var(--color-text-faint); }
  .prose-steps strong { color: #e4e4e7; font-weight: 600; }
  .prose-steps em { color: var(--color-text-secondary); font-style: italic; }
  .prose-steps code { font-family: var(--font-geist-mono), monospace; background: var(--color-surface-mid); color: #d4d4d8; padding: 0.1rem 0.25rem; border-radius: 0.2rem; font-size: 0.75rem; }
  ```

- [ ] **Step 5: Visual verify**

  Run `npm run dev` in the worktree, open the app. Confirm:
  - Body font is now Geist (sans-serif, geometric) rather than Arial
  - Buttons and inputs look identical to before
  - Focus rings appear when tabbing through interactive elements

---

### Task 2: Consolidate FinanceNav → SubNav

**Files:**
- Modify: `app/finance/FinanceNav.tsx`
- Read: `app/finance/nav-config.ts` (to check type compatibility)
- Read: `app/components/SubNav.tsx` (to confirm NavEntry type)

**Findings addressed:** P2

`FinanceNav` is a custom nav component that duplicates `SubNav`'s logic and style. Replace it entirely with `SubNav`.

- [ ] **Step 1: Check nav-config type compatibility**

  Read `app/finance/nav-config.ts` and `app/taproom/nav-config.ts` and confirm both export a type/interface compatible with `NavEntry` from SubNav (needs: `href`, `label`, optional `match`, optional `exact`, optional `adminOnly`, optional `managerOnly`).

  If `nav-config.ts` exports a different interface, add the missing optional fields with sensible defaults.

- [ ] **Step 2: Rewrite FinanceNav.tsx to use SubNav**

  ```tsx
  "use client";
  import SubNav from "@/app/components/SubNav";
  import { FINANCE_NAV } from "./nav-config";

  export default function FinanceNav({ mobile = false }: { mobile?: boolean }) {
    return <SubNav entries={FINANCE_NAV} mobile={mobile} />;
  }
  ```

- [ ] **Step 3: Visual verify**

  Open `/finance/invoices` on mobile and desktop. Confirm the finance top nav renders identically to before (amber underline active state, zinc-500 inactive).

---

### Task 3: Consolidate TransactionsNav → SubNav

**Files:**
- Modify: `app/finance/transactions/TransactionsNav.tsx`
- Read: `app/components/SubNav.tsx` (NavEntry interface)

**Findings addressed:** P3

`TransactionsNav` is a third custom nav implementation. It uses `text-xs` instead of `text-sm` — replace with `SubNav` to get the standard `text-sm` styling.

- [ ] **Step 1: Check TransactionsNav usage**

  Grep for `TransactionsNav` to find all import sites:
  ```bash
  grep -rn "TransactionsNav" app/
  ```

- [ ] **Step 2: Rewrite TransactionsNav.tsx to use SubNav**

  ```tsx
  "use client";
  import SubNav from "@/app/components/SubNav";

  const TABS = [
    { href: "/finance/transactions/square-transactions", label: "POS Transactions" },
    { href: "/finance/invoices",                         label: "Invoices"          },
  ];

  export default function TransactionsNav() {
    return <SubNav entries={TABS} />;
  }
  ```

- [ ] **Step 3: Visual verify**

  Open `/finance/invoices`. Confirm the POS Transactions / Invoices subtab bar renders with standard `text-sm` (not `text-xs`) and amber underline active state.

---

### Task 4: Align SettingsTabs with App-Wide Tab Style

**Files:**
- Modify: `app/settings/SettingsTabs.tsx`

**Findings addressed:** P1, T4, G3

`SettingsTabs` uses a pill/background-highlight style (`bg-zinc-800 rounded-t`) inconsistent with the amber underline used everywhere else. It also uses `<h1 className="text-lg">` while all other page headings are `text-base`.

- [ ] **Step 1: Rewrite SettingsTabs.tsx**

  ```tsx
  "use client";

  import Link from "next/link";
  import { usePathname } from "next/navigation";
  import { useEffect, useState } from "react";

  export default function SettingsTabs({ isAdmin }: { isAdmin: boolean }) {
    const pathname = usePathname();
    const [pendingCount, setPendingCount] = useState(0);

    useEffect(() => {
      if (!isAdmin) return;
      fetch("/api/admin/requests")
        .then((r) => r.ok ? r.json() : [])
        .then((data: { status: string }[]) =>
          setPendingCount(data.filter((r) => r.status === "pending").length)
        )
        .catch(() => {});
    }, [isAdmin]);

    const tabs = [
      { label: "Account", href: "/settings/account", badge: 0 },
      ...(isAdmin ? [
        { label: "Users", href: "/settings/users", badge: 0 },
        { label: "Access Requests", href: "/settings/requests", badge: pendingCount },
      ] : []),
    ];

    return (
      <div className="px-4 sm:px-6 pt-4 sm:pt-6">
        <h1 className="text-base font-semibold text-zinc-100 mb-4">Settings</h1>
        <div className="flex gap-1 border-b border-zinc-800 overflow-x-auto overflow-y-hidden scrollbar-none" role="tablist">
          {tabs.map(({ label, href, badge }) => {
            const active = pathname === href || pathname.startsWith(href + "/");
            return (
              <Link
                key={href}
                href={href}
                role="tab"
                aria-selected={active}
                className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px flex items-center gap-1.5 ${
                  active
                    ? "text-amber-400 border-amber-500"
                    : "text-zinc-500 border-transparent hover:text-zinc-300"
                }`}
              >
                {label}
                {badge > 0 && (
                  <span className="text-xs bg-amber-500 text-zinc-950 font-bold rounded-full px-1.5 py-0.5 leading-none">
                    {badge}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 2: Visual verify**

  Open `/settings/account`. Confirm:
  - "Settings" heading is `text-base` (same as other page headings)
  - Account / Users / Access Requests tabs use amber underline active style
  - Badge still renders on "Access Requests" when there are pending requests

---

### Task 5: Normalize Finance Invoices Page Header

**Files:**
- Modify: `app/finance/invoices/page.tsx`

**Findings addressed:** T5, P4, Sp1

The invoices page has a custom bordered header div with a raw `<h1>`. Replace it with `PageHeader` and move the filters to a toolbar strip below.

- [ ] **Step 1: Add PageHeader import**

  At the top of `app/finance/invoices/page.tsx`, add:
  ```tsx
  import PageHeader from "@/app/components/PageHeader";
  ```

- [ ] **Step 2: Replace the custom header div**

  Find the `{/* Header */}` section (around line 643):
  ```tsx
  {/* Header */}
  <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-4 border-b border-zinc-800">
    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
      <div>
        <h1 className="text-base font-semibold text-zinc-100">Invoices</h1>
        <p className="text-xs text-zinc-500 mt-0.5">Square and QuickBooks invoices · map line items to GL accounts</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        ...filters...
      </div>
    </div>
  </div>
  ```

  Replace with:
  ```tsx
  {/* Header */}
  <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-6">
    <PageHeader
      title="Invoices"
      description="Square and QuickBooks invoices · map line items to GL accounts"
    />
  </div>
  <div className="shrink-0 px-4 sm:px-6 pb-4 border-b border-zinc-800">
    <div className="flex flex-wrap items-center gap-2">
      ...filters... (same content, just extracted from the old wrapper)
    </div>
  </div>
  ```

- [ ] **Step 3: Replace inline button classes in filter toolbar with .btn-sm**

  Find the "Sync from Square" button (around line 523):
  ```tsx
  className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-200 text-xs rounded border border-zinc-700 transition-colors whitespace-nowrap"
  ```
  Replace with `className="btn-sm whitespace-nowrap"`

  Find the "Auto-map all" button (around line 685):
  ```tsx
  className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-200 text-xs rounded border border-zinc-700 transition-colors whitespace-nowrap"
  ```
  Replace with `className="btn-sm whitespace-nowrap"`

- [ ] **Step 4: Visual verify**

  Open `/finance/invoices`. Confirm:
  - Page title "Invoices" and description appear with the same style as Production/Taproom pages
  - Filter dropdowns, sync button, and auto-map button still render correctly

---

### Task 6: Normalize Input/Select Classes

**Files:**
- Modify: `app/settings/account/AccountSettings.tsx`
- Modify: `app/finance/invoices/page.tsx` (filter selects and batch link select)

**Findings addressed:** S4, S5, A1, A2, A3, A4

Replace ad-hoc input/select inline classes with the `.inp` class so all form controls share the same height and padding.

- [ ] **Step 1: Fix AccountSettings.tsx inputs**

  Open `app/settings/account/AccountSettings.tsx`. Find the two `<input type="password">` elements. Replace their inline `className` with:
  ```tsx
  className="inp"
  ```
  (Remove the individual `bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-500 transition-colors` classes.)

  Note: `.inp` already applies `focus:border-color` change; the amber focus ring is provided by `focus-visible` in Task 1.

- [ ] **Step 2: Fix invoices page filter selects**

  In `app/finance/invoices/page.tsx`, the five filter `<select>` elements around lines 651–681 all have:
  ```tsx
  className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
  ```
  Replace each with:
  ```tsx
  className="inp w-auto"
  ```
  (`.inp` has `width: 100%` by default; `w-auto` overrides to natural width for toolbar selects.)

- [ ] **Step 3: Fix batch link select (line ~456)**

  Find:
  ```tsx
  className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 min-w-[200px]"
  ```
  Replace with:
  ```tsx
  className="inp min-w-[200px] w-auto"
  ```

- [ ] **Step 4: Fix delivery invoice select (line ~338)**

  Find:
  ```tsx
  className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-300 focus:outline-none"
  ```
  This is in the expanded line item row — it can stay at its compact size since it's inline in a dense table. Replace with a consistent minimal class:
  ```tsx
  className="inp text-[10px] py-0.5 px-1.5"
  ```

- [ ] **Step 5: Visual verify**

  - Open `/settings/account` — confirm password inputs are same height as `.inp` inputs elsewhere
  - Open `/finance/invoices` — confirm filter selects match button height in the toolbar

---

### Task 7: Accessibility Fixes

**Files:**
- Modify: `app/components/NavBar.tsx`

**Findings addressed:** A5

- [ ] **Step 1: Add aria-label to NavBar collapse toggle**

  In `app/components/NavBar.tsx`, find the collapse toggle button (around line 108):
  ```tsx
  <button
    onClick={() => setCollapsed((c) => !c)}
    className="text-zinc-500 hover:text-zinc-200 transition-colors p-1 rounded hover:bg-zinc-800/60"
    title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
  >
  ```
  Add `aria-label`:
  ```tsx
  <button
    onClick={() => setCollapsed((c) => !c)}
    aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
    className="text-zinc-500 hover:text-zinc-200 transition-colors p-1 rounded hover:bg-zinc-800/60"
    title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
  >
  ```

- [ ] **Step 2: Fix text-[9px] badge labels in invoices page**

  In `app/finance/invoices/page.tsx`, find all `text-[9px]` occurrences (lines 302, 324, 329, 334 approx). Replace each with `text-[10px]`:

  ```tsx
  // From:
  className={`text-[9px] font-medium px-1 py-0.5 rounded shrink-0 ...`}
  // To:
  className={`text-[10px] font-medium px-1 py-0.5 rounded shrink-0 ...`}
  ```

- [ ] **Step 3: Build check**

  ```bash
  npm run build 2>&1 | tail -20
  ```
  Expected: no TypeScript errors. Build succeeds.

---

### Task 8: Final Regression Pass

**Files:** (read-only verification)

- [ ] **Step 1: Run lint**
  ```bash
  npm run lint 2>&1 | grep -v "^$" | head -40
  ```
  Expected: no new errors introduced.

- [ ] **Step 2: Visual regression check — Taproom**
  Open `/taproom/performance/sales-pulse`. Confirm: font is Geist, nav underlines amber, page header unchanged.

- [ ] **Step 3: Visual regression check — Production**
  Open `/production/intake`. Confirm: SubNav renders correctly, PageHeader unchanged, BatchLog tab functions.

- [ ] **Step 4: Visual regression check — Finance**
  Open `/finance/invoices`. Confirm: PageHeader + filter toolbar, selects match button height, amber nav active state.

- [ ] **Step 5: Visual regression check — Settings**
  Open `/settings/account`. Confirm: amber underline tabs (not pill), `text-base` heading, inputs use .inp height.

- [ ] **Step 6: Commit**
  ```bash
  git add app/globals.css app/finance/FinanceNav.tsx app/finance/transactions/TransactionsNav.tsx app/settings/SettingsTabs.tsx app/finance/invoices/page.tsx app/settings/account/AccountSettings.tsx app/components/NavBar.tsx
  git commit -m "fix(ui): apply Geist font, add CSS tokens, consolidate nav components, normalize inputs and focus rings

  - Fix body font-family to use --font-geist-sans CSS var (was falling back to Arial)
  - Add CSS custom property token layer for surfaces, borders, text, accent, danger
  - Add focus-visible rings to .btn-* and .inp classes
  - Add .btn-sm tier for dense table toolbars
  - Consolidate FinanceNav and TransactionsNav into shared SubNav
  - Align SettingsTabs with app-wide amber underline tab style (was pill/bg)
  - Normalize Settings heading to text-base (was text-lg)
  - Add PageHeader to finance invoices page
  - Normalize filter selects and AccountSettings inputs to use .inp class
  - Add aria-label to NavBar collapse toggle
  - Replace text-[9px] badge labels with text-[10px]"
  ```
