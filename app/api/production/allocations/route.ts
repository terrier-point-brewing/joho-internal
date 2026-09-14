import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  allocationView,
  batchReserve,
  completionReconciliation,
  type AllocationChannel,
  type AllocationInput,
  type BatchInput,
} from "@/lib/production/allocationReserve";
import { splitCommitmentForConversionChild } from "@/lib/production/commitmentSplit";
import { classifyAdditions, classifyBase, type CoverageAllocFields } from "@/lib/production/depositCoverage";
import { sumExportedByAllocation, type ExportVolumeRow } from "@/lib/production/allocationDelivery";
import { loadDepositCharges } from "@/lib/production/depositCharges";

export const dynamic = "force-dynamic";

// GET /api/production/allocations?batch_id=<uuid>
// Returns allocations enriched with fulfillment data computed from export_transactions and batch_transfers.
export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.exportRead); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  const batch_id = req.nextUrl.searchParams.get("batch_id");

  let query = supabase
    .from("batch_allocations")
    .select(`
      *,
      brew_batches(id, beer_name, batch_number, volume_bbl, recipe_id, status, converted_from_batch_id),
      contract_brewing_partners(id, company_name),
      commitments(id, volume_bbl, desired_delivery_date, received_on, created_at, channel)
    `)
    .order("created_at");

  if (batch_id) query = query.eq("batch_id", batch_id);

  const { data: allocations, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (!allocations || allocations.length === 0) return NextResponse.json([]);

  // Fetch actual produced volume (kegging + canning transfers) per batch
  const batchIds = [...new Set(allocations.map((a) => a.batch_id))];
  const { data: transfers } = await supabase
    .from("batch_transfers")
    .select("batch_id, transfer_type, volume_bbl, shrinkage_bbl")
    .in("batch_id", batchIds)
    .in("transfer_type", ["kegging", "canning"]);

  // produced_bbl per batch = sum of volume_bbl for final packaging transfers.
  // volume_bbl on kegging/canning rows is already the net packaged volume (units × fill),
  // so shrinkage_bbl must NOT be subtracted here — it is accounted for separately.
  const producedByBatch: Record<string, number> = {};
  for (const t of transfers ?? []) {
    const net = Number(t.volume_bbl ?? 0);
    producedByBatch[t.batch_id] = (producedByBatch[t.batch_id] ?? 0) + net;
  }

  // Exports credited to each allocation (the unit of record), plus per-batch
  // totals for the reserve. Rows with no allocation — over-delivery, ad-hoc —
  // count toward the batch total only; they used to be folded into whichever
  // allocation shared batch + channel + partner.
  const { data: exports_ } = await supabase
    .from("export_transactions")
    .select("batch_id, allocation_id, volume_bbl")
    .in("batch_id", batchIds);

  const exportedByAllocation = sumExportedByAllocation((exports_ ?? []) as ExportVolumeRow[]);
  const totalExportedByBatch: Record<string, number> = {};
  for (const e of exports_ ?? []) {
    totalExportedByBatch[e.batch_id] = (totalExportedByBatch[e.batch_id] ?? 0) + (Number(e.volume_bbl) || 0);
  }

  // ── Reserve/entitlement model (see lib/production/allocationReserve.ts) ────
  const toAllocInput = (a: (typeof allocations)[number]): AllocationInput => {
    const channel = a.channel as AllocationChannel;
    const booked = (a.commitments as { volume_bbl: number } | null)?.volume_bbl ?? null;
    return {
      id: a.id,
      batchId: a.batch_id,
      channel,
      percentage: Number(a.percentage),
      bookedBbl: channel === "contract_brewing" ? booked : null,
      exportedBbl: exportedByAllocation.get(a.id) ?? 0,
      writtenOff: !!a.written_off_at,
    };
  };

  const statusByBatch: Record<string, string> = {};
  const inputsByBatch = new Map<string, AllocationInput[]>();
  for (const a of allocations) {
    statusByBatch[a.batch_id] = (a.brew_batches as { status?: string } | null)?.status ?? "";
    const list = inputsByBatch.get(a.batch_id) ?? [];
    list.push(toAllocInput(a));
    inputsByBatch.set(a.batch_id, list);
  }
  const batchInputById = new Map<string, BatchInput>();
  for (const bid of batchIds) {
    batchInputById.set(bid, {
      batchId: bid,
      producedBbl: producedByBatch[bid] ?? 0,
      totalExportedBbl: totalExportedByBatch[bid] ?? 0,
      status: statusByBatch[bid] ?? "",
      allocations: inputsByBatch.get(bid) ?? [],
    });
  }

  const enriched = allocations.map((a) => {
    const bi = batchInputById.get(a.batch_id)!;
    const input = toAllocInput(a);
    const view = allocationView(input, bi);
    const reserve = batchReserve(bi);
    const recon = completionReconciliation(input, bi); // null unless complete + contract
    return {
      ...a,
      produced_bbl: bi.producedBbl > 0 ? bi.producedBbl : null,
      realizable_bbl: view.realizableBbl,
      // Deprecated alias for realizable_bbl (kept one release); preserves the old
      // null-when-nothing-produced-yet semantics.
      allocated_bbl: view.realizableBbl > 0 ? view.realizableBbl : null,
      booked_bbl: view.bookedBbl,
      final_entitlement_bbl: view.finalEntitlementBbl,
      exported_bbl: view.exportedBbl,
      deposit_backed: view.depositBacked,
      fulfilled: view.fulfilled,
      reserved_for_contract_bbl: reserve.reservedForContractBbl,
      free_to_ship_bbl: reserve.freeToShipBbl,
      under_covered: reserve.underCovered,
      // Completion reconciliation (advisory; null until the batch is complete).
      // Shrinkage yields no refund — the partner bears pro-rata shrinkage — so we
      // surface only the two actionable gaps against the final entitlement.
      over_delivered_bbl: recon?.overDeliveredBbl ?? null,
      under_delivered_bbl: recon?.underDeliveredBbl ?? null,
    };
  });

  // Fetch invoice numbers for any deposit invoices linked via square_deposit_invoice_id
  const squareDepositIds = enriched
    .map((a) => a.square_deposit_invoice_id)
    .filter((id): id is string => !!id);

  const invoiceNumberBySquareId = new Map<string, string | null>();
  if (squareDepositIds.length > 0) {
    // `invoices` is RLS-locked to admins; read via the service-role client so
    // deposit invoice numbers resolve for non-admin callers too (see the export
    // invoices route for the same rationale).
    const admin = createSupabaseAdminClient();
    const { data: depositInvoices } = await admin
      .from("invoices")
      .select("square_invoice_id, invoice_number")
      .in("square_invoice_id", squareDepositIds)
      .neq("status", "voided");
    for (const inv of depositInvoices ?? []) {
      if (inv.square_invoice_id) {
        invoiceNumberBySquareId.set(inv.square_invoice_id, inv.invoice_number ?? null);
      }
    }
  }

  const withInvoiceNumbers = enriched.map((a) => ({
    ...a,
    deposit_invoice_number: a.square_deposit_invoice_id
      ? (invoiceNumberBySquareId.get(a.square_deposit_invoice_id) ?? null)
      : null,
  }));

  // ── Deposit coverage (conversion children, contract only) ─────────────────
  // Decomposes each child's deposit into BASE (paid where the liquid was
  // brewed — the parent's deposit — unless refunded, which makes it chargeable
  // again) and ADDITIONS (the child's own invoice or back-charge). One
  // classifier (lib/production/depositCoverage) feeds this display AND the
  // billing exclusions, so the card and the invoice can never disagree.
  const admin2 = createSupabaseAdminClient();
  const parentIds = [...new Set(
    withInvoiceNumbers
      .filter((a) => a.channel === "contract_brewing"
        && (a.brew_batches as { converted_from_batch_id?: string | null } | null)?.converted_from_batch_id)
      .map((a) => (a.brew_batches as { converted_from_batch_id: string }).converted_from_batch_id),
  )];
  const parentAllocByKey = new Map<string, Record<string, unknown>>();
  const parentBatchNumberById = new Map<string, string | null>();
  if (parentIds.length > 0) {
    const [{ data: parentAllocs }, { data: parentBatches }] = await Promise.all([
      supabase
        .from("batch_allocations")
        .select("batch_id, partner_id, invoice_paid_at, invoice_sent_at, invoice_generated_at, deposit_backcharged_invoice_id, square_deposit_invoice_id, refund_amount_cents, written_off_at")
        .in("batch_id", parentIds)
        .eq("channel", "contract_brewing"),
      supabase.from("brew_batches").select("id, batch_number").in("id", parentIds),
    ]);
    for (const p of parentAllocs ?? []) {
      parentAllocByKey.set(`${p.batch_id}:${p.partner_id ?? ""}`, p);
    }
    for (const b of parentBatches ?? []) {
      parentBatchNumberById.set(b.id, (b as { batch_number: string | null }).batch_number ?? null);
    }
  }

  // Invoice numbers for back-charged invoices (child or parent), by ledger id.
  const backchargeIds = [...new Set([
    ...withInvoiceNumbers.map((a) => a.deposit_backcharged_invoice_id).filter((id): id is string => !!id),
    ...[...parentAllocByKey.values()].map((p) => p.deposit_backcharged_invoice_id as string | null).filter((id): id is string => !!id),
  ])];
  const invoiceNumberById = new Map<string, string | null>();
  if (backchargeIds.length > 0) {
    const { data: bcInvoices } = await admin2
      .from("invoices").select("id, invoice_number").in("id", backchargeIds);
    for (const inv of bcInvoices ?? []) invoiceNumberById.set(inv.id, inv.invoice_number ?? null);
  }
  // Parents' own deposit invoices are keyed by Square id, not ledger id.
  const parentSquareIds = [...parentAllocByKey.values()]
    .map((p) => p.square_deposit_invoice_id as string | null)
    .filter((id): id is string => !!id && !invoiceNumberBySquareId.has(id));
  if (parentSquareIds.length > 0) {
    const { data: parentInvoices } = await admin2
      .from("invoices").select("square_invoice_id, invoice_number")
      .in("square_invoice_id", parentSquareIds).neq("status", "voided");
    for (const inv of parentInvoices ?? []) {
      if (inv.square_invoice_id) invoiceNumberBySquareId.set(inv.square_invoice_id, inv.invoice_number ?? null);
    }
  }

  // Per-invoice back-charges (admin: invoices RLS cluster), so "collected $X of
  // $Y" is a fact on the card and "collecting" is distinguishable from "paid".
  const chargesById = await loadDepositCharges(
    admin2,
    withInvoiceNumbers.filter((a) => a.channel === "contract_brewing").map((a) => a.id),
  );

  const withCoverage = withInvoiceNumbers.map((a) => {
    if (a.channel !== "contract_brewing") return a;
    const charges = chargesById.get(a.id) ?? null;
    const parentBatchId = (a.brew_batches as { converted_from_batch_id?: string | null } | null)?.converted_from_batch_id ?? null;
    const parent = parentBatchId
      ? (parentAllocByKey.get(`${parentBatchId}:${a.partner_id ?? ""}`) ?? null) as CoverageAllocFields | null
      : null;
    const additions = classifyAdditions(a as unknown as CoverageAllocFields, charges);
    const base = classifyBase(!!parentBatchId, parent);
    const parentP = parent as (CoverageAllocFields & { square_deposit_invoice_id: string | null }) | null;
    return {
      ...a,
      deposit_charged_cents: additions.chargedCents,
      deposit_collected_cents: additions.collectedCents,
      deposit_coverage: {
        base: {
          status: base.status,
          parent_batch_number: parentBatchId ? (parentBatchNumberById.get(parentBatchId) ?? null) : null,
          parent_refund_cents: base.parentRefundCents,
          covered_by_invoice_number: parentP
            ? (parentP.square_deposit_invoice_id
                ? (invoiceNumberBySquareId.get(parentP.square_deposit_invoice_id) ?? null)
                : parentP.deposit_backcharged_invoice_id
                  ? (invoiceNumberById.get(parentP.deposit_backcharged_invoice_id) ?? null)
                  : null)
            : null,
        },
        additions: {
          status: additions.status,
          via: additions.via,
          charged_cents: additions.chargedCents,
          collected_cents: additions.collectedCents,
          invoice_number: a.deposit_backcharged_invoice_id
            ? (invoiceNumberById.get(a.deposit_backcharged_invoice_id) ?? null)
            : (a.deposit_invoice_number ?? null),
        },
      },
    };
  });

  return NextResponse.json(withCoverage);
}

