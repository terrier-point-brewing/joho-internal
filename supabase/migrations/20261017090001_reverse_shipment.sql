-- Unshipping: putting a booked shipment back, atomically.
--
-- Reversing a shipment is several writes that must not be able to happen
-- separately — cold storage goes back up, the export rows go away or are
-- negated, the allocation credit is released. A route handler cannot hold a
-- transaction across those, so the ledger half lives here. The PATCH route for
-- shipment edits already anticipated this: "Phase 2's delete+insert will NOT
-- have that property and needs a plpgsql transaction."
--
-- TWO MODES, and which one runs is not the caller's taste — it is a filing fact.
--
--   'delete'  The shipment's excise has not been filed with anyone yet, so the
--             rows can simply go. A true correction: the ledger ends up looking
--             the way it should have looked all along.
--
--   'reverse' A submitted excise return already counted these rows (the
--             worksheets read export_transactions by created_at, with no regard
--             for invoice status — see lib/production/filedPeriods). Deleting
--             them would silently restate a number a government has on file. So
--             the original stays exactly as shipped and a NEGATIVE mirror is
--             written dated today, which nets out in the period the correction
--             actually happened. Same reasoning writeRefundReturn applies to
--             returns, one step earlier.
--
-- Cold storage is restocked in BOTH modes: the beer is physically back either
-- way, and inventory has no filed periods to respect.
--
-- Batch completion is deliberately not re-evaluated. batch_exhaustion is
-- computed from batch_transfers — packaging, conversion and shrinkage — and
-- never reads export_transactions or cold_storage_inventory, so unshipping
-- cannot un-exhaust a batch. Commitment fulfillment DOES move, and is rechecked
-- by the caller through recheckCommitmentFulfillment, which is already
-- bidirectional.

