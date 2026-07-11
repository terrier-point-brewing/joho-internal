# Agent Context Cheat Sheet

Single doc for implementation subagents. Do NOT re-read CLAUDE.md, UI_STANDARD.md, or the plan/spec — your task brief + this file are sufficient. Full docs only per CLAUDE.md's Extended Documentation Triggers.

## Stack
Next.js 16 App Router + TS + Tailwind v4. Square API via raw `fetch` (shared wrapper in `lib/square/client.ts`). Supabase Postgres. Single location `LZ8TH4A632YW0`. Next.js 16 differs from training data — see `docs/nextjs16-deltas.md` (async `params`/`searchParams`/`cookies`, `proxy.ts` not middleware, no `next lint`).

## Non-negotiable patterns
- Auth: `lib/auth.ts` — `getSessionUser` / `requireRole`; roles viewer < brewer < manager < admin. Never roll your own.
- Supabase client by context: `lib/supabase/server.ts` (Server Components / read-only handlers), `admin.ts` (handlers that write), `browser.ts` (Client Components only — never in a route handler).
- API routes: handlers in `app/api/**` are thin — business logic in `lib/`. Parse dates with `requireDateRange()`, errors via `apiError()` (both `lib/utils/api.ts`). Add `export const dynamic = "force-dynamic"` to new routes.
- New/modified `lib/` modules ship with co-located `*.test.ts` (vitest) covering pure logic paths.
- Schema: `supabase/migrations/` is source of truth; add a new migration, never edit existing ones.
- Constants: `lib/constants/production.ts` (GALLONS_PER_BBL, BBL_TO_FL_OZ). Query keys: `lib/query-keys.ts`. Formatting: `lib/utils/formatting.ts` (`fmtUsd`).

## UI quick reference
- Never use raw colors (`zinc-*`/`amber-*`/`red-*`/`green-*`/`blue-*`/`gray-*`, hex/rgb). Tokens: surfaces `bg-canvas/surface/surface-mid/surface-high`; borders `border-line/-strong/-subtle`; text `text-primary/strong/body/secondary/muted/faint/disabled`; accent `text-accent(-emphasis/-soft)`, `bg-accent-muted`; status `text-danger/success/info` (+ `-surface`/`-border`).
- Primitives only: buttons `.btn-primary/.btn-secondary/.btn-danger` (+`.btn-xxs` for dense rows); inputs `.inp`/`.inp-sm`; `<PageHeader>`, `<Card>`, `<Modal>/<ModalActions>/<Field>`, `<Banner>`, `<Badge tone>`, `<SubNav>`/`<TabBar>`. All in `app/components/`.
- Spacing scale 0/0.5/1/1.5/2/2.5/3/4/6/8; no `text-[Npx]`. Page shell: `<main className="px-4 sm:px-6 py-4 sm:py-8">`.
- Exceptions to no-raw-colors: Recharts props, React-Flow/absolute canvases, data-category/urgency palettes (shared constants, one place per area).

## Verify (Definition of Done for every task)
```
npm run verify   # lint + tsc --noEmit + vitest run
```
Full `npm run build` only when the task changed routing/config. If tsc/build errors look unrelated to your change, clear stale `.next/dev` artifacts first.

## Output discipline
- Write each file once; don't restate code in prose or reports.
- Task report format: what changed (file list), verify results, deviations from brief — nothing else.
