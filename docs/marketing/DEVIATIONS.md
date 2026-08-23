# Deviation register — orchestrator spec vs. the chassis as built

Compiled by chip 7 while re-running every earlier chip's gate against one integrated
tree. Each row is a place the built chassis differs from the original orchestrator spec,
with the reason it differs. Where a decision is argued at length in code, the file is
named rather than the argument repeated.

Nothing here is an open question. Each one was decided deliberately by the chip that hit
it. The two items marked ⚠ still need a person before a real channel is connected.

---

## Structural

| # | Spec | Built | Why |
|---|---|---|---|
| 1 | a `marketing` Postgres schema | `public.marketing_*`, six tables | No migration in this repo's 240+ uses `create schema`, and `public.apply_grant_policies(table, scope)` — the house RLS applicator — hard-codes `public.`. A separate schema means hand-writing every policy pair, which is the drift that function exists to prevent. |
| 2 | `modules/marketing/` with `ports/`, `plugins/`, `nav.ts`, `components/` | `app/marketing/`, `app/api/marketing/`, `lib/marketing/`, `app/settings/marketing/` | This repo has no module system and no `modules/` directory. Sections are Next.js App Router route groups. The mapping is `docs/marketing/CONVENTIONS.md` §9. |
| 3 | `ports/` holds port interfaces | `lib/marketing/ports/` holds a README and nothing else | The chassis needs no port. Declaring one with no implementation and no consumer would be a shape nobody has tested against a real need. |
| 4 | boundary lint with two rules | two rules, plus **a third named allowance** | Marketing's settings screen is mounted into the settings hub's own shell, so `app/settings/marketing/**` may import `@/app/settings/SettingsGroupShell` and `@/app/settings/SettingsHeader` — two exact modules, both pure presentation, neither reading marketing's data. Listed by full path rather than an `@/app/settings` prefix, so it does not become a door onto finance's mapping hooks or payroll's config. |

## Permissions

| # | Spec | Built | Why |
|---|---|---|---|
| 5 | flat grant keys (`marketing.view`, …) | scopes × levels: `marketing.access`, `marketing.calendar`, `marketing.accounts`, `marketing.publish`, each crossed with `none < read < operate < manage < admin` | `lib/auth/` has no concept of a flat grant key. Resolution is longest-dot-prefix-wins, so a bare `marketing` grant rolls down into every leaf. |
| 6 | roles carry marketing access | **no role bundle was edited** | Role bundles are *data* in `role_permission_grants`, not the `ROLE_BUNDLES` constant. Registering the scopes is what makes them grantable; opening Marketing to manager is an admin action in Settings → Environment → Users, not a deploy. |

## Credentials

| # | Spec | Built | Why |
|---|---|---|---|
| 7 | `encrypted_token`, encrypted at rest | `credentials jsonb` in the clear, in a table with **RLS on, zero policies, and zero Data API grants** | `supabase_vault` is installed and used by zero migrations and zero lines of app code here; introducing it means a decryption path in the publish hot loop and a key-management story nobody else follows. The spec's actual intent — the client can never read the token — is met **more strongly**: `select` as `authenticated` returns `permission denied for table marketing_connected_accounts`, for an admin's session as much as a brewer's. Verified by chip 7. |
| 8 | — | `audit_trigger_fn()` deliberately **not** attached to `marketing_connected_accounts` | The audit trigger copies the whole row into `audit_log`, which has a different access posture. Auditing a credential row leaks the credential. |
| 9 | — ⚠ | OAuth `state` in a signed, ten-minute, httpOnly cookie, and a new required env var **`MARKETING_OAUTH_STATE_SECRET`** | The spec names neither. A table would have been a schema change chip 5 did not own; a cookie is the right shape as well as the cheap one (`lib/marketing/oauthState.ts`). Documented in `.env.example`. **It is unset in the local `.env.local`, and chip 7 could not check Vercel** — connecting a real channel fails with a sentence until someone sets it. |

## The worker and the cron

