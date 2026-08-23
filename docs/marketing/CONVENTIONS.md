# Marketing chassis — conventions sheet

Derived by inspecting the repo on 2026-08-22. **Include this file verbatim in every
chip brief.** It exists so no chip invents a parallel abstraction. If a chip finds a
rule here to be wrong, it must stop and report rather than route around it.

---

## 0. The single most important thing

This repo has **no `modules/` directory and no module system.** There are no
`ports/`, no plugin registries, and no import-boundary lint anywhere today. Sections
are plain Next.js App Router route groups:

```
app/<section>/            screens, co-located components, nav-config.ts
app/api/<section>/        route handlers
lib/<section>/            all logic, all unit tests
supabase/migrations/      one flat directory, public schema only
```

Marketing follows that shape. The orchestrator spec's `modules/marketing/` layout is
translated, not implemented literally — see §9 for the mapping.

---

## 1. Stack

Next.js 16.2.6 (App Router, React 19.2.4, React Compiler on) · TypeScript strict ·
Tailwind v4 via `@theme` tokens · TanStack Query v5 · Zod v4 · date-fns v4 ·
Supabase (`@supabase/ssr` + `supabase-js`) · Vitest 4 · Vercel.

Path alias is `@/` → repo root (`tsconfig.json`, mirrored in `vitest.config.ts`).

## 2. Verify gate

```bash
npm run verify   # check:statements && lint && typecheck && test
```

Not in `verify`, but CI-relevant and cheap — run both on any chip touching them:

```bash
npm run check:permissions   # --strict
npm run check:migrations    # --strict
```

**CI is not `verify`.** `.github/workflows/ci.yml` runs lint, `tsc`, test,
`check:search-filter`, `check:permissions`, `check:migrations` and `build` — plus
`check:marketing-boundary`. It does **not** run `check:statements`, which therefore
only fires locally. Never assume a green PR means every local gate ran.

`npm test` is `vitest run`. Tests are `*.test.ts` co-located next to their subject;
`vitest.config.ts` includes `lib/**/*.test.ts` and `app/**/*.test.ts`. **Environment
is `node`, and there is no jsdom/testing-library in the repo** — component rendering
is not testable today. UI gates are verified in a browser, not in Vitest.

Coverage: `vitest.config.ts` declares an 86% `lines`/`statements` ratchet over
`lib/**/*.ts`. **It is not enforced anywhere** — neither `npm test` nor CI runs vitest
with `--coverage`, and the real figure on `main` is around 79%. Treat it as intent, not
a gate: put logic in `lib/marketing/` and test it because the chassis needs to be
provably correct, not because a threshold will catch you. Do not claim a chip "meets
the ratchet"; the honest claim is that coverage did not regress.

## 3. Permissions — scope + level, not flat keys

There are **no "grant keys"** in the spec's sense. `lib/auth/` models a scope tree
(`lib/auth/scopes.ts`) crossed with a level ladder
(`lib/auth/levels.ts`: `none < read < operate < manage < admin`). A capability
(`lib/auth/capabilities.ts`) is a named `{ scope, level }` intent.

Resolution is longest-dot-prefix-wins (`lib/auth/resolve.ts`), so a bare `marketing`
grant rolls down into every `marketing.*` leaf, and a sibling leaf grant confers
nothing on the section.

Registering a new section means editing, in this order:

1. `lib/auth/scopes.ts` — add `"marketing"` to the `Section` union and the leaves to `SCOPES`.
2. `lib/auth/capabilities.ts` — add `CAP.*` entries. **Every CAP entry must be referenced somewhere or `check:permissions` fails (rule 3); every scope must be covered by some CAP or it fails (rule 4).**
3. `lib/auth/roleGrants.ts` — add rows to the `ROLE_BUNDLES` that should hold it.
4. `lib/auth/__fixtures__/legacy-matrix.ts` — record any movement as an `intentionalChange` row.

Enforcement:

- **API**: `try { await requirePermission(CAP.x) } catch (res) { return res as Response }` (`lib/auth/guard.ts`).
- **Page/layout**: `await requirePage(CAP.x)` (`lib/auth/requirePage.ts`). Section admission is its own `read`-level `<section>.access` leaf, gated in the section layout and used for nothing else. Never gate authority on an access key.
- **Client**: `usePermissions().can(CAP.x)`. Client code must import `CAP` from `@/lib/auth/capabilities` and `can` from `@/lib/auth/resolve` **directly, never from the `@/lib/auth` barrel** — the barrel pulls `next/headers` into the client bundle, which breaks `npm run build` while `verify` still passes. Enforced by `check:permissions`.
- Banned outright: `requireRole(...)`, and any `role === "admin" | "manager" | "brewer" | "viewer"` comparison outside `lib/auth/`.

