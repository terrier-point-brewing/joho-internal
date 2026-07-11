import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
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

export const dynamic = "force-dynamic";

// GET /api/production/allocations?batch_id=<uuid>
// Returns allocations enriched with fulfillment data computed from export_transactions and batch_transfers.
export async function GET(req: NextRequest) {
  try { await requireRole(["viewer", "brewer", "manager"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  const batch_id = req.nextUrl.searchParams.get("batch_id");

  let query = supabase
    .from("batch_allocations")
    .select(`
      *,
      brew_batches(id, beer_name, batch_number, volume_bbl, recipe_id, status),
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

  // Fetch exports grouped by batch_id + channel + recipient_id for fulfillment
  const { data: exports_ } = await supabase
    .from("export_transactions")
    .select("batch_id, channel, recipient_id, volume_bbl")
    .in("batch_id", batchIds);

  // Build fulfillment lookup (per allocation) and per-batch totals (for reserve).
  const exportedMap: Record<string, number> = {};
  const totalExportedByBatch: Record<string, number> = {};
  for (const e of exports_ ?? []) {
    const key = `${e.batch_id}:${e.channel}:${e.recipient_id ?? ""}`;
    exportedMap[key] = (exportedMap[key] ?? 0) + (e.volume_bbl ?? 0);
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
      exportedBbl: exportedMap[`${a.batch_id}:${a.channel}:${a.partner_id ?? ""}`] ?? 0,
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

  return NextResponse.json(withInvoiceNumbers);
}

// POST /api/production/allocations
export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }


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

  const { data, error } = await supabase
    .from("batch_allocations")
    .insert({
      batch_id,
      channel,
      percentage: pct,
      partner_id: partner_id || null,
      contract_request_id: contract_request_id || null,
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
