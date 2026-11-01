-- Events: record the kegs an event used at close-out.
--
-- Event pours are rung on the Square "Event Pour" item, which the draft
-- reconcile never books against a keg, so the kegs an event tapped only leave
-- cold storage when someone ships them. Until now that was a production user
-- in Export Bay → Ad-Hoc Export → Taproom. The taproom manager now does it
-- from the event itself: POST /api/taproom/events/[id]/kegs writes the same
-- ad-hoc taproom shipment rows through the shared shipment writer, stamped
-- `source_ref = 'event:<event_id>:<line uuid>'`, and sets `closed_at`.
--
-- `closed_at` is the UI's "kegs recorded" flag. An event with kegs recorded
-- cannot be deleted from the Events tab: the shipment rows would outlive it
-- with a dangling event id, and only Production can reverse a shipment.
alter table public.events
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by uuid references auth.users(id) on delete set null;

comment on column public.events.closed_at is
  'Set when the event''s kegs were recorded (shipped ad-hoc to the taproom from the Events tab). Null = kegs not yet recorded.';
