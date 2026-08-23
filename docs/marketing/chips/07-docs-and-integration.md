# Chip 7 — Documentation, and proving the whole chassis at once

**Read `docs/marketing/CONVENTIONS.md` in full before writing anything.**

Chips 1–6 are merged. Every one of them passed its own gate in isolation, on its own
branch, at a different moment. **Nobody has yet run all of those gates against one
integrated tree.** That is what this chip is for. It is not a formality: three of the
six chips needed an orchestrator fix after reporting green, and one of those fixes was
to a rule the earlier chips had already been tested against.

---

## 1. Intent

Marketing is one calendar; a robot that publishes what is on it; later an assistant
that proposes entries. Humans approve — nothing publishes or spends without a human
action.

The chassis is the part that does not change when a channel, an ad platform, or the
assistant arrives. This chip declares it finished — or finds out that it is not.

## 2. What this chip owns

### 2.1 `docs/marketing/README.md`

The document someone reads before adding the first real channel. Four things, and
resist writing a fifth:

1. **The boundary rules** — what may import marketing (nothing, bar two named exceptions), what marketing may import, why the seam exists, and that the fix for a violation is a port rather than a wider allowlist.
2. **The plugin contract** — the four members of `ChannelPlugin`, and specifically that `validate` is synchronous because Compose calls it on every keystroke, and that **`publish` must be idempotent on `externalIds` because you cannot un-post.**
3. **How to add a plugin** — one folder, one registry line, no edits anywhere else. Write it as steps someone can follow, and point at `lib/marketing/plugins/fake/` as the worked example.
4. **How the worker claims rows** — the single `update … where status='scheduled' … returning` statement, why it is one statement, and that `runCronJob`'s lease is per-job and therefore a **weaker** guarantee than the row claim.

Also record, briefly, the two things a future reader will otherwise trip over: entry
status is derived by a database trigger and app code writes only `draft`/`approved`;
and `details` is owned by plugins and never read by the chassis.

### 2.2 Update `docs/marketing/CONVENTIONS.md`

It was written before any of this existed and has been corrected three times since.
Fold in what is now known — the boundary exception list, the daily cron and why, the
`marketing.*` scopes as built. **Do not rewrite it into a summary of the module**; it
remains a description of the repo's idioms.

### 2.3 The integrated gate run

Re-run **every chip's gate against `main`**, in one tree, in one sitting. The full list
is in §4 of each chip brief and in §4 of the original orchestrator spec. At minimum:

- `npm run verify`, `check:permissions --strict`, `check:migrations --strict`, `npm run build`.
- **The boundary lint, both directions and both spellings** — aliased and relative, in and out — plus a probe proving each named exception is narrow rather than a hole.
- **The worker's concurrency proof, re-run.** 100 deliveries, two concurrent invocations, exactly 100 publishes, zero duplicates.
- Failure path, validation short-circuit, retry-does-not-republish, `CRON_SECRET` rejection.
- The **status trigger's full ladder**, including the all-pending rung added in #486, against the live database in a rolled-back transaction.
- **RLS per table as a non-privileged role**, including that `marketing_connected_accounts` is unreadable outright rather than merely empty.
- The API round trips: text-only entry, multi-media order, half-open window, Post now publishing inline, draft-with-channels staying `draft`.
- The UI, in a browser, per chip 6's list.

**Report each result as what it actually was.** A gate you could not run is a gate you
say you could not run. Do not restate a chip's earlier claim as though you had
re-observed it — the point of this chip is the re-observation.

### 2.4 Close the loop on production

- Confirm the six tables, the trigger, the bucket and the cron entry are all present and correct in the project.
- Confirm **zero rows** in every `marketing_*` table — no test data survived any chip.
- Confirm `main`'s newest migration has no version collision, and that the Vercel production deployment for `main` actually succeeded.

## 3. What you may fix, and what you must report instead

**Fix**: a broken or missing test, a stale comment, a doc that contradicts the code, a
gate that cannot be run as written, a small inconsistency between chips (naming,
error-message voice, a missing column comment).

**Report, do not fix**: anything that changes schema, the plugin contract, the claim
statement, a permission scope, or a route's behaviour. Those are design changes. If a
gate fails for a real reason, **say so plainly and stop** — a red gate reported
honestly is the single most valuable thing this chip can produce, and quietly
adjusting the gate until it passes is the one outcome that would make the whole
exercise worthless.

## 4. Gate

- [ ] Every item in §2.3, each with its actual result.
- [ ] Every item in §2.4.
- [ ] `docs/marketing/README.md` exists and covers all four topics.
- [ ] A short **deviation register**: every place the built chassis differs from the original orchestrator spec, with the reason. There are at least six that I know of (no `marketing` schema; `credentials` rather than `encrypted_token`; scope+level rather than flat grant keys; the cron-shaped worker rather than a bare secret-checked POST; daily rather than 5-minute; no `media/complete`). Find any I have missed.

## 5. Do not build

- Any new feature, subtab, component, or route.
- Any real channel plugin or credential.
- Any metrics writer.
- Any schema change (see §3).
- Any port interface — `lib/marketing/ports/` keeps its README and nothing else until a later module needs one.

## 6. Report back

The integrated gate results in full · the deviation register · **anything that failed,
stated plainly** · and your honest answer to one question: *is this chassis actually
done, or does something still need to change before a real channel is built on it?*
