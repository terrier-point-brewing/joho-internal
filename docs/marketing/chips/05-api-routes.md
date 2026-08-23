# Chip 5 — API routes: entries, media, accounts

**Read `docs/marketing/CONVENTIONS.md` in full before writing anything**, especially
§6 (storage/upload) and §7 (route shape). Where this brief and the conventions sheet
disagree, stop and report.

Chips 1–4 are merged on `main`: the section and its permissions, the six
`public.marketing_*` tables (already applied), the plugin contract + registry + fake,
and the worker. Chip 6 (UI) runs after you and calls everything you build here.

---

## 1. Intent

Marketing is one calendar; a robot that publishes what is on it; later an assistant
that proposes entries. **Humans approve — nothing publishes or spends without a human
action.** You build the surface a human acts through.

## 2. What this chip owns

### 2.1 The `marketing.calendar` scope

The last deferred scope. Chip 1 named it and left it out; chip 4 removed its own half
of that comment — **remove the rest of it now.**

- `lib/auth/scopes.ts` — `"marketing.calendar": { label: "Calendar", section: "marketing" }`.
- `lib/auth/capabilities.ts` — `marketingCalendarRead` (`read`) and `marketingCalendarEdit` (`operate`). Both must have callers; they will.
- `lib/auth/__tests__/capability-coordinates.test.ts` — **pin both, or it will not compile.**
- Scope-count canary 32 → 33, in all three places that move together: `scopes.ts`'s header comment, `check-permissions.mjs` rule 4, `roleGrants.test.ts`.
- **Do not touch `ROLE_BUNDLES`** — role bundles are data, granted through Settings → Environment → Users.

### 2.2 Entries

**`POST /api/marketing/entries`** — `CAP.marketingCalendarEdit`. Creates one entry,
its ordered `marketing_entry_media` rows, and — when asked to — its deliveries.

- Zero media is legal: a text-only entry.
- Multi-media **order is the caller's**, persisted as `position`, and must round-trip exactly. It is the one thing here a later bug cannot infer.
- `status` may be set to `draft` or `approved` **and nothing else.** Everything past that is the trigger's, and app code that writes a derived status is a bug even when it happens to be right. Reject any other value with a sentence.
- `origin` is `manual` from this route. `assistant` stays valid in the schema and written by nothing.
- `details` passes through untouched — **the chassis never reads it.**
- Validate with Zod (v4, already a dependency).

**"Post now"**: the request may ask for immediate publication. Then, in one path:
create the deliveries with `scheduled_at = now()` and `status = 'scheduled'`, and
invoke the worker **inline** —

```ts
import { runMarketingDeliveries } from "@/lib/marketing/worker";
```

— so the post goes out without waiting up to five minutes for the cron. The inline run
is best-effort: if it throws, the entry and its deliveries are already committed and
the scheduled cron will pick them up, so the request must still succeed. Say that in a
comment.

**Scheduling stays unavailable.** A caller may not supply a future `scheduled_at`; the
only two options are draft and now. The column exists and the worker honours it — this
route just will not let a person reach it yet.

**`GET /api/marketing/entries?from=&to=`** — `CAP.marketingCalendarRead`. Returns
entries whose `starts_at` falls in the window, each with its ordered media and its
deliveries (status, error, `external_ids`, channel). One round trip's worth of data —
chip 6's calendar and entry detail both read this. Half-open `[from, to)`; say which
in a comment. Compare `lib/utils/datetime.ts` before hand-rolling any date handling.

### 2.3 Media

**`POST /api/marketing/media`** — `CAP.marketingCalendarEdit`. `multipart/form-data`,
field `file`, mirroring `app/api/brand/assets/route.ts` and `lib/tax/files.ts`:
**upload to storage through the admin client first, then insert the row.** There is no
shared upload helper in this repo and writing a fourth module-local one is house style,
not duplication.