// POST /api/production/allocations
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const { batch_id, channel, percentage, partner_id, contract_request_id, notes } = body;

  if (!batch_id || !channel || percentage == null) {
    return NextResponse.json({ error: "batch_id, channel, and percentage are required" }, { status: 400 });
  }

  const VALID_CHANNELS = ["taproom", "distribution", "contract_brewing", "wholesale", "safety_stock"];
  if (!VALID_CHANNELS.includes(channel)) {
    return NextResponse.json(
      { error: `Invalid channel "${channel}". Must be one of: ${VALID_CHANNELS.join(", ")}` },
      { status: 400 }
    );
  }

  const pct = Number(percentage);
  if (isNaN(pct) || pct <= 0 || pct > 100) {
    return NextResponse.json({ error: "percentage must be between 0 and 100 (exclusive/inclusive)" }, { status: 400 });
  }

  // Validate sum of existing percentages won't exceed 100
  const { data: existing, error: sumErr } = await supabase
    .from("batch_allocations")
    .select("percentage")
    .eq("batch_id", batch_id);
  if (sumErr) return NextResponse.json({ error: sumErr.message }, { status: 500 });

  const currentTotal = (existing ?? []).reduce((s, a) => s + Number(a.percentage), 0);
  if (currentTotal + pct > 100) {
    return NextResponse.json(
      { error: `Adding ${pct}% would exceed 100% (current total: ${currentTotal.toFixed(2)}%)` },
      { status: 422 }
    );
  }

  // A linked commitment fixes the allocation's channel: crediting matches export
  // rows on the ALLOCATION's channel, and deposit-backing is decided by it, so a
  // mismatch either strands the commitment (its shipments credit under a channel
  // it never books) or silently drops the deposit guarantee the partner paid for.
  let resolvedCommitmentId: string | null = contract_request_id || null;
  if (contract_request_id) {
    const { data: commitment } = await supabase
      .from("commitments")
      .select("channel, recipe_id")
      .eq("id", contract_request_id)
      .maybeSingle();
    if (!commitment) {
      return NextResponse.json({ error: "The linked commitment does not exist." }, { status: 422 });
    }
    const commitmentChannel = (commitment as { channel: string | null }).channel;
    if (commitmentChannel && commitmentChannel !== channel) {
      return NextResponse.json(
        { error: `This commitment is ${commitmentChannel} — the allocation must use the same channel to credit it.` },
        { status: 422 }
      );
    }

    // A conversion child allocated against its PARENT beer's commitment splits
    // the deal instead of borrowing it: the moved volume gets its own
    // commitment for the child's recipe, and the original shrinks to match.
    // Without this, both beers' deposit invoices bill against one commitment
    // (B-056 and B-063 both hung off the same 28 bbl Pilsner deal).
    const commitmentRecipeId = (commitment as { recipe_id: string | null }).recipe_id;
    const { data: batchRow } = await supabase
      .from("brew_batches")
      .select("recipe_id, volume_bbl, expected_delivery_date, converted_from_batch_id, batch_number, beer_name")
      .eq("id", batch_id)
      .maybeSingle();
    const batch = batchRow as {
      recipe_id: string | null; volume_bbl: number | null; expected_delivery_date: string | null;
      converted_from_batch_id: string | null; batch_number: string | null; beer_name: string | null;
    } | null;
    if (
      batch?.converted_from_batch_id
      && batch.recipe_id
      && commitmentRecipeId
      && commitmentRecipeId !== batch.recipe_id
    ) {
      try {
        resolvedCommitmentId = await splitCommitmentForConversionChild(supabase, {
          commitmentId:  contract_request_id,
          childRecipeId: batch.recipe_id,
          volumeBbl:     (Number(percentage) / 100) * Number(batch.volume_bbl ?? 0),
          deliveryDate:  batch.expected_delivery_date,
          childLabel:    `${batch.batch_number ? `#${batch.batch_number} ` : ""}${batch.beer_name ?? batch_id}`,
        });
      } catch (splitErr) {
        return NextResponse.json({ error: (splitErr as Error).message }, { status: 500 });
      }
    }
  }

  const { data, error } = await supabase
    .from("batch_allocations")
    .insert({
      batch_id,
      channel,
      percentage: pct,
      partner_id: partner_id || null,
      contract_request_id: resolvedCommitmentId,
      notes: notes || null,
    })
    .select(`
      *,
      brew_batches(id, beer_name, batch_number, volume_bbl),
      contract_brewing_partners(id, company_name)
    `)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
