# The marketing chassis

Marketing is **one calendar**, a **robot** that publishes what is on it through pluggable
channels, and — later — an **assistant** that proposes entries. A human approves;
nothing publishes or spends without a person having said so.

The chassis is the part that does not change when a channel, an ad platform, or the
assistant arrives. It ships with **zero real channels**: the registry is empty in
production, and the fake plugin exists only outside it. This document is what to read
before adding the first real one.

Four things. Everything else lives in the code, next to the thing it describes.

---

## 1. The boundary, and why the fix is a port

Marketing is the only part of this app with an **enforced import boundary**
(`scripts/check-marketing-boundary.mjs`, run as `check:marketing-boundary --strict`
inside `npm run verify` and again in CI). Two rules, in opposite directions.

**Rule 1 — nothing outside marketing imports marketing.** If the rest of the app never
depends on it, marketing can be rewritten, extracted, or pointed at a different set of
integrations without a survey. There are exactly **two** exceptions, each one exact
file paired with one exact module specifier:

| File | May import | Why |
|---|---|---|
| `app/components/NavBar.tsx` | `@/app/marketing/nav-config` | Every section's sidebar block imports that section's nav config. Without it the sidebar cannot render marketing at all. |
| `lib/cron/jobs/marketingDeliveries.ts` | `@/lib/marketing/worker` | The scheduled publishing job. A file of its own, rather than an import inside `lib/cron/jobs/index.ts`, so the seam sits on the one module whose job is mounting marketing. |

Both are the host **mounting** marketing — giving it a place to hang — rather than
depending on what it knows. Neither reads marketing's data, and neither would survive
marketing being deleted. That is the test a third entry would have to pass.

**Rule 2 — marketing imports the host narrowly.** A file under marketing may reach
`@/lib/auth`, `@/lib/supabase`, `@/lib/utils`, `@/lib/cron`, `@/app/components`, and —
for the settings screen only — `@/app/settings/SettingsGroupShell` and
`@/app/settings/SettingsHeader`, which are the settings hub's own chrome that
`app/settings/marketing/**` is mounted into. Anything with another section's name in it
is absent on purpose.

Both rules see **relative paths as well as `@/` aliases**: `../../lib/finance/x` from
inside marketing is the identical dependency as `@/lib/finance/x`, spelled differently,
and the guard resolves it before deciding.

**When the guard blocks you, the fix is almost never to widen the allowlist.** It is a
**port**: a read-only interface *declared inside* `lib/marketing/ports/`, *implemented
and registered by the host*, that marketing only ever reads through and never writes
through. `lib/marketing/ports/README.md` describes the pattern; the folder holds that
README and nothing else, because the chassis needs no port yet. Later modules will —
brand voice, active taps, events, sales, budget caps.

## 2. The plugin contract

A channel plugin is the only thing that knows how a specific service works. The worker,
the routes and the UI reach a channel **only** through the registry, and none of them
names a channel in its own source.

```ts
export interface ChannelPlugin {
  channel: string
  provider: string
  connect: {
    authUrl(state: string): string
    callback(code: string, state: string): Promise<ConnectedAccountInput>
  }
  validate(entry: Entry, media: Media[]): ValidationResult
  publish(ctx: PublishContext): Promise<{ externalIds: Record<string, string> }>
}
```

Four members, and two of them carry a rule that is not obvious from the type:

- **`validate` is synchronous, deliberately.** Compose calls it on **every keystroke** to
  decide whether a channel is selectable and, when it is not, what sentence to show
  beside it. An async validate would mean a channel picker that flickers. Its `reasons`
  are shown to a person as written — sentences ("A reel needs a video."), never codes.

- **`publish` must be idempotent on `externalIds`, because you cannot un-post.** The
  worker hands `publish` the delivery's **current** `external_ids` — `{}` the first
  time, and whatever the last successful publish returned after that. If that bag is
  non-empty, the delivery has already gone out: return the same ids **without
  contacting the provider**. This is what makes a human retry safe, and a human retry is
  the only kind there is (there are no automatic retries anywhere in the chassis).
  `lib/marketing/plugins/fake/index.ts` implements exactly this and records a `reused`
  call so a test can prove no second publish happened.

`connect.callback` returns a `ConnectedAccountInput` for insertion into
`marketing_connected_accounts`; it never writes anything itself.

## 3. Adding a plugin

One folder, one registry line, no edits anywhere else.

1. **Create `lib/marketing/plugins/<channel>/index.ts`** exporting a factory that returns
   a `ChannelPlugin`. Copy the shape of `lib/marketing/plugins/fake/index.ts` — it is the
   worked example, and it is the only plugin that exists today.
