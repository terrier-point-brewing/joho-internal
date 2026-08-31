-- ─── An ad-hoc shipment says so on its own row ────────────────────────────────
--
-- The Export Bay can ship stock that no commitment asked for: the operator picks
-- a beer, a variation and a partner and sends it. Nothing on the resulting
-- export_transactions row said so. `allocation_id IS NULL` looked like the tell,
-- but it is worn by four unrelated things —
--
--   * taproom consumption (internal, never invoiced),
--   * an over-delivery row, written when a partner took MORE than their booked
--     allocation and the excess had nowhere to credit,
--   * the negative half of a revision or a refund return,
--   * and a genuine ad-hoc ship.
--
-- Only the last one is the question an invoice needs answered. It matters most
-- for the ingredient deposit: a shipment that was a contract-brewing commitment
-- paid its deposit up front, and an ad-hoc one never did — so the operator has
-- to know which they are looking at before they decide whether to charge the
-- shipped share of the batch's ingredient bill. Guessing from a null column is
-- how invoice #000041's deposit ended up typed by hand.

alter table public.export_transactions
  add column if not exists is_ad_hoc boolean not null default false;

comment on column public.export_transactions.is_ad_hoc is
  'True when this row came from an ad-hoc Export Bay ship — stock sent with no commitment behind it, so no ingredient deposit was ever collected up front. NULL allocation_id does NOT imply this: taproom consumption, over-deliveries and revision reversals all carry one too.';

-- Invoicing reads this alongside the status filter, and ad-hoc rows are a small
-- minority, so the index only carries the ones that are true.
create index if not exists idx_export_transactions_is_ad_hoc
  on public.export_transactions(is_ad_hoc)
  where is_ad_hoc;

-- ─── Backfill ─────────────────────────────────────────────────────────────────
-- Narrow on purpose. A row qualifies only when every other explanation for its
-- missing allocation is ruled out: not taproom, not phantom, not an
-- over-delivery, not the negative leg of a revision or refund (both of which
-- stamp a source_ref), and not a reversal (quantity > 0).
--
-- Against production that matches exactly two rows — a Wiggo! IPA distribution
-- ship on 2026-07-30 and a Carolina Mule contract ship on 2026-08-28. Anything
-- it cannot prove is left false, because a false tag on a real commitment is a
-- deposit charged twice and that is the expensive direction to be wrong in.

update public.export_transactions
   set is_ad_hoc = true
 where allocation_id is null
   and channel <> 'taproom'
   and is_phantom = false
   and over_allocation = false
   and source_ref is null
   and quantity > 0;