| # | Spec | Built | Why |
|---|---|---|---|
| 10 | `POST /api/marketing/deliveries/run` guarded by `CRON_SECRET` | `GET /api/cron/marketing-deliveries` via `createCronRouteHandler` | The house pattern, and nine jobs already use it. It brings the `CRON_SECRET` check, the `cron_runs` audit row, the advisory lease and the Settings → Cron Jobs monitor for free. A bare secret-checked POST would be a tenth way of doing a thing this repo does one way. |
| 11 | `*/5 * * * *` | `0 10 * * *` — **daily** | The Vercel **Hobby** plan this project runs on refuses any sub-daily cron: the deployment is rejected at config validation, before a build starts. Chip 7 independently confirmed the plan is `hobby`. Daily is also the honest cadence for what the job now does — see #12. |
| 12 | the cron is what publishes | **Post now publishes inline**, and the cron is a sweep | With no scheduling UI, an entry is published by a person pressing Post now, which runs the worker in-process and returns. The daily job exists to catch a delivery whose inline run died mid-flight. When scheduling ships and a post can be booked for Thursday at 9am, the cadence becomes a real constraint and the plan question reopens. |
| 13 | retry re-queues the row | retry re-queues **and runs the worker inline** | Consequence of #11. A retry that only set `status='scheduled'` would leave the person staring at a button that appears to do nothing for up to a day. `external_ids` is left intact, which is what lets the plugin refuse to post twice. |
| 14 | worker outcomes are published / failed | a third outcome, **`skipped`** | A delivery whose account has been unlinked has no credential and no retry that could invent one. `skipped` is excluded from the parent entry's status derivation, so the entry's other channels still decide whether it is done. |
| 15 | per-row claim | per-row claim **plus** a per-job lease | The lease comes with `runCronJob` and is a *weaker* guarantee, not the mechanism. Stated as such in `lib/marketing/worker.ts` and in this folder's README. |

## Schema and status

| # | Spec | Built | Why |
|---|---|---|---|
| 16 | a four-rung status ladder | **five rungs** — an all-`pending` set derives nothing | Added by PR #486 after chip 2 shipped. Without it, saving a draft with its channels chosen flipped the entry out of `draft` the moment the delivery rows appeared, and the API had to refuse channels on anything but an immediate publish. |
| 17 | — | a draft's `pending` deliveries carry **no `account_id`** | The channel choice has nowhere else to live, but a draft is not addressed to a login yet. Deliberate (`lib/marketing/entries.ts`). Consequence worth holding: whatever future path promotes `pending` → `scheduled` **must** fill `account_id`, or the worker will `skip` the delivery reporting a disconnected login. |
| 18 | metrics collected | `marketing_metrics` exists and **nothing writes it** | The collector is a later chip. Every counter is nullable so that "not fetched" and "the provider says zero" stay distinguishable. |

## Routes

| # | Spec | Built | Why |
|---|---|---|---|
| 19 | `POST /api/marketing/media/complete` (two-step upload) | **not built** | A Next.js 16 Route Handler has no body limit of its own; the real ceiling is Vercel's 4.5 MB request body, and `lib/marketing/media.ts` caps just under it so the refusal is a sentence. The only creative that routinely exceeds that is video, which is out of scope. A second route would be a mechanism with nothing to carry. |
| 20 | `accounts/[channel]/connect`, `accounts/[channel]/callback`, `accounts/[id]/disconnect` | `accounts/connect/[channel]`, `accounts/callback/[channel]`, `accounts/[id]/disconnect` | Next.js will not route two different slug names on the same dynamic path segment, and the two keys are genuinely different things — a connect is addressed by a channel with no row yet, a disconnect by the row id of one that has. **`next build` accepts the two-slug layout and `next dev` rejects it**, so a green build is not evidence here. |
| 21 | scheduling | `scheduled_at` exists, the worker honours it, **no route will accept a future value** | Draft and now are the only two options a person can reach. The column is not dead — it is the seam scheduling lands on. |

## UI

| # | Spec | Built | Why |
|---|---|---|---|
| 22 | week-by-day calendar | **month grid**, with a reserved band row above it | Matches `app/production/components/CalendarTab.tsx`, which is how this app already presents scheduled work — structure copied, colours not (that file predates the token rewrite). The band area for `ends_at` entries renders empty today so adding them later is not a re-layout. |
| 23 | multi-media picker | one file at a time, then explicit ↑/↓ reordering | Order is meaningful and the API preserves exactly what is sent, so the ordering affordance matters more than a multi-select. Adding two images is two adds. |
| 24 | "a published delivery links out to the post" | an external id that **is** a URL renders as a link; anything else renders as an identifier | `PublishResult` is a bag of ids and no plugin declares how its provider addresses a post. A per-channel URL template would put channel-specific knowledge in the chassis, which is the one thing the registry exists to prevent. |
| 25 | — ⚠ | production registers **zero channels** | The fake is gated on `NODE_ENV !== "production"`. Every consumer renders the empty registry as an ordinary first-run state, not an error. This is the state the chassis ships in until a real plugin lands. |
