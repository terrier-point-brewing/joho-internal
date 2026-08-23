# Season kit — chip 1: schema

**Read `docs/brand/season-kit-spec.md` in full first**, and
`docs/marketing/CONVENTIONS.md` §6 for how this repo does migrations and RLS —
the conventions there are repo-wide, not marketing-specific, despite where they
live. Where this brief and either document disagree, stop and report.

---

## 1. Intent

A season is the rotation a brand runs on: a ground colour, a chop glyph, motifs,
and the art direction and voice that go with them. Today `brand_seasons` holds
the first two and nothing else, one season exists, and every field on it is
empty. This chip gives a kit somewhere to live.

**The organising rule, which every decision here follows from: a season selects
and inflects. It never redefines.** The canon owns the brand's colours, type,
voice and placement. A season chooses from that set and adds a seasonal layer.
If something here seems to need a new brand colour or a canon change, **stop and
report** — the canon is what should change, not the season.

## 2. What this chip owns

**Exactly one migration**, `supabase/migrations/<full YYYYMMDDHHMMSS>_brand_season_kit.sql`.
Take a full 14-digit stamp; `check:migrations` fails on a shared version and
parallel branches have collided in this repo four times.

### 2.1 `brand_season_assets`

```
season_id  uuid not null references brand_seasons(id) on delete cascade
asset_id   uuid not null references brand_assets(id)
role       text not null check (role in ('motif','example','texture'))
position   int  not null
primary key (season_id, asset_id, role)
```

A row rather than a string in a blob — an asset has to be ordered, re-roled and
queried, and this repo has already paid for that lesson once
(`20261016090000_ingredient_unit_vocabulary.sql` is the precedent).

The same asset may hold two roles in one season; that is why `role` is in the
key. Index `(season_id, role, position)`.

### 2.2 `brand_seasons.palette jsonb not null default '{}'`

A map of **role → canon token key**. Roles, and no more: `ink`, `accent`.

`ground` is deliberately absent: it is the season's own colour and already lives
in `background_hex`. Everything else points at a **canon token key, never a raw
hex** — so a canon change propagates, and a season cannot quietly invent a
fourth brand colour.

Validation belongs in `lib/brand/`, not in a CHECK constraint: the valid set is
whatever the canon currently declares, and an enumerated constraint over another
system's vocabulary is exactly the mistake `20260913` and
`project_constrain_casing_not_vocabulary` record. **Constrain the shape in SQL,
the vocabulary in TypeScript.**

### 2.3 `brand_seasons.voice_note text`

One or two sentences on how the season sounds. An inflection of the canon's
voice, never a replacement.

### 2.4 Migrate `motif_set` into rows

`motif_set` is a jsonb array of `{assetId, note?}`. Copy each entry into
`brand_season_assets` with `role='motif'` and `position` from array order.

**Nothing reads `motif_set` today** — `SeasonEditor.tsx` says so explicitly — so
there is no compatibility to preserve. Leave the column in place, do not drop
it: dropping it is a separate decision once the UI writes rows instead, and this
migration should be re-runnable without destroying anything.

Make the copy idempotent (`on conflict do nothing`) so a replay is a no-op. In
practice it will copy zero rows, because the one season is empty — say so in the
report rather than implying it moved data.

### 2.5 RLS and triggers

```sql
alter table public.brand_season_assets enable row level security;
select public.apply_grant_policies('brand_season_assets', 'brand.templates');
```

`brand.templates` because authoring a season is template-tier work — the same
scope `SeasonEditor` already sits behind. Attach `public.update_updated_at()` if
you give the table an `updated_at`; if you do not, do not invent one.

## 3. Gate

- [ ] `check:migrations --strict` green, and **re-check `main` right after merge** — a parallel branch can take your version.
- [ ] `npm run verify` green.
- [ ] Applied via the **Supabase MCP** `apply_migration`, never `db push`.
- [ ] Re-running the whole file is a no-op. Prove it by running it twice and comparing a catalog fingerprint.
- [ ] RLS verified as a **non-privileged role**: a holder of `brand.templates:read` sees rows, someone without it sees none. Paste the results.
- [ ] The `motif_set` copy is idempotent, and you state plainly how many rows it actually moved.
- [ ] A rollback block, executed once inside a rolled-back transaction.

## 4. Do not build

- Any TypeScript, UI, or route. **This chip is one `.sql` file.**
- The clone path or the completeness gate — chip 3.
- Any change to `brand_canon`, `brand_templates`, `brand_outputs`, or the label path.
- Dropping `motif_set`.
- A `ground` role in `palette`.
- A CHECK constraint enumerating canon token keys.
- Any port in `lib/marketing/ports/`.

## 5. Report back

What you created, every gate result with pasted RLS output, how many `motif_set`
entries actually moved, any deviation and why, and anything in this brief that
turned out to be wrong about the repo.