## 4. Navigation

Sidebar is `app/components/NavBar.tsx` — a hand-written client component with an
inline SVG icon per section and a hard-coded block per section. A sixth section is an
edit to that file (desktop block + `MobileNavItem` row + an icon), plus a
`app/<section>/nav-config.ts(x)` exporting the subtab list. Compare
`app/brand/nav-config.tsx` (`BRAND_TABS`) — the smallest existing example.

Subtab rows render via `app/components/SubNav.tsx` (`NavEntry`: `href`, `label`,
`requires?: Capability`, `requiresAny?`, `match?`, `exact?`) and visibility via the
exported `navEntryVisible(entry, can)`, which NavBar reuses so sidebar and page can
never drift. A subtab must gate on **exactly** what its page gates on, or a visible
tab leads to a redirect.

In-page view switching uses `app/components/TabBar.tsx`; a switcher *under* a real
subtab bar uses `app/components/ButtonGroup.tsx`, never a second `TabBar`.

## 5. Page structure (docs/UI_STANDARD.md §4)

`app/components/StickyHeader.tsx` wraps title + subtabs and nothing else — **no
buttons, selects, or status text in the frozen header, ever.** Those go in the
scrollable content below. `divider` is for a page with no subtab bar underneath.
`app/components/PageHeader.tsx` is title + optional description.

Shell pattern: `flex flex-col h-full` → StickyHeader → `flex-1 overflow-auto`. The
section layout adds no padding; each page owns its own.

Other hard rules from `docs/UI_STANDARD.md`:

- Buttons are `.btn-primary` / `.btn-secondary` / `.btn-danger` (§5), outline only, and **the tier owns its geometry**. Overriding `px-`/`py-`/`h-*`/`w-*`/`min-w-` on a `.btn-*` is an **eslint error** (`eslint.config.mjs`); `w-full` is the sole exception.
- No raw colors. Semantic Tailwind tokens only (`bg-canvas`, `bg-surface`, `text-muted`, `border-line`, …) from the `@theme` block in `app/globals.css` (§0, §2).
- Inset bars use `mx-`, never `px-`, so a rule never spans wider than its content.
- Primitives live in `app/components/**` and `app/components/ui/**` — no hand-rolled ones in feature code. Canvas/Gantt/calendar surfaces are the documented exemption (§5 preamble), which is the precedent the Marketing calendar grid sits on.

Nearest existing calendar to copy: `app/production/components/CalendarTab.tsx`
(date-fns month grid). Note it predates the token rewrite and still uses raw `zinc-*`
utilities — **copy its structure, not its colors.**

## 6. Database

**One flat `supabase/migrations/` directory, `public` schema only.** `create schema`
appears in zero migrations. Naming: `YYYYMMDDHHMMSS_snake_case_description.sql`.

