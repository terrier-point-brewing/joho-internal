-- A commitment booked at the Export Bay, as a partner shipment left with no
-- deal behind it, is created by whoever shipped it — often a brewer. It is a
-- real booking from that moment (the shipment credits it, the deposit and the
-- invoice hang off it), but its price and terms have not been looked at by
-- anyone who sells. This stamp says so until someone on Intake → Commitments
-- confirms or edits it; the Home alert center lists what is still stamped.
alter table public.commitments
  add column if not exists review_needed_at timestamptz;

comment on column public.commitments.review_needed_at is
  'Set when the commitment was booked at the Export Bay as part of a shipment; cleared when someone confirms or edits it on Intake → Commitments.';
