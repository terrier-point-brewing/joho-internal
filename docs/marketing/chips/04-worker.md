# Chip 4 — The publishing worker

**Read `docs/marketing/CONVENTIONS.md` in full before writing anything**, especially
§8 (cron and background work). Where this brief and the conventions sheet disagree,
stop and report.

Chips 1–3 are merged on `main`: the section and its permissions, the six
`public.marketing_*` tables (already applied to the project), and the plugin contract
+ registry + fake plugin. **Chip 5 (API routes) runs after you, not beside you** — it
is written against the export you create in §2.3.

---

## 1. Intent

Marketing is one calendar; a robot that publishes what is on it; later an assistant
that proposes entries. Humans approve — nothing publishes without a human action.

**You are building the robot.** It is the only part of the chassis where a bug is
unrecoverable: you cannot un-post. Everything below is arranged around that one fact.

## 2. What this chip owns

### 2.1 The `marketing.publish` scope

Chip 1 registered `marketing.access` and `marketing.accounts` and deliberately left
this one out, because the permission linter fails on a scope no capability covers.
You give it a caller, so now it lands.

- `lib/auth/scopes.ts` — add `"marketing.publish": { label: "Publish", section: "marketing" }` next to the other marketing leaves, and **remove it from the deferred-scopes comment** chip 1 left there (leave the `marketing.calendar` half — chip 5 takes it).
- `lib/auth/capabilities.ts` — `marketingPublish: { scope: "marketing.publish", level: "operate" }`.
- `lib/auth/__tests__/capability-coordinates.test.ts` — **pin the new capability's `(scope, level)` or it will not compile.** Chip 1 hit this; it is not optional.
- The **scope-count canary** moves 31 → 32 in three places that must move together: `scopes.ts`'s header comment, `scripts/check-permissions.mjs` rule 4, and `roleGrants.test.ts`. The canary's own comment says adding a scope should trip it once — that is working as intended, not a failure to route around.
- **Do not touch `ROLE_BUNDLES`.** Role bundles are data in `role_permission_grants`; granting this to anyone is an admin action in Settings → Environment → Users. Editing the constant breaks `roleBundleSeedParity`.

### 2.2 Extend the boundary — do not weaken it

`lib/cron/jobs/index.ts` lives **outside** marketing and must import your worker to
register the job. As written, `scripts/check-marketing-boundary.mjs` rule 1 forbids
that, correctly.

Add **one narrow named exception**, in the exact style of the existing
`NAVBAR_EXCEPTION`: that one file may import that one module (`@/lib/marketing/worker`)
and nothing else. Both exceptions are the same shape — the host *mounting* marketing
(its nav, its scheduled work) rather than depending on marketing's internals — so say
that in the comment, and turn the single-exception constant into a small list rather
than bolting on a second special case.

**Extending what the guard can itemise is the correct move; loosening the rule is
not.** If you find yourself wanting to allow `@/lib/marketing/**` from `lib/cron/**`,
stop and report instead.

### 2.3 The worker — `lib/marketing/worker.ts`

Export exactly this, because chip 5 is written against it:

```ts
export async function runMarketingDeliveries(
  client: SupabaseClient,
): Promise<{ claimed: number; published: number; failed: number; skipped: number }>
```

**The claim is the whole game.** One statement:

```sql
update marketing_deliveries
   set status = 'publishing'
 where status = 'scheduled' and scheduled_at <= now()
returning *
```

That single statement is what makes two concurrent invocations safe — under READ
COMMITTED a row updated by one transaction is invisible to the other's `where`. Do
**not** replace it with select-then-update, and do not add an application-level lock
on top and call it equivalent. Put that reasoning in the function's doc comment; it is
the one thing a future edit will get wrong.

Per claimed delivery, in order:

1. Load the entry, its media **ordered by `marketing_entry_media.position`**, and the account.
2. `getChannel(delivery.channel)` from the registry. Unknown channel → `failed` with a readable error; never throw out of the loop.
3. `plugin.validate(entry, media)` — **fail fast.** Not ok → `failed`, error = the joined reasons, and **do not call publish**.
4. `plugin.publish(ctx)` with `externalIds` set to the delivery's current `external_ids`. That is the idempotency key the fake already honours.
5. Success → write `external_ids` (merged), `published_at`, `status='published'`. Failure → write `error`, `attempt_count + 1`, `status='failed'`.

