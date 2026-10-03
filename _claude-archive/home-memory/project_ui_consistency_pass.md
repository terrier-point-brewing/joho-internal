---
name: project_ui_consistency_pass
description: "Full-codebase UI consistency pass — COMPLETE (all PRs merged). Standard, token system, exemptions, and two durable gotchas for future UI work."
metadata: 
  node_type: memory
  type: project
  originSessionId: 07e42d5b-0b34-471e-872f-1c8e48e17810
---

Full-codebase UI/formatting consistency pass (started 2026-06-29). **COMPLETE as of
2026-06-30 — all PRs merged to main.** Future UI work must conform to the standard below.

**Standard lives in the repo (canonical — read before any UI work):** `docs/UI_STANDARD.md`
(rules), `docs/ui/ROUTE_MANIFEST.md` (coverage contract), `docs/ui/INCONSISTENCY_CATALOG.md`,
`docs/ui/FINAL_REPORT.md` (what shipped). CLAUDE.md "UI Conventions" is the always-loaded
summary.

**Token architecture:** color tokens in a Tailwind v4 `@theme` block in `app/globals.css`
emit utilities: `bg-canvas/surface/surface-mid/surface-high`, `border-line/-strong/-subtle`,
`text-primary/strong/body/secondary/muted/faint/disabled`, `text-accent/-emphasis/-soft`,
`bg-accent-muted`, `border-accent-border`, and danger/success/info families
(`text-*` + `-surface`/`-border`/`-emphasis`). Shared primitives in `app/components/ui/`:
Card, Modal (+Field/ModalActions), Banner, Badge, tone map, tabStyles. Buttons `.btn-amber`
(solid `bg-accent-emphasis hover:bg-accent text-canvas`)/`.btn-ghost`/`.btn-danger`/`.btn-sm`;
inputs `.inp`/`.inp-sm` (inline selects use `.inp-sm w-auto`). Primary = solid amber + dark
text; page title = `<PageHeader>` (`font-semibold`).

**PRs (all MERGED):** #45 foundation · #47 core/settings/auth/payroll · #56 finance
(+AccountSelect, statements/lib, SalesPageShell, finance/lib) · #48 production
(+lib/categoryColors) · #51 taproom+reports **page shells** (+ReportTable, fmtUsd reuse) ·
#57 codify (CLAUDE.md UI Conventions + FINAL_REPORT) · **#59 residual cleanup** (taproom
tab-component bodies + post-pass surfaces). Non-exempt raw-color residual across `app/**` = 0.

**Exempt from token migration (kept raw, deliberately):** EquipmentSchedule/**, GanttTab,
CalendarTab, BrewStatus floorplan canvas, Recharts axis/grid/series props, NavBar fixed-nav
`text-[10px]` micro-labels — AND **data-category / urgency palettes** (badge maps, BBL channel
columns, keg-urgency ramps, chart series) kept as raw category constants per area.

**Two durable gotchas (cost rework this session — heed for any future UI cleanup):**
1. **Don't tokenize data-category/urgency ramps.** A blanket zinc/amber/red/green→token swap
   over-reached into `DraftStatsTab`'s keg-urgency ramp (critical→low→watch→soon→good, a
   red/orange/amber/yellow/green palette) and had to be reverted. These are exempt; only their
   neutral states tokenize. The standard's own grep only checks zinc/amber/red/green/blue/gray,
   so orange/yellow ramp partners won't even flag — verify ramps by eye, not just grep.
2. **Verify against merged main, not just your branch.** The pass's per-branch grep certified
   "files this PR changed are clean," missing whole rendered components (#51 did taproom page
   shells but not the `*Tab.tsx` bodies they render) and surfaces added by concurrent
   perf/feature PRs after an area was audited (#52 skeletons, #55 ChartSkeleton, #58
   UnrecognizedBanner). #59 closed that gap. Future "is the codebase compliant?" checks must
   grep the whole tree on current main, excluding only documented-exempt paths.

Worktree note: worktrees lack node_modules — run `npm ci` before build/lint; symlink
`.env.local` (per CLAUDE.md) before any build (prerender needs Supabase env vars).
