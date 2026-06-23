# Spec 9: Packaging Variations Foundation

## Background

This spec started as a narrower "container vs. component split" for `packaging_items`, triggered by a fragmentation bug in Export Settings' Packaging Fee mapping (see `docs/superpowers/ROADMAP.md` "Active situation"). During brainstorming, the user reframed the actual underlying problem: **BOM (bill of materials) is disconnected from production planning.**

Production planning and cold storage only care about *physical containers*, grouped by volume (1/2 Keg, 1/4 Keg, 1/6 Keg, 12oz Can, 16oz Can). Input/cost/deposit accounting cares about the *components* that go into producing a container (lid, paktech, tray, label) and their costs. Today these are conflated in one `packaging_items` table with no structured link between them, and the system has no concept of a distinct, non-substitutable **packaging variation** — e.g. "12oz Can, 4-Pack, white-labeled for Partner X" is a different shippable thing than "12oz Can, 4-Pack, generic," but today that distinction only exists as a free-text `variant_label` string typed in at transfer time, with no link back to which components actually produced it or what they cost.

This spec is the **foundation** for fixing that: defining the data model for a packaging variation as a first-class, reusable entity. Wiring it into the actual production/export/invoicing flows is explicitly deferred to follow-on specs (see "Out of scope" below) — this spec only makes variations definable, not yet consumed anywhere downstream.

## Goal

Let a packaging variation be strictly defined once (container + format + which specific lid/paktech/tray/label components it uses + which partner, if any, it's exclusive to) and reused, instead of re-assembled ad hoc on every transfer with no persisted record of "what is this combination, exactly."

## Schema

**`packaging_items` is not split.** The container-vs-component distinction is already fully expressed by its existing `type` column (`keg|can` = container, `lid|paktech|tray|label` = component). A physical table split would force every one of its ~8 existing consumers to migrate FKs for no new capability — the only thing actually missing is enforcement and a place to combine them. Two changes here:

1. Tighten `type` from unconstrained `text` to `text` + `check (type in ('keg','can','lid','paktech','tray','label'))`. Not a native Postgres `enum` — this codebase's convention (`status`, `channel`, `service_type`, `unit` columns) is `text` + `CHECK` for any categorical column expected to gain values over time, reserving native `enum` types for genuinely fixed sets (`user_role`, `export_channel`). `packaging_items.type` already gained a related field once (`requires_label`, added post-launch) and may gain new container/component kinds later, so it follows the `CHECK` convention, not the `enum` one.
2. New table, `packaging_variations`:

```sql
create table public.packaging_variations (
  id            uuid        primary key default gen_random_uuid(),
  container_id  uuid        not null references packaging_items(id),  -- type must be keg/can
  format        text        not null check (format in ('loose', '4-pack', '6-pack', 'case')),
  lid_id        uuid        references packaging_items(id),           -- type must be lid
  paktech_id    uuid        references packaging_items(id),           -- type must be paktech
  tray_id       uuid        references packaging_items(id),           -- type must be tray
  label_id      uuid        references packaging_items(id),           -- type must be label
  partner_id    uuid        references contract_brewing_partners(id) on delete set null,  -- null = generic, available to everyone
  name          text        not null,
  is_active     bool        not null default true,
  created_at    timestamptz not null default now()
);
```

No junction table: a variation uses at most one component per category (one lid, one paktech-*or*-tray, one label) — never multiples of the same category — so four nullable FK columns fully capture it, mirroring the named slots the existing kegging/canning transfer dialog already uses (`lid_packaging_id`, `paktech_packaging_id`, `tray_packaging_id`, `label_packaging_id`). Quantity-per-unit (e.g. "4 cans per paktech," "24 cans per tray") doesn't need to live on this table either — it's already encoded on the chosen component row via `packaging_items.can_count`.

`format` determines which component slots are expected to be filled (app-level validation in the write route, not a DB constraint, to avoid an unmaintainable check expression): `loose` → no `paktech_id`/`tray_id`; `4-pack`/`6-pack` → `paktech_id` required, `tray_id` null; `case` → `tray_id` required, `paktech_id` null. `lid_id`/`label_id` are independently optional regardless of format (a can variation might have no separate lid component if it's pre-sealed, or no label if it's a generic blank can).

Seed data covers the 11 named examples from brainstorming: 1/2 Keg, 1/4 Keg, 1/6 Keg (all `format='loose'`, no can-specific slots), 12oz Can, 16oz Can (loose), 12oz Can 4-Pack, 12oz Can 6-Pack, 16oz Can 4-Pack, 16oz Can 6-Pack, 12oz Can Case, 16oz Can Case — all `partner_id` null (generic) initially; partner-specific overrides (e.g. a white-labeled variant) get added later through the same CRUD UI once a real need exists.

**`recipe_packaging_variations`** — new join table, mirrors the existing `recipe_square_links` pattern: which variations a given recipe can be packaged as.

```sql
create table public.recipe_packaging_variations (
  id            uuid        primary key default gen_random_uuid(),
  recipe_id     uuid        not null references recipes(id) on delete cascade,
  variation_id  uuid        not null references packaging_variations(id),
  created_at    timestamptz not null default now(),
  unique (recipe_id, variation_id)
);
```

A variation is recipe-agnostic by design (the same "12oz Can 4-Pack, Partner X" combination could apply to multiple beer recipes); this join table is where a specific recipe declares which variations it's actually packaged as.

## UI

**Definition screen** for managing `packaging_variations` — container → format → component-slot pickers, directly modeled on the existing kegging/canning transfer dialog's layout, but the result is *saved* as a named, reusable row instead of re-entered every transfer. Lives alongside the existing packaging CRUD (`PackagingTab.tsx`'s area), not a new top-level nav entry.