**No automatic retries.** A failure stays failed until a person acts. One structured
log line per delivery. A single delivery blowing up must not abandon the rest of the
batch.

Credentials must never reach a log line or an error message.

### 2.4 The cron mounting

Follow §8 of the conventions sheet exactly — this repo has one way to do this and
nine jobs already doing it:

- `lib/cron/jobs/marketingDeliveries.ts` → calls `runMarketingDeliveries`.
- `lib/cron/jobs/index.ts` → register it (this is the boundary exception in §2.2).
- `lib/cron/registry.ts` → a `CRON_JOBS` entry: description, `maxAgeHours`, `manualRun`, and a `manualNote` written for a person who is about to press a button that posts to the internet.
- `app/api/cron/marketing-deliveries/route.ts` → `export const GET = createCronRouteHandler("marketing-deliveries")` and nothing else.
- `vercel.json` → `*/5 * * * *`, and the `schedule` in `registry.ts` must mirror it.

You get `CRON_SECRET` enforcement, the `cron_runs` audit row, the run lease and the
Settings → Cron Jobs monitor for free by doing it this way.

⚠️ **Verify the 5-minute cadence is actually accepted.** Every existing cron here is
daily, and some Vercel plans cap cron frequency. If a `*/5` schedule is rejected,
**report it — do not silently pick a different number.**

Note in the job's header that `runCronJob`'s lease is **per job**, which is a coarser
guarantee than the row-level claim; the claim is what makes concurrency safe, and the
lease only stops two whole runs overlapping.

### 2.5 Retry — `POST /api/marketing/deliveries/[id]/retry`

Gated on `CAP.marketingPublish`. Resets **exactly one row** to `scheduled` — nothing
else, no cascade to siblings. Leaves `external_ids` **intact**, because that is what
lets the plugin recognise already-published work and refuse to post twice.

Only a `failed` delivery may be retried; anything else is a 409 with a sentence.
Route stays thin — logic in `lib/marketing/`.

## 3. Gate

- [ ] `npm run verify`, `npm run check:permissions -- --strict`, `npm run build` — all green.
- [ ] **Concurrency: 100 scheduled deliveries, two concurrent worker invocations, exactly 100 publishes and zero duplicates.** Prove it twice over:
      **(a)** in-process, against a test client, asserting the fake recorded exactly 100 publishes and no delivery was published twice; and
      **(b)** the claim statement's atomicity against the **real database** via the Supabase MCP — insert 100 rows, run the claim from two sessions, assert the claimed sets are disjoint and together total 100, then delete every row you made.
      If the tooling cannot give you two genuinely concurrent sessions, **say so plainly and pin the exact claim statement in a test instead. Do not describe a proof you did not run.**
- [ ] Failure path: a failing plugin leaves `status='failed'`, a readable `error`, and `attempt_count` incremented.
- [ ] Validation failure short-circuits: `publish` is never called (assert on the fake's recorded calls).
- [ ] Retry resets exactly one row, and the plugin then observes the existing `external_ids` and returns them **without publishing again** — assert `publishAttempts()` did not move.
- [ ] Missing and incorrect `CRON_SECRET` are both rejected with 401.
- [ ] The boundary check still passes, and a deliberate `@/lib/marketing/plugins` import from some *other* file in `lib/cron/` still fails — prove the exception is narrow, not a hole. Paste the failure.
- [ ] Any real-DB rows you created are deleted. Confirm with a count.

## 4. Do not build

- Anything under `app/api/marketing/entries`, `app/api/marketing/media`, or `app/api/marketing/accounts` — **chip 5 owns those**, including "Post now".
- The `marketing.calendar` scope — chip 5 adds it.
- Any UI: no page, no component, no Compose, no calendar grid.
- Any real channel plugin, credential, or network call. The fake is still the only plugin.
- Automatic retries, backoff, or a dead-letter queue.
- Any writer for `marketing_metrics`.
- Any migration or schema change. If the worker seems to need a column, **stop and report**.
- Any edit to `ROLE_BUNDLES` or to an applied migration file.

## 5. Report back

What you built · every gate result, with the concurrency proof stated exactly as
strongly as you actually proved it and no stronger · whether Vercel accepted `*/5` ·
any deviation and why · anything in this brief that turned out to be wrong. **If the
design needs to change, stop and report.**
