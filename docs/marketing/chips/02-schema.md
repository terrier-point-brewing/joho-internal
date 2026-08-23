# Chip 2 — Marketing schema

**Read `docs/marketing/CONVENTIONS.md` in full before writing anything.** It is the
authority on how this repo does migrations, RLS, triggers and storage. Where this
brief and the conventions sheet disagree, stop and report.

Chip 1 (section + permissions) is merged on `main`. Chip 3 (plugin contract) is being
built **in parallel with you** — it owns `lib/marketing/plugins/**` and nothing else.
Do not create, edit or anticipate anything under that path.

---

## 1. Intent

Marketing is one calendar holding posts, reels, stories and boosts; a robot that
publishes what is on the calendar through pluggable channels; and later an assistant
that proposes entries. Humans approve — nothing publishes or spends without a human
action.

This chip builds **the tables that hold all of it and nothing that reads or writes
them.** Every table here is inert until later chips arrive. That is intended: the
schema is the part that is expensive to get wrong, so it lands alone, once.

One brand. No `brand_id`, no per-brand scoping, anywhere.

## 2. What this chip owns

**Exactly one migration file**, `supabase/migrations/<full YYYYMMDDHHMMSS>_marketing_schema.sql`.

Take a **full 14-digit timestamp**, not a bare date. `scripts/check-migrations.mjs`
fails when two files share the digits before the first underscore, and parallel
branches have collided on this three times in this repo (#410, #412, #449).

### 2.1 Six tables, all in `public`, all prefixed `marketing_`

The orchestrator spec asked for a `marketing` Postgres schema. **It does not get
one.** No migration in this repo's 240 uses `create schema`, and — decisively —
`public.apply_grant_policies(table, scope)`, the house RLS applicator, hard-codes
`public.`. A separate schema would mean hand-writing every policy pair, which is the
drift that function exists to prevent.

| Table | Holds |
|---|---|
| `marketing_connected_accounts` | one login to one channel |
| `marketing_media` | the marketing library: uploads and finished creatives |
| `marketing_calendar_entries` | anything on the calendar |
| `marketing_entry_media` | which media an entry uses, ordered |
| `marketing_deliveries` | one row per entry × channel — the robot's work queue |
| `marketing_metrics` | per delivery per day; created empty, **no writer anywhere** |

**`marketing_connected_accounts`** — `id`, `provider`, `channel`, `external_id`,
`external_parent_id`, `handle`, `credentials jsonb not null default '{}'`,
`token_expires_at`, `scopes text[]`, `status`, `last_error`, `last_verified_at`,
`created_at`, `created_by`, `updated_at`. Unique `(provider, channel)`.
`status in ('connected','error','disconnected')`.

**`marketing_media`** — `id`, `type` (`image`|`video`), `url`, `storage_path`,
`width`, `height`, `duration_s`, `bytes`, `tags text[]`, `created_by`, timestamps.
`video` is accepted by the schema from day one and handled by nothing — that is a
deliberate open extension point, not a feature.

**`marketing_calendar_entries`** — `id`, `kind`, `starts_at not null`,
`ends_at null`, `caption`, `details jsonb not null default '{}'`, `status`,
`origin`, `tags text[]`, `created_by`, timestamps. Index on `(starts_at)`.
An entry is a **moment** when `ends_at` is null and a **band** when it is set.
`status in ('draft','approved','scheduled','in_progress','done','failed')`.
`origin in ('manual','rule','assistant')` — `assistant` is valid from day one and
written by nothing.
`details` is a per-kind bag **owned by plugins; the chassis never reads it.** Say so
in a column comment.

**`marketing_entry_media`** — `entry_id`, `media_id`, `position int not null`,
PK `(entry_id, media_id)`. Zero rows is legal and means a text-only entry.
`entry_id` cascades on delete.

**`marketing_deliveries`** — `id`, `entry_id`, `account_id`, `channel`,
`scheduled_at`, `status`, `external_ids jsonb not null default '{}'`, `error`,
`attempt_count int not null default 0`, `published_at`, timestamps.
Index on `(status, scheduled_at)` — the worker's claim query depends on it.
`status in ('pending','scheduled','publishing','published','failed','skipped')`.

**`marketing_metrics`** — `delivery_id`, `day date`, `reach`, `saves`, `comments`,
`clicks`, `impressions`, `spend_cents`, `conversions`. PK `(delivery_id, day)`.
Created empty. Nothing writes it in the chassis and nothing may.

Every table gets a `comment on table`, and every non-obvious column a
`comment on column`, in the voice of the neighbouring migrations.

### 2.2 RLS

```sql
alter table public.<t> enable row level security;
select public.apply_grant_policies('<t>', '<scope>');
```

| Table | Scope |
|---|---|
| `marketing_media`, `marketing_calendar_entries`, `marketing_entry_media` | `marketing.calendar` |
| `marketing_deliveries`, `marketing_metrics` | `marketing.publish` |
| `marketing_connected_accounts` | **none — see below** |

Those two scope strings are **not yet registered in `lib/auth/scopes.ts`** — chips 4
and 5 add them, because the permission linter fails on a scope with no capability.
That is fine and deliberate: `has_grant()` resolves plain text, `admin` satisfies
anything through its ROOT grant, and everyone else is denied until the scope becomes
grantable. Note it in the migration header so nobody "fixes" it.

**`marketing_connected_accounts` gets RLS enabled and NO POLICIES AT ALL.** It holds
credentials. That is the documented service-role-only posture used for the finance
tables (`20261003090000_rls_close_authenticated_read_gaps.sql` explains the intent at
length): every consumer goes through `createSupabaseAdminClient()` behind a
`requirePermission()` guard, and the Data API surface is shut.

This is deliberately **stricter than `integration_connections`**, the nearest
precedent, which calls `apply_grant_policies(..., 'finance.transactions')` and thereby
lets a finance reader select its `credentials` column over the Data API. Do not copy
that part of it.

### 2.3 The credentials column — read this before you reach for encryption

The spec calls for `encrypted_token`, encrypted at rest. **Store
`credentials jsonb` in the clear in a service-role-only table instead**, exactly as
`integration_connections.credentials` does (`20260913090000`), with the same style of
column comment: SECRET, service-role only, never in an API response.

Why: `supabase_vault` is installed but used by **zero** migrations and zero lines of
app code in this repo. Introducing it for one table means a decryption path in the
publish hot loop and a key-management story nobody else here follows — a parallel
abstraction, which is the thing the conventions sheet exists to prevent. The spec's
actual intent ("the client can never read the token") is met more strongly by a table
with no policies than by ciphertext behind a readable policy.

If you disagree after reading both migrations, **stop and report** — do not decide it
yourself.

Also: **do not attach `audit_trigger_fn()` to `marketing_connected_accounts`.**
`20260913090000` explains why — the audit trigger copies the whole row into
`audit_log`, which has a different access posture, so auditing a credential row leaks
the credential. Same reasoning, same answer.

### 2.4 The derived-status trigger

Entry status is derived from its deliveries. **App code sets only `draft` ↔
`approved`; everything else is the trigger's.**

Write `public.marketing_entry_status_refresh()`, firing
`after insert or update or delete on marketing_deliveries for each row`, recomputing
the parent entry's status by this precedence — first match wins:

1. any delivery `publishing` → `in_progress`
2. else any `failed` → `failed`
3. else at least one non-`skipped` delivery and all of them `published` → `done`
4. else at least one non-`skipped` delivery → `scheduled`
5. else (no deliveries, or all `skipped`) → leave the entry's app-set status alone

`publishing` outranks `failed` on purpose: while any channel is still moving, the
entry is still in progress; it only reads as failed once nothing is moving. Put that
sentence in the function body as a comment — it is the one rule a future reader will
otherwise flip.

Rule 5 must not clobber `draft`/`approved`. Deleting the last delivery returns an
entry to the status a person last chose, not to a derived one.

**Document the whole ladder in a `comment on function`.** The spec requires the
trigger be documented; this is where.

### 2.5 `updated_at`

Attach the existing `public.update_updated_at()` — `before insert or update`, on every
table here that has an `updated_at` column. **Never set `updated_at` from app code.**
One trigger owns it, repo-wide.

### 2.6 Storage bucket

```sql
insert into storage.buckets (id, name, public)
values ('marketing-media', 'marketing-media', true)
on conflict do nothing;
```

Path convention `{yyyy}/{mm}/{uuid}.{ext}`, recorded in a comment — chip 5 implements
it. **Public read is correct here and needs its rationale in the migration:** a
channel like Instagram fetches the creative from a URL we hand it, so a private
bucket cannot publish. Note also that this is the separate public bucket
`20260903_brand_assets_private.sql` explicitly reserved when it flipped
`brand-assets` private — the two buckets stay separate.

### 2.7 Applying it

Apply the migration to the project through the **Supabase MCP `apply_migration`**
(project ref in `CLAUDE.md`), never `supabase db push`. You need it applied to test
the trigger.

**You may create only the six tables, their indexes, their triggers, the one
function, and the bucket. You may not alter, drop or backfill any pre-existing
object.** If something existing appears to be in the way, stop and report.

## 3. Gate

- [ ] `npm run check:migrations -- --strict` green, and **re-check `main` right after your PR merges** — a parallel branch can take your version.
- [ ] `npm run verify` green.
- [ ] Migration applied via MCP, and **re-running the whole file is a no-op** (every statement `if not exists` / `create or replace` / `drop … if exists` first). Prove it by running it twice.
- [ ] `select public.has_grant(...)`-backed RLS proof, per table, as a **non-privileged role** — set the role to `authenticated` with a non-admin JWT claim and show that the five grant-gated tables return zero rows and `marketing_connected_accounts` is unreadable outright. Paste the results.
- [ ] **`marketing_connected_accounts` has zero policies** — prove with a `pg_policies` query, not an assertion.
- [ ] **Trigger tested for every transition in the ladder**, all five rules including the "deleting the last delivery leaves `approved` alone" case. Do this in a transaction you roll back, and paste the before/after status for each case.
- [ ] `updated_at` moves on update and is not settable by hand.
- [ ] Rollback block: the migration ends with a commented `-- rollback:` section that drops everything it created, in dependency order. Execute it once inside a rolled-back transaction to prove it is correct, and say you did.

## 4. Do not build

- Any TypeScript at all. **This chip is one `.sql` file and nothing else.**
- Any API route, page, component, or type definition.
- Anything under `lib/marketing/plugins/**` — chip 3 owns it and is running now.
- Any writer for `marketing_metrics`.
- Any ad column, Facebook column, or metrics writer.
- Any change to `lib/auth/**`, including registering `marketing.calendar` or `marketing.publish`.
- Any `brand_id` or brand scoping.
- Vault, pgcrypto, or app-side encryption (see 2.3).
- Any change to an existing table, function, policy or trigger.

## 5. Report back

What you created · every gate result with pasted output for the RLS and trigger
proofs · anything you deviated from and why · anything in this brief that turned out
to be wrong about the repo. **If the design needs to change, stop and report — do not
improvise schema.**