**Recipes UI** — new section per recipe (mirrors `SquareLinkManager.tsx`'s existing recipe↔packaging linking pattern) listing/managing which `packaging_variations` that recipe uses.

## Out of scope (deferred to follow-on specs, each independently brainstormed/planned/reviewed)

- **Brewing/kegging-canning + cold storage wiring**: migrating the actual transfer flow (`app/api/production/transfers/route.ts`) to consume a `packaging_variation_id` instead of ad-hoc component picks, and migrating `cold_storage_inventory` to key off `variation_id` instead of `(packaging_item_id, variant_label)` free text. This is also where the previously-confirmed demand-calendar bug belongs: `app/api/production/demand-calendar/route.ts:73-81` guesses a per-lot packaging item via "default for this type" instead of using the real id `cold_storage_inventory` already stores per lot — fixing it properly means joining through the new variation model, not patching the old proxy lookup.
- **Intake/Commitments + deposit invoicing wiring**: `commitment_packaging_preferences` and deposit-invoice cost calculation switching to variation-based component costs (this is also where Spec 8, deposit-invoice/export-invoice parity, will need to land — the two efforts should be sequenced together when picked up).
- **Export wiring**: Export Settings' Packaging Fee mapping moving from `packaging_item_id` to `container_id` (volume-only, per the principle that packaging fees only care about volume) — this is also where the previously-confirmed `ExportSettingsPanel.tsx:248` fragmentation bug gets fixed properly, by mapping over containers only instead of patching a type filter onto the old shape.
- Any new packaging container/component kinds beyond the existing 6 `type` values.
- Stock-quantity read-then-write race condition noted during the original audit pass (`transfers/route.ts:66-69`, `:103-106`) — unrelated to the variations model, can be picked up independently if it ever proves to be a real issue (single-location, low-concurrency usage today).

## Success criteria

- `npm run lint` + `npm run build` clean.
- `packaging_variations` and `recipe_packaging_variations` created and verified via direct REST check against the live database, seeded with the 11 generic variations listed above.
- New definition UI can create/edit a variation end-to-end (container, format, component slots, optional partner) and the Recipes UI can link/unlink a recipe to a variation.
- No existing consumer of `packaging_items` is changed or broken by this spec — it only adds new tables/UI, consumed by nothing yet.
