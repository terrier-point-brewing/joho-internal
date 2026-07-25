-- Draft swap transitions: a frozen record of a tap's beer change.
--
-- A Draft Restock ring is a point-in-time fact ("tap 3's keg was changed at
-- 4:12pm") but `tap_assignments` is mutable current state with no history, so a
-- beer-changing swap could only ever express ONE recipe. The outgoing beer's
-- draft SKU was never zeroed (it kept its leftover fl oz in Square forever) and
-- its shrinkage was filed against the incoming beer.
--
-- A row here is opened by the explicit "Swap keg" action on Draft Stats and
-- snapshots BOTH sides — recipes, packaging variations, coded volumes, and Square
-- draft SKU ids — so nothing about booking the swap depends on state that can be
-- edited between the swap and the ring. The taproom-consumption sync consumes it
-- exactly once, stamping `consumed_source_ref` with the restock line's source_ref.
create table if not exists public.tap_swap_transitions (
  id                             uuid primary key default gen_random_uuid(),
  tap_number                     int not null,
  -- Outgoing side. Nullable throughout: a transition may fill a previously empty
  -- tap, in which case there is no keg to write off and nothing to zero.
  from_recipe_id                 uuid references public.recipes(id) on delete set null,
  from_variation_id              uuid references public.packaging_variations(id) on delete set null,
  from_volume_fl_oz              numeric,
  from_draft_square_variation_id text,
  -- Incoming side. Required — a transition with no destination is meaningless.
  to_recipe_id                   uuid not null references public.recipes(id) on delete cascade,
  to_variation_id                uuid not null references public.packaging_variations(id) on delete cascade,
  to_volume_fl_oz                numeric not null,
  to_draft_square_variation_id   text,
  retire_outgoing                boolean not null default false,
  opened_at                      timestamptz not null default now(),
  consumed_source_ref            text,
  consumed_at                    timestamptz,
  created_at                     timestamptz not null default now()
);

-- FIFO lookup of pending transitions per tap.
create index if not exists tap_swap_transitions_pending_idx
  on public.tap_swap_transitions (tap_number, opened_at)
  where consumed_source_ref is null;

-- One restock ring can never be claimed by two transitions. The sync's claim is a
-- conditional `update ... where consumed_source_ref is null`; this index is the
-- backstop, since the Square webhook fires the sync on every order.* event and a
-- single restock produces a burst of overlapping runs.
create unique index if not exists tap_swap_transitions_source_ref_key
  on public.tap_swap_transitions (consumed_source_ref)
  where consumed_source_ref is not null;

alter table public.tap_swap_transitions enable row level security;

-- Operational table, matching the RLS posture of tap_assignments and
-- draft_pour_consumption. The cron/webhook sync uses the service-role client,
-- which bypasses RLS regardless.
create policy tap_swap_transitions_authenticated_all
  on public.tap_swap_transitions for all
  to authenticated using (true) with check (true);

comment on table public.tap_swap_transitions is
  'Frozen record of a tap beer change, opened by the Draft Stats "Swap keg" action and consumed exactly once by the matching Draft Restock ring. Both sides are snapshotted so later tap_assignments edits cannot re-attribute a booked swap.';

comment on column public.tap_swap_transitions.from_recipe_id is
  'Outgoing recipe. Null when this transition fills a previously empty tap — no write-off, no zeroing, no retire.';

comment on column public.tap_swap_transitions.retire_outgoing is
  'True only when THIS transition flipped taproom_recipe_settings.is_retired on the outgoing recipe. Cancelling the swap un-retires only in that case, so a beer that was already retired beforehand is left alone.';

comment on column public.tap_swap_transitions.consumed_source_ref is
  'export_transactions.source_ref of the Draft Restock line that consumed this transition (sqtransfer:<orderId>:<lineUid>). Null while pending.';
