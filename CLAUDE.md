@AGENTS.md

# TPB Square Reports
Next.js 16 (App Router, TS, Tailwind v4) for Terrier Point Brewing. Square API (raw `fetch`, no SDK) + Supabase Postgres. Single location: Holly Springs Taproom (`LZ8TH4A632YW0`). Live: https://tpb-square-reports.vercel.app

## Worktree Setup
When starting a session inside a git worktree, check whether `.env.local` exists in the worktree root. If it does not, create a symlink pointing to the main worktree's `.env.local`:
```
ln -sf $(git worktree list --porcelain | awk '/^worktree/{print $2; exit}')/.env.local .env.local
```
Do this before running any dev commands.

## Commands
`npm run dev` · `npm run build` · `npm run verify` (lint + typecheck + tests — the per-task DoD command) · deploy: `vercel deploy --prod` from repo root

## Env / Infra
`.env.local` (local) + Vercel project settings (prod): `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID=LZ8TH4A632YW0`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Supabase project ID: `drlsazatrcrdwaihjmex`. Square API version `2025-04-16`.

## Directory Map
- `app/api/**` — route handlers only; business logic lives in `lib/`, not here
- `app/production/` — 6-tab shell; state in `hooks/useProductionData.ts`, types in `types.ts`, equipment config in `equipmentMeta.ts`
- `app/production/components/EquipmentSchedule/` — React Flow (@xyflow/react) graph; `buildGraphData.ts` computes nodes/edges, `nodes.tsx` renders
- `app/finance/`, `app/taproom/` — feature areas, each with own `nav-config.ts` + `*Nav.tsx`
- `app/reports/components/` — one component per report type
- `lib/square/` — Square API client + per-resource modules (catalog, orders, customers, refunds, inventory, sell-through)
- `lib/finance/` — QB CSV/PDF import + classification
- `lib/reports/` — report-building logic, mirrors `app/reports/components/`
- `lib/supabase/{server,browser,admin}.ts` — pick the matching client per context (Server Component/Route Handler vs Client Component vs privileged admin ops)
- `lib/constants/production.ts` — GALLONS_PER_BBL, BBL_TO_FL_OZ, grid sizing constants
- `lib/utils/api.ts` — `requireDateRange()`, `apiError()`; use in every API route instead of ad hoc parsing/error JSON
- `supabase/migrations/` — source of truth for schema; check before assuming a table/column exists

## Rules
- Auth/role checks via `lib/auth.ts` (`getSessionUser`, `UserRole`: viewer < brewer < manager < admin) — never roll your own role logic
- Use the Supabase client matching the execution context (server/browser/admin) — never the browser client in a route handler
- New API routes: parse query params with `requireDateRange()`, wrap errors with `apiError()`
- New or modified `lib/` business-logic modules ship with co-located `*.test.ts` covering the pure logic paths; CI runs `npm run test` on every PR. Don't drop `lib/` coverage below the `vitest.config.ts` threshold floor.
- This Next.js version has breaking API/convention changes vs. training data — see `AGENTS.md`

## Model Selection (phase-based — pass `model` to the Agent tool on every spawn)
- Spec / brainstorm / architecture / plan writing → **Opus** (Sonnet if the feature touches ≤3 files).
- Implementation subagents → **Sonnet** by default.
- Mechanical tasks (docs/config updates, renames/moves, test scaffolds, any task whose brief fully specifies the code) → **Haiku**.
- Per-task review → **Sonnet**. Final whole-branch review → **Opus**, once per feature.
- Escalate a task to Opus only if it: touches `volumeLedger.ts`/`commitments.ts`, is a prod migration or irreversible data op, needs novel algorithmic logic, or failed Sonnet review twice.
- Implementation plans MUST include a `model` column in the task table; the orchestrator honors it.