- Bucket `marketing-media`, path `{yyyy}/{mm}/{uuid}.{ext}`.
- Accept images; the schema accepts `video` and you may store one, but **build no video handling** — no transcoding, no thumbnailing, no duration probing.
- `width`/`height`/`bytes`/`duration_s` are whatever the caller supplies or can be cheaply determined; all are nullable and a plugin is expected to complain in `validate` rather than assume.
- The spec lists a `POST media/complete` companion for a two-step upload. **Only build it if the single-step route genuinely cannot carry the file** — decide from Next.js 16's body limits, and if you skip it, say so and why.

### 2.4 Accounts

Gated on `CAP.marketingAccountsManage`. All three go through the **registry** — no
route may name a channel in its own source.

- **`GET /api/marketing/accounts/[channel]/connect`** — mint a `state` CSRF token, store it, redirect to `plugin.connect.authUrl(state)`.
- **`GET /api/marketing/accounts/[channel]/callback`** — verify `state` **before** anything else and reject a mismatch outright; then `plugin.connect.callback(code, state)`; then upsert `marketing_connected_accounts` on `(provider, channel)`.
- **`POST /api/marketing/accounts/[id]/disconnect`** — `status='disconnected'` and **clear `credentials`**. Do not delete the row; the deliveries that reference it are history.

`credentials` is written and read **only** through `createSupabaseAdminClient()`, and
**must never appear in a response body, a log line, or an error message.** The table
has no policies and no API-role grants, so a client cannot reach it — keep it that way
by never selecting the column into anything a route returns.

Where you store `state`: pick the simplest thing that is actually safe (a signed,
short-lived, httpOnly cookie is the obvious candidate) and **do not add a table** —
that would be a schema change, which you do not own.

## 3. Gate

- [ ] `npm run verify`, `npm run check:permissions -- --strict`, `npm run build` — all green.
- [ ] A **text-only** entry persists and reads back with zero media.
- [ ] **Multi-media order round-trips exactly**, including a non-alphabetical order that a naive query would silently re-sort. This is the assertion most worth writing well.
- [ ] `status` outside `draft`/`approved` is rejected; the trigger's statuses are never written by app code.
- [ ] **Post now** creates deliveries at `now()` and runs the worker inline — assert the fake published — and a worker that throws still leaves the request successful with the rows committed.
- [ ] `GET ?from=&to=` returns a week correctly, including an entry exactly on each boundary (prove the half-open interval), with media ordered and deliveries attached.
- [ ] Media upload puts bytes at the `{yyyy}/{mm}/{uuid}.{ext}` path and the row's `url` resolves.
- [ ] Accounts: a `state` mismatch on callback is rejected; a successful callback upserts on `(provider, channel)` rather than duplicating; disconnect clears `credentials` and keeps the row.
- [ ] **Grep every response your routes can return and confirm `credentials` cannot appear in any of them.** Say how you checked.
- [ ] Any real rows or uploaded objects you created while testing are deleted. Confirm with counts.

## 4. Do not build

- Any UI — no page, component, Compose form, or calendar grid. **Chip 6 owns all of it.**
- Any change to the worker, the cron entry, or `vercel.json` — chip 4 owns those. You import `runMarketingDeliveries`; you do not edit it.
- A working Schedule: no future `scheduled_at` from this route (see 2.2).
- Any real channel plugin, credential, or network call to a live service.
- Video handling of any kind.
- Any writer for `marketing_metrics`.
- Any migration or schema change — including a table to hold OAuth `state`. If you believe one is needed, **stop and report**.
- Any edit to `ROLE_BUNDLES` or to an applied migration file.
- Any port interface in `lib/marketing/ports/`.

## 5. Report back

What you built · every gate result · whether you built `media/complete` and why ·
where OAuth `state` lives · how you verified `credentials` cannot leak · any deviation
and why · anything in this brief that turned out to be wrong. **If the design needs to
change, stop and report.**
