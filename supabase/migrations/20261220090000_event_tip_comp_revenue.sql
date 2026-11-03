-- A comped-beer tip settlement is event revenue.
--
-- When a volunteer's event tip share is settled as comped beer, the business
-- keeps the tip money and hands over product instead. The eventTipSettlements
-- provider already relieves GL 2310 Undistributed Tips for it; this is the
-- other side of that entry. The Events tips route writes one manual_entries
-- flow row per `comp` payout — coded to the same account Event Pour sales
-- land on (4160 Offsite Event Sales), dated settled_on, stamped
-- channel = 'events' so it files under Events next to the pours in Finance —
-- and removes it when the payout is removed. No Square row is faked: the
-- Square sync owns square_orders and would set aside a row Square never
-- issued.
--
-- `channel` is new on manual_entries. A hand-typed manual entry has no sales
-- channel (lib/finance/financials/manualNetSales.ts stamps it "unknown"); a
-- system-written one may declare the channel it belongs to.
alter table public.manual_entries
  add column if not exists channel text
    check (channel is null or channel in ('taproom', 'events', 'contract_brewing', 'distribution', 'wholesale'));

comment on column public.manual_entries.channel is
  'Sales channel the entry belongs to, when known. Null for operator-typed entries (no channel dimension); set by system writers such as event tip comp settlements (''events'').';

alter table public.event_tip_payouts
  add column if not exists manual_entry_id uuid references public.manual_entries(id) on delete set null;

comment on column public.event_tip_payouts.manual_entry_id is
  'For method = ''comp'': the manual_entries flow row that books the kept tip as event revenue (GL 4160). Removed with the payout.';