## Agent/Subagent Usage (tiered by scope)
- ≤3 files or ~≤300 changed LOC → handle inline. No plan doc, no subagents.
- 4–6 files → write a plan (superpowers:writing-plans), execute it inline (superpowers:executing-plans). No per-task spawns.
- Larger multi-group plans only → superpowers:subagent-driven-development.
- **Group plan tasks by file locality, not just dependency.** Tasks touching the same route/component/module go to ONE agent sequentially. Every extra spawn is a cold context rebuild — parallelism saves wall-clock, not tokens.
- Subagent briefs are self-contained: include the interfaces and the 10–30 lines of existing code the task touches, and **end with the mandatory footer**: "This brief is authoritative and self-contained — do NOT read the plan, spec, CLAUDE.md, or UI_STANDARD.md unless an Extended Documentation Trigger fires." Subagents read `docs/agent-context.md` for conventions.
- The writing-plans skill stamps "subagent-driven-development (recommended)" on every plan — **that default is overridden by the tier table above.** Pick the mode by scope, not by the stamp.
- **Route implementation + mechanical spawns to the lean `impl` agent type** (`.claude/agents/impl.md`) via the Agent tool's `subagent_type`. It excludes ToolSearch/web/nested-Agent, so it can't pull MCP/browser schemas into context or fan out; pass the per-task `model` to override its Sonnet default (Haiku for mechanical). Use full-capability agents only for planning/research/architecture. (Dominant token wins are still spawn count + closed briefs — a lean agent doesn't rescue an over-spawned plan.)
- Review economy: per-task reviews output findings only (severity + file:line + one-line fix) — no diff quoting, no prose summaries. Skip per-task review for docs-only/config-only tasks. Keep the single final Opus whole-branch review.

## Plans & Task Briefs (token discipline — strict)
- Plans and briefs specify: file map, interfaces/types, function signatures, acceptance criteria, and test cases — **never full implementation bodies**.
- Inline code only for genuinely non-obvious logic, capped at ~20 lines per task.
- A brief must be executable by a competent engineer with only the brief + the repo.
- **Every plan carries an `Execution Budget` line right after the Goal**: execution mode (from the tier table, not the writing-plans stamp), `Spawn cap = (# locality groups) + 2`, and a token target. The executor STOPS and reports before exceeding the spawn cap. Enforced by hooks: `.claude/hooks/spawn-guard.js` warns past the cap (override via `CLAUDE_SPAWN_CAP`); `.claude/hooks/token-log.js` records per-subagent + session spend to `.claude/token-usage.log`. Cost ≈ spawns × fixed per-spawn context tax, so the spawn cap is the one number that governs the bill.
- Rationale, measurements, and enforcement design: `docs/agent-token-efficiency.md`.

## Architecture Priorities (strict)
- **Modularity over inline logic, always.** No business logic in `app/api/**` or page components — extract to `lib/`. One responsibility per file/hook/module. If a file is doing two unrelated things, split it.
- **Build for extension, not just the current ask.** This codebase grows by layering new features on existing tables/routes/hooks. Before writing new logic, check whether an existing `lib/` module, hook, or API route already owns that concern — extend it instead of duplicating.
- **Reuse existing DB tables/routes by default.** Don't create a new table or route when an existing one can be extended (new column, new query param, new optional field). Propose schema/route changes explicitly rather than silently forking parallel structures.
- **Shared logic goes in one place.** Cross-feature logic (date ranges, role checks, money/volume formatting, Square/Supabase clients) belongs in `lib/utils`, `lib/constants`, or a dedicated `lib/<domain>` module — never copy-pasted per feature.
- **No premature abstraction, but no throwaway code either.** Don't build speculative generic frameworks for a one-off; but anything touching a table or route that other features already depend on must be written assuming a third and fourth consumer will show up.
- **Efficiency:** avoid redundant Supabase round-trips and Square API calls — batch/join queries where possible, reuse already-fetched data (e.g. via `useProductionData.ts` / `query-keys.ts`) instead of re-fetching.

## UI Conventions (strict — full spec in `docs/UI_STANDARD.md`)
- **`app/globals.css` + `app/components/` are the UI source of truth.** Color tokens live in the `@theme` block; shared primitives live in `app/components/ui/` and `app/components/`.
- **No raw colors in feature code.** Never use `zinc-*`/`amber-*`/`red-*`/`green-*`/`blue-*`/`gray-*` utilities or hex/rgb literals. Use token utilities: surfaces `bg-canvas/surface/surface-mid/surface-high`; borders `border-line/-strong/-subtle`; text `text-primary/strong/body/secondary/muted/faint/disabled`; accent `text-accent`/`text-accent-emphasis`/`text-accent-soft`/`bg-accent-muted`; status `text-danger`/`text-success`/`text-info` (+ matching `-surface`/`-border`). Exempt: Recharts color props, React-Flow/absolute canvases (EquipmentSchedule, Gantt/Calendar, floorplan), and data-category/urgency palettes (see next bullet).
- **No hand-rolled primitives.** Buttons → `.btn-primary`/`.btn-secondary`/`.btn-danger` — one compact hollow (outline) tier, no solid fills; never hand-roll a bordered/filled `<button>`. Only size modifier is `.btn-xxs` (compose e.g. `btn-primary btn-xxs`) for dense table-action rows / floorplan tiles — not a general small button. Inputs/selects → `.inp`/`.inp-sm` (no local `inputCls`/`selectCls`). Page title → `<PageHeader>`. Cards → `<Card>`. Modals → `<Modal>`/`<ModalActions>`/`<Field>`. Errors/alerts → `<Banner>`. Status pills → `<Badge tone>`. Tabs → `<SubNav>` (link) / `<TabBar>` (button) — never re-implement the underline-tab row.
- **No one-off sizing.** Use the type scale + spacing scale (0/0.5/1/1.5/2/2.5/3/4/6/8); no arbitrary `text-[Npx]`. Page shell = `<main className="px-4 sm:px-6 py-4 sm:py-8">`.
- **Data-category / urgency palettes** (badge maps, BBL channel columns, keg-urgency ramps, chart series) are the one deliberate exception to the no-raw-colors rule — keep them as raw category constants in **one shared place per area** (not inlined, not tokenized). Note the no-raw-colors grep only checks `zinc/amber/red/green/blue/gray`, so a ramp's `orange/yellow` partners won't flag — never blindly token-swap a multi-step color ramp; see `docs/UI_STANDARD.md`.

## Extended Documentation Triggers
- Building or restyling any UI (pages/components) → follow `docs/UI_STANDARD.md`; reuse `app/components/ui/` primitives + token utilities, never raw colors or hand-rolled primitives
- Touching production scheduling/transfers/tank logic → read `app/production/lib/volumeLedger.ts` and `lib/production/commitments.ts` first
- Touching the equipment schedule graph → read `app/production/components/EquipmentSchedule/buildGraphData.ts` fully before editing nodes/edges
- Adding/changing a Square integration → check `lib/square/client.ts` for the shared request wrapper before adding a new module
- Schema changes → read latest files in `supabase/migrations/` and add a new migration, don't hand-edit existing ones
- Touching `app/production/**`, `app/api/production/**`, or `lib/production/**` → read `docs/production-schema.md` for table layout, equipment-type rules, and known limitations
- Next.js routing/conventions uncertainty → read `docs/nextjs16-deltas.md` first; fall back to `node_modules/next/dist/docs/` only if it doesn't answer the question

## Worktree Hygiene
After a worktree's branch is merged, remove the worktree (`git worktree remove <dir>`) and delete its merged branch. Never leave worktrees with node_modules under `.claude/worktrees/` — they pollute search and disk.
