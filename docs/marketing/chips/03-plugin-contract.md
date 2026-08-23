# Chip 3 — Plugin contract, registry, and the fake plugin

**Read `docs/marketing/CONVENTIONS.md` in full before writing anything.** Where this
brief and the conventions sheet disagree, stop and report.

Chip 1 (section + permissions) is merged on `main`. Chip 2 (schema) is being built
**in parallel with you** — it owns `supabase/migrations/**` and nothing else. Do not
create a migration, do not query the database, and do not import a Supabase client.

---

## 1. Intent

Marketing is one calendar; a robot that publishes what is on it through pluggable
channels; and later an assistant that proposes entries. Humans approve — nothing
publishes or spends without a human action.

A **channel plugin** is the only thing that knows how a specific service works.
Everything else — the worker, the routes, the UI — reaches a channel *only* through
the registry, so adding Instagram later is one folder plus one registry line and no
edits anywhere else.

This chip builds that contract and a **fake plugin**, which is how the entire chassis
gets proven without a single real credential. **Everything that talks to an outside
service is a later module.** Nothing you write here makes a network call.

## 2. What this chip owns

Everything under `lib/marketing/plugins/`, and nothing outside it.

```
lib/marketing/plugins/
  types.ts          the contract + its supporting types
  registry.ts       channel -> plugin
  registry.test.ts
  fake/
    index.ts        the fake plugin
    index.test.ts
```

Put the logic in `lib/` (not `app/`) — the coverage ratchet counts `lib/**` only, and
this chip is the most testable thing in the whole chassis.

### 2.1 The contract

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

Keep that shape. Define the supporting types yourself, aligned to the columns chip 2
is creating **right now** — they are fixed, so write to them and do not invent
alternatives:

- `Entry` mirrors `marketing_calendar_entries`: `id`, `kind`, `startsAt`, `endsAt | null`, `caption`, `details`, `status`, `origin`, `tags`.
- `Media` mirrors `marketing_media`: `id`, `type: "image" | "video"`, `url`, `width`, `height`, `durationS`, `bytes`.
- `ConnectedAccountInput` is what a completed OAuth callback hands back for insertion into `marketing_connected_accounts`: `provider`, `channel`, `externalId`, `externalParentId`, `handle`, `credentials`, `tokenExpiresAt`, `scopes`.
- `PublishContext`: the `entry`, its ordered `media`, the `account`, and the delivery's **existing `externalIds`** — see 2.3.
- `ValidationResult`: `{ ok: true } | { ok: false; reasons: string[] }`.

`reasons` are shown to a person in Compose next to a disabled channel, so they are
sentences ("A reel needs a video."), not codes. Say so in a doc comment.

`details` is a per-kind bag **owned by plugins. The chassis never reads it** — type it
as an opaque record and do not give the chassis a reason to look inside.

TypeScript only. `validate` is synchronous by design: the UI calls it on every
keystroke.

### 2.2 The registry

`registerChannel(plugin)`, `getChannel(channel)`, `listChannels()`. One map,
`channel → plugin`. Registering the same channel twice is a thrown error, not a silent
overwrite.

**The fake is registered only outside production.** Gate it on
`process.env.NODE_ENV !== "production"` at the point of registration, and test both
branches. With only the fake registered, dev and test list one channel; production
lists **nothing**, and every consumer — the Settings screen, Compose's channel picker
— must render correctly against an empty registry. That empty case is a real state
this chassis ships in, not an edge case.

### 2.3 The fake plugin

Test and dev only. It is the instrument the rest of the chassis is measured with, so
it has to be honest and controllable:

- **Configurable outcome:** succeed · fail · succeed-after-retry (fail once, then
  succeed). Settable per instance; no global mutable state that leaks between tests.
- **Records its calls** — which methods, with what arguments, in order — so a test can
  assert the worker validated before publishing, and did not publish twice.
- **Honours idempotency via `externalIds`.** If `PublishContext` already carries
  external ids for this delivery, `publish` returns them **without performing a second
  publish**, and the recorded calls must make that visible. This is the exact
  behaviour every real plugin will be required to have on retry, so the fake is where
  it gets specified.
- `authUrl`/`callback` return plausible fixed values. **No network calls, no timers,
  no randomness** — the tests must be deterministic.

### 2.4 Tests

Unit tests are the gate for this chip; it is pure logic with no UI and no I/O, so
"covered" means covered. At minimum:

- the registry: register, get, list, duplicate-registration error, unknown channel, the production/non-production branches
- validate: an ok result, and a not-ok result carrying readable reasons
- publish: success, failure, succeed-after-retry
- **idempotency: given existing `externalIds`, publish does not publish again and returns the same ids**
- the call recorder reports order and arguments

## 3. Gate

- [ ] `npm run verify` green — including `check:marketing-boundary`, which now also catches relative-path escapes, so a stray `../../lib/finance/x` will fail.
- [ ] `npm run build` green.
- [ ] `npm test` green, with your new tests listed in the run.
- [ ] Coverage did not regress (the `lib/**` ratchet is at 86% lines/statements).
- [ ] Grep your own diff and confirm **zero** imports of `@/lib/supabase`, zero `fetch`, zero `Date.now()`/`Math.random()` inside the fake, and no file created outside `lib/marketing/plugins/`.

## 4. Do not build

- Any migration, table, or database query. Chip 2 owns the schema and is running now.
- Any API route, page, or component.
- The worker, the retry route, `vercel.json`, or anything in `lib/cron/`.
- Instagram, Facebook, Meta, Google, or **any real channel plugin or credential**. The fake is the only plugin that exists.
- Any port interface in `lib/marketing/ports/` — the README there stays alone until a later module needs one.
- Any proposals/assistant machinery. `origin = "assistant"` is a valid value and nothing more.
- Any ad, boost, or metrics logic.
- Anything brand-scoped.

## 5. Report back

What you built · gate results · the fake's configuration surface in three lines, since
chips 4 and 6 will drive it · anything you deviated from and why · anything in this
brief that turned out to be wrong. **If the contract needs to change shape, stop and
report — chips 4, 5 and 6 are all written against it.**
