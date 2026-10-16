-- A partner can ask for part of a batch, and the brewery can counter.
--
-- A batch request still names whole turns (the brew is sized in turns), but
-- the partner may want less beer than the turns yield. wanted_bbl is what they
-- actually want; share_pct is the slice of the brew that works out to. The
-- brewery either approves at that share or offers a different one, with a
-- note; the request then waits on the partner ('adjusted') until they accept
-- (back to 'submitted' at the offered share) or rescind ('withdrawn').

alter table public.partner_requests
  add column if not exists wanted_bbl        numeric(10,2) check (wanted_bbl is null or wanted_bbl > 0),
  add column if not exists share_pct         numeric(5,2)  check (share_pct is null or (share_pct > 0 and share_pct <= 100)),
  add column if not exists offered_pct       numeric(5,2)  check (offered_pct is null or (offered_pct > 0 and offered_pct <= 100)),
  add column if not exists offered_bbl       numeric(10,2) check (offered_bbl is null or offered_bbl > 0),
  add column if not exists offer_note        text,
  add column if not exists offered_by        uuid references auth.users(id) on delete set null,
  add column if not exists offered_at        timestamptz,
  add column if not exists offer_answered_at timestamptz;

alter table public.partner_requests drop constraint if exists partner_requests_status_check;
alter table public.partner_requests
  add constraint partner_requests_status_check
  check (status in ('submitted', 'adjusted', 'approved', 'declined', 'withdrawn'));

-- Existing batch requests asked for the whole brew.
update public.partner_requests
   set wanted_bbl = volume_bbl, share_pct = 100
 where kind = 'batch' and wanted_bbl is null;

comment on column public.partner_requests.wanted_bbl is
  'Batch requests: the beer the partner actually wants, at most the turns'' fill (volume_bbl). Claims: null.';
comment on column public.partner_requests.share_pct is
  'Batch requests: wanted_bbl as a share of the brew. Updated to the offered share when the partner accepts an adjustment.';
comment on column public.partner_requests.offered_pct is
  'The share the brewery countered with, while status = adjusted. Kept afterwards as history.';