create or replace function public.reverse_shipment(
  p_shipment_id uuid,
  p_mode        text,
  p_reason      text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tx              record;
  v_variation_id    uuid;
  v_existing_id     uuid;
  v_new_shipment_id uuid := gen_random_uuid();
  v_new_tx_id       uuid;
  v_reversed        int  := 0;
  v_restocked       numeric := 0;
  v_allocations     uuid[] := '{}';
  v_warnings        text[] := '{}';
  v_source_ref      text;
begin
  if p_mode not in ('delete', 'reverse') then
    raise exception 'reverse_shipment: mode must be delete or reverse, got %', p_mode;
  end if;

  v_source_ref := 'revision:' || p_shipment_id::text;

  -- Idempotency for the reverse mode. A retry after a partial failure must not
  -- write a second set of negative rows; the delete mode is naturally idempotent
  -- because the rows it targets are gone after the first run.
  if p_mode = 'reverse' and exists (
    select 1 from export_transactions where source_ref = v_source_ref
  ) then
    return jsonb_build_object(
      'reversed', 0, 'restocked', 0, 'allocations', '[]'::jsonb,
      'warnings', jsonb_build_array('This shipment has already been reversed; nothing further was done.')
    );
  end if;

  for v_tx in
    select *
    from export_transactions
    where shipment_id = p_shipment_id
      -- Only real outbound movement. A negative row is a reversal we wrote
      -- earlier and must never be reversed again.
      and quantity > 0
    for update
  loop
    -- The guards are asserted here as well as in the caller's planner, because
    -- this function is the last thing standing between a bad call and the
    -- ledger. An invoiced or settled shipment is not revisable at all.
    if v_tx.invoice_id is not null then
      raise exception 'reverse_shipment: shipment % is attached to an invoice — cancel the invoice first', p_shipment_id;
    end if;
    if v_tx.status <> 'invoice_required' then
      raise exception 'reverse_shipment: shipment % has status % — only invoice_required may be revised', p_shipment_id, v_tx.status;
    end if;
    if v_tx.is_phantom then
      raise exception 'reverse_shipment: shipment % is a phantom recount row and has no physical shipment to reverse', p_shipment_id;
    end if;

    -- ── Cold storage ───────────────────────────────────────────────────────
    -- Resolve the variation the same way the app does: by the literal
    -- variant_label stamped at ship time, scoped to the recipe. Ambiguous or
    -- unresolvable labels warn rather than abort — the paperwork reversal is
    -- still correct and worth keeping, and an operator can put the units back by
    -- hand once told which ones.
    v_variation_id := null;
    if v_tx.recipe_id is not null and v_tx.variant_label is not null then
      select rpv.variation_id into v_variation_id
      from recipe_packaging_variations rpv
      join packaging_variations pv on pv.id = rpv.variation_id
      where rpv.recipe_id = v_tx.recipe_id and pv.name = v_tx.variant_label
      limit 1;
    end if;

    if v_tx.batch_id is null then
      v_warnings := v_warnings || format(
        '%s units of %s have no batch on the original shipment, so cold storage was not restocked — add them by hand.',
        v_tx.quantity, coalesce(v_tx.variant_label, 'unknown item'));
    elsif v_variation_id is null then
      v_warnings := v_warnings || format(
        'Could not resolve the packaging variation "%s" for %s returned units, so cold storage was not restocked. Fix the mapping in Production, then restock by hand.',
        coalesce(v_tx.variant_label, 'unknown'), v_tx.quantity);
    else
      select id into v_existing_id
      from cold_storage_inventory
      where batch_id = v_tx.batch_id and variation_id = v_variation_id
      for update;

      if v_existing_id is not null then
        update cold_storage_inventory
        set quantity_on_hand = quantity_on_hand + v_tx.quantity
        where id = v_existing_id;
      else
        -- The shipment had emptied the lot, so the row was deleted. Recreate it.
        insert into cold_storage_inventory (batch_id, recipe_id, variation_id, quantity_on_hand)
        values (v_tx.batch_id, v_tx.recipe_id, v_variation_id, v_tx.quantity);
      end if;
      v_restocked := v_restocked + v_tx.quantity;
    end if;

    -- ── The export rows ────────────────────────────────────────────────────
    if p_mode = 'delete' then
      -- export_transaction_taxes cascades on delete.
      delete from export_transactions where id = v_tx.id;
    else
      insert into export_transactions (
        shipment_id, batch_id, recipe_id, allocation_id, packaging_item_id,
        variant_label, quantity, packaging_format, units_per_package, volume_bbl,
        channel, status, recipient_id, recipient_name, total_excise_tax_usd,
        source_ref, notes, is_phantom, packaging_loss_pct
      ) values (
        v_new_shipment_id, v_tx.batch_id, v_tx.recipe_id,
        -- Deliberately NOT stamped with the original allocation, matching
        -- writeRefundReturn: the credit is released on the ORIGINAL row instead,
        -- so the partner's entitlement moves exactly once.
        null, v_tx.packaging_item_id,
        v_tx.variant_label, -v_tx.quantity, v_tx.packaging_format, v_tx.units_per_package, -v_tx.volume_bbl,
        v_tx.channel,
        -- Terminal. There is nothing to bill for beer that came back before it
        -- was ever invoiced, and leaving it invoice_required would put a negative
        -- row in the Invoice Required queue.
        'paid',
        v_tx.recipient_id, v_tx.recipient_name, -v_tx.total_excise_tax_usd,
        v_source_ref,
        coalesce(p_reason, 'Shipment revision'),
        false, coalesce(v_tx.packaging_loss_pct, 0)
      )
      returning id into v_new_tx_id;

      -- Reverse the tax that was actually CHARGED on this row, not today's rate.
      -- If a rate moved between the shipment and the correction, recomputing
      -- would reverse a number the brewery never recorded.
      insert into export_transaction_taxes (
        export_transaction_id, excise_tax_rate_id, tax_name, unit, rate_usd, amount_usd
      )
      select v_new_tx_id, excise_tax_rate_id, tax_name, unit, rate_usd, -amount_usd
      from export_transaction_taxes
      where export_transaction_id = v_tx.id;

      -- The original keeps its history but stops crediting the partner, so the
      -- allocation is free to be re-credited by the replacement shipment.
      update export_transactions
      set allocation_id = null,
          over_allocation = false,
          status = 'paid',
          edit_reason = p_reason
      where id = v_tx.id;
    end if;

    if v_tx.allocation_id is not null then
      v_allocations := v_allocations || v_tx.allocation_id;
    end if;
    v_reversed := v_reversed + 1;
  end loop;

  return jsonb_build_object(
    'reversed',      v_reversed,
    'restocked',     v_restocked,
    'reversalShipmentId', case when p_mode = 'reverse' and v_reversed > 0 then v_new_shipment_id::text else null end,
    'allocations',   to_jsonb(coalesce(v_allocations, '{}')),
    'warnings',      to_jsonb(coalesce(v_warnings, '{}'))
  );
end;
$$;

comment on function public.reverse_shipment(uuid, text, text) is
  'Atomically unship a booked shipment: restock cold storage, release its allocation credits, and either delete its export rows (open excise period) or write negative mirrors of them (filed period). Callers must recheck commitment fulfillment for the returned allocation ids.';

revoke all on function public.reverse_shipment(uuid, text, text) from public, anon;
grant execute on function public.reverse_shipment(uuid, text, text) to service_role;
