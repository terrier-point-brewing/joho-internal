-- Packaging Variations foundation (Spec 9). Lets a strictly-defined
-- combination of container + format + components be named and reused,
-- instead of re-assembled ad hoc on every kegging/canning transfer with
-- no persisted record of what the combination actually was. Wiring this
-- into transfers/cold storage/export/deposit flows is deferred to
-- follow-on specs (10, 11, 8) — this migration only adds the entity.

-- Tighten packaging_items.type from unconstrained text to a checked set.
-- Kept as text + CHECK (not a native enum) per this codebase's convention
-- for categorical columns expected to gain values over time (see status,
-- channel, service_type, unit columns elsewhere in this schema).
alter table public.packaging_items
  drop constraint if exists packaging_items_type_check;
alter table public.packaging_items
  add constraint packaging_items_type_check
  check (type in ('keg', 'can', 'lid', 'paktech', 'tray', 'label'));

create table public.packaging_variations (
  id            uuid        primary key default gen_random_uuid(),
  container_id  uuid        not null references public.packaging_items(id) on delete restrict,
  format        text        not null check (format in ('loose', '4-pack', '6-pack', 'case')),
  lid_id        uuid        references public.packaging_items(id) on delete restrict,
  paktech_id    uuid        references public.packaging_items(id) on delete restrict,
  tray_id       uuid        references public.packaging_items(id) on delete restrict,
  label_id      uuid        references public.packaging_items(id) on delete restrict,
  partner_id    uuid        references public.contract_brewing_partners(id) on delete set null,
  name          text        not null,
  is_active     bool        not null default true,
  created_at    timestamptz not null default now()
);

create index packaging_variations_container_idx on public.packaging_variations(container_id);
create index packaging_variations_partner_idx on public.packaging_variations(partner_id);

create table public.recipe_packaging_variations (
  id            uuid        primary key default gen_random_uuid(),
  recipe_id     uuid        not null references public.recipes(id) on delete cascade,
  variation_id  uuid        not null references public.packaging_variations(id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (recipe_id, variation_id)
);

create index recipe_packaging_variations_recipe_idx on public.recipe_packaging_variations(recipe_id);

-- Seed the 11 generic (partner_id null) variations named during brainstorming.
-- container_id values are looked up by name since this repo has no seeded
-- packaging_items rows with stable ids — these names match the live data
-- confirmed during Spec 9's brainstorm (1/2 Keg, 1/4 Keg, 1/6 Keg, 12oz Blank,
-- 16oz Blank). Component slots (lid/paktech/tray/label) are left null in
-- this seed since assigning a specific live component to each pack/case
-- format is a real product decision, not something to default silently —
-- the user fills those in via the new UI once it exists.
insert into public.packaging_variations (container_id, format, name)
select id, 'loose', name
from public.packaging_items
where type = 'keg' and name in ('1/2 Keg', '1/4 Keg', '1/6 Keg');

insert into public.packaging_variations (container_id, format, name)
select id, 'loose', name
from public.packaging_items
where type = 'can' and name in ('12oz Blank', '16oz Blank');

insert into public.packaging_variations (container_id, format, name)
select id, v.format, concat(p.name, ' ', v.label)
from public.packaging_items p
cross join (values ('4-pack', '4-Pack'), ('6-pack', '6-Pack'), ('case', 'Case')) as v(format, label)
where p.type = 'can' and p.name in ('12oz Blank', '16oz Blank');