`scripts/check-migrations.mjs --strict` fails when two files share a version (the
digits before the first underscore). This has bitten the repo three times (#410,
#412, #449) because parallel branches each pass locally and collide on `main`.
**Take a full `YYYYMMDDHHMMSS` stamp, and re-check `main` immediately after any merge
carrying a migration.**

Migrations are applied through the **Supabase MCP** (`apply_migration` for DDL,
`execute_sql` for reads/data), never `supabase db push`. Project ref
`drlsazatrcrdwaihjmex`; see the repo `CLAUDE.md` for tool-loading.

RLS convention — do not hand-write the policy pair:

```sql
alter table public.<t> enable row level security;
select public.apply_grant_policies('<t>', '<scope>');
```

`apply_grant_policies(p_table, p_scope)` (`20260822_rls_grant_aware_policies.sql`)
attaches a `"grant read"` (`read`) + `"grant write"` (`operate`, `for all`) pair for
`authenticated`, backed by `public.has_grant(scope, level)` — the SQL mirror of
`can()`. **It hard-codes `public.`**, which is one reason marketing tables live in
`public`. A deny that must survive a permissive policy has to be `as restrictive`.

For a table that is service-role-only (no Data API surface at all), the house pattern
is: RLS enabled, **no policies**, every consumer through
`createSupabaseAdminClient()` behind a `requirePermission()` guard. That is the
correct posture for anything holding a token.

Clients: `lib/supabase/admin.ts` (service role, bypasses RLS, server-only) ·
`lib/supabase/server.ts` (cookie session) · `lib/supabase/browser.ts`.

Triggers: **`public.update_updated_at()` already exists** and owns `updated_at` on
every table that has the column — attach it `before insert or update`, and never set
`updated_at` from app code.

Storage: buckets are created in-migration with
`insert into storage.buckets (id, name, public) values (…) on conflict do nothing`.
Upload path is always **upload to storage via the admin client, then insert the row**
— see `lib/tax/files.ts:uploadTaskFile`, `lib/payroll/gustoUpload.ts`, and
`app/api/brand/assets/route.ts` (multipart `FormData`, field `file`). There is no
shared upload helper; each module has its own ~40-line one. Note `brand-assets` was
deliberately flipped **private** (`20260903_brand_assets_private.sql`), with a
comment reserving a separate public bucket for a future marketing site.

## 7. API routes

`app/api/<section>/<resource>/route.ts`, exporting `GET`/`POST`/etc., with
`export const dynamic = "force-dynamic"`. Order inside a handler: permission guard →
parse/validate → call a `lib/marketing/*` function → `NextResponse.json(...)`, with
`apiError(err, status?)` from `lib/utils/api.ts` for failures. Keep handlers thin;
the logic and its tests belong in `lib/`.

Zod v4 is available and used for parsing.

## 8. Cron and background work

The house pattern is **not** a bare secret-checked POST:

- `vercel.json` `crons[]` — path + schedule. Vercel invokes with **GET**.
- `app/api/cron/<job>/route.ts` — `export const GET = createCronRouteHandler("<job>")` and nothing else.
- `lib/cron/cronRoute.ts` checks `Authorization: Bearer ${CRON_SECRET}` and 401s otherwise. **That secret gates only this path** — a browser never holds it.
- `lib/cron/jobs/index.ts` — the job's `run(adminClient)`.
- `lib/cron/registry.ts` — `CRON_JOBS` metadata for the Settings → Cron Jobs monitor (`schedule` must mirror `vercel.json`), including `manualRun: "wait" | "start"` and a `manualNote`.
- `lib/cron/runCronJob.ts` wraps every run: claims a Postgres advisory lease via `try_acquire_sync_lock` under the key `cron:<job>` (default TTL 900s), times it, and writes one `cron_runs` row. A refused run returns **409 busy**, not an error, and is not recorded.
- `app/api/cron/run/[job]` is the human "Run now" path, gated on `CAP.cronRead`-adjacent permissions rather than the secret.

A job started this way is single-flight *per job*, which is a coarser guarantee than
the spec's per-row claim. See open question Q3.

`lib/cron/reRunSafety.test.ts` asks one question of every job: *if somebody runs this
again, does the work a person did by hand survive?* A new job is expected to answer it
there.

## 9. Spec → repo translation (authoritative for chip briefs)

| Orchestrator spec | This repo |
|---|---|
| `modules/marketing/` | `app/marketing/`, `app/api/marketing/`, `lib/marketing/` |
| `migrations/` | `supabase/migrations/` (flat, shared, unique version stamp) |
| `ports/` | `lib/marketing/ports/` — interfaces + README only; **no implementations, no consumers in the chassis** |
| `plugins/` | `lib/marketing/plugins/` (`types.ts`, `registry.ts`, `fake/`) |
| `nav.ts` | `app/marketing/nav-config.ts` |
| `components/` | co-located under `app/marketing/**` |
| `settings/` | an entry in `app/settings/nav-config.tsx` + `app/settings/marketing/**` |
| `README.md` | `docs/marketing/README.md` (this folder) |
| `marketing` Postgres schema | `public.marketing_*` tables (see Q1) |
| grant keys `marketing.view` etc. | scopes `marketing.access`, `marketing.calendar`, `marketing.publish`, `marketing.accounts` + `CAP.*` at the right levels (see Q2) |
| `POST /api/marketing/deliveries/run` + `CRON_SECRET` | `GET /api/cron/marketing-deliveries` via `createCronRouteHandler` (see Q3) |
| boundary lint | a new `scripts/check-marketing-boundary.mjs` in the `scripts/check-*.mjs` idiom, wired into `npm run verify` (see Q4) |

## 10. Local run / verification

Dev server: `npm run dev`. `.env.local` is symlinked into the worktree by a
SessionStart hook — assume it is there.

The app is behind Supabase email/password auth. Verify UI in **Claude in Chrome**
(`mcp__claude-in-chrome__*`), not the isolated Browser pane, so sign-in is shared
across sessions; credentials are `APP_USERNAME` / `APP_PASSWORD` in `.env.local`,
read at the moment of use and never pasted anywhere.

Worktree dev servers share the **outer** repo's `.next` cache — after a direct DB
migration, clear `<outer-repo>/.next/cache/fetch-cache`, not the worktree's.
