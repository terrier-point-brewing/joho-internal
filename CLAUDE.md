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
`npm run dev` · `npm run build` · `npm run lint` · deploy: `vercel deploy --prod` from repo root

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
- This Next.js version has breaking API/convention changes vs. training data — see `AGENTS.md`

## Model Selection
- Default to **Sonnet** for all tasks.
- Use **Opus** only when absolutely necessary: prod DB migrations, irreversible data ops, multi-file orchestration with high blast radius, or any decision that cannot be recovered if wrong.

## Agent/Subagent Usage
- Do NOT spawn subagents (Agent tool / Explore) for simple, single-file fixes or small well-scoped edits — read the file and make the change directly.
- Reserve subagents for genuinely broad, multi-step, or open-ended tasks (cross-codebase exploration, multi-file refactors spanning unclear scope, parallelizable independent work).
- When in doubt about scope, default to handling it directly first; only escalate to a subagent if direct exploration reveals the task is larger than expected.
- **Full spec builds require an implementation plan + subagents.** When given a spec or multi-file feature to build, always write a plan first (superpowers:writing-plans), then execute it with parallel subagents (superpowers:subagent-driven-development). Do not attempt full spec builds as a single inline session.

## Architecture Priorities (strict)
- **Modularity over inline logic, always.** No business logic in `app/api/**` or page components — extract to `lib/`. One responsibility per file/hook/module. If a file is doing two unrelated things, split it.
- **Build for extension, not just the current ask.** This codebase grows by layering new features on existing tables/routes/hooks. Before writing new logic, check whether an existing `lib/` module, hook, or API route already owns that concern — extend it instead of duplicating.
- **Reuse existing DB tables/routes by default.** Don't create a new table or route when an existing one can be extended (new column, new query param, new optional field). Propose schema/route changes explicitly rather than silently forking parallel structures.
- **Shared logic goes in one place.** Cross-feature logic (date ranges, role checks, money/volume formatting, Square/Supabase clients) belongs in `lib/utils`, `lib/constants`, or a dedicated `lib/<domain>` module — never copy-pasted per feature.
- **No premature abstraction, but no throwaway code either.** Don't build speculative generic frameworks for a one-off; but anything touching a table or route that other features already depend on must be written assuming a third and fourth consumer will show up.
- **Efficiency:** avoid redundant Supabase round-trips and Square API calls — batch/join queries where possible, reuse already-fetched data (e.g. via `useProductionData.ts` / `query-keys.ts`) instead of re-fetching.

## Extended Documentation Triggers
- Touching production scheduling/transfers/tank logic → read `app/production/lib/volumeLedger.ts` and `lib/production/commitments.ts` first
- Touching the equipment schedule graph → read `app/production/components/EquipmentSchedule/buildGraphData.ts` fully before editing nodes/edges
- Adding/changing a Square integration → check `lib/square/client.ts` for the shared request wrapper before adding a new module
- Schema changes → read latest files in `supabase/migrations/` and add a new migration, don't hand-edit existing ones
- Touching `app/production/**`, `app/api/production/**`, or `lib/production/**` → read `docs/production-schema.md` for table layout, equipment-type rules, and known limitations
- Next.js routing/conventions uncertainty → read `node_modules/next/dist/docs/` per `AGENTS.md`