2. **Implement the four members.** `validate` synchronous, `publish` idempotent on
   `externalIds` (see §2). Real network calls belong here and nowhere else.
3. **Register it** in `lib/marketing/plugins/registry.ts`:
   `registerChannel(createMyChannelPlugin())`. Registering a channel key twice **throws**
   rather than silently overwriting — a silent overwrite means the plugin that publishes
   is whichever module was imported last, which only shows up in production and only as a
   wrong post.
4. **Nothing else.** Compose's channel picker, the Settings → Marketing panel, the
   Accounts subtab and the worker all read `listChannels()` / `getChannel()`. No screen
   and no route needs a line.

Two things to have ready before it can actually connect:

- **`MARKETING_OAUTH_STATE_SECRET`** must be set in the environment (see `.env.example`).
  The connect route mints a signed, ten-minute, httpOnly cookie holding the OAuth
  `state`; with no secret it refuses, in a sentence, on the first connect attempt.
- **The credential lands in `marketing_connected_accounts.credentials`**, a plain `jsonb`
  column in a table with **no RLS policies and no Data API grants at all**. Only the
  service-role client can read it, always behind a `requirePermission()` guard, and it
  must never appear in a response body, a log line, or an error message.

## 4. How the worker claims rows

`lib/marketing/worker.ts` claims work with **one statement**:

```sql
update marketing_deliveries
   set status = 'publishing'
 where status = 'scheduled' and scheduled_at <= $now
returning *
```

That single statement is the entire concurrency story. Under READ COMMITTED two
transactions cannot both claim a row: the second blocks on the row lock the first took,
and when the first commits the second **re-evaluates its `where`** against the new row
version, sees `publishing`, and drops the row from its result. The claimed sets are
disjoint and their union is every eligible row.

**Do not replace it with select-then-update.** Two statements have a window between
them, and two workers will both read `scheduled` and both publish — which posts twice.

**`runCronJob`'s lease is not a substitute.** Every job in this repo runs under a
Postgres advisory lease keyed `cron:<job>` (`lib/cron/runCronJob.ts`), and that lease is
**per job** — a genuinely *weaker* guarantee than the row claim. It stops two whole
scheduled runs overlapping. It does nothing about a scheduled run racing the "Run now"
button, an inline publish from Post now, a second region, or a retried invocation. The
row-level claim is what makes this safe; the lease is a courtesy on top of it.

Per claimed delivery, in order: load the entry, its media **ordered by
`marketing_entry_media.position`**, and the account → look the channel up in the registry
(unknown channel is a readable failure, never a throw) → `validate`, and **stop there if
it says no, without calling publish** → `publish` with the delivery's existing
`external_ids`. Success writes the merged ids, `published_at` and `published`; failure
writes the sentence, `attempt_count + 1` and `failed`, and **stays failed until a person
acts**. A delivery whose account has been unlinked is `skipped`, not failed — there is no
credential and no retry that could invent one. One delivery blowing up never abandons the
batch.

---

## Two things that will otherwise trip you up

**Entry status is derived by a database trigger; app code writes only `draft` and
`approved`.** `public.marketing_entry_status_refresh()` fires on every insert, update and
delete of a delivery and recomputes the parent entry by a ladder, first match wins: any
`publishing` → `in_progress`; else any `failed` → `failed`; else all active `published` →
`done`; else all active `pending` → derive nothing; else any active → `scheduled`; else
(no deliveries, or all `skipped`) → derive nothing. `publishing` outranks `failed` on
purpose — while a channel is still moving the entry is still in progress. "Derive
nothing" is what lets a draft keep its channels: a set of deliveries that is entirely
`pending` is a person's channel choice, not queued work.

"Derive nothing" has one qualification, and it is the fix for a bug chip 7 found: an
entry already sitting on a *derived* status falls back to `approved` rather than keeping
it. Leaving it alone froze entries — an approved entry whose only delivery went
`publishing` and then `skipped` read `in_progress` forever, with nothing in flight and no
way out. A `draft` or `approved` entry is still left exactly as it is, which is what that
rung was always for. **App code that writes a derived
status is a bug even when it happens to be right.**

**`details` is owned by plugins and the chassis never reads it.** It is a per-kind
`jsonb` bag on `marketing_calendar_entries`: the API passes it through untouched, no
query filters on a key inside it, and no screen renders one. A plugin may put whatever
its kind needs there. Do not give the chassis a reason to look inside.
