import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  allocationView,
  assessWriteOff,
  type AllocationChannel,
  type AllocationInput,
  type BatchInput,
} from "@/lib/production/allocationReserve";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

// Build the reserve view for a single allocation so we can size the write-off.
async function loadAllocationView(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  id: string,
) {
  const { data: allocation } = await supabase
    .from("batch_allocations")
    .select("id, batch_id, channel, partner_id, percentage, contract_request_id, written_off_at, commitments(volume_bbl)")
    .eq("id", id)
    .single();
  if (!allocation) return null;

  const { data: batch } = await supabase
    .from("brew_batches")
    .select("status")
    .eq("id", allocation.batch_id)
    .single();

  // produced = sum(volume_bbl) of kegging/canning (net fill, NOT minus shrinkage).
  const { data: transfers } = await supabase
    .from("batch_transfers")
    .select("volume_bbl")
    .eq("batch_id", allocation.batch_id)
    .in("transfer_type", ["kegging", "canning"]);
  const producedBbl = (transfers ?? []).reduce((s, t) => s + Number(t.volume_bbl), 0);

  let exportsQuery = supabase
    .from("export_transactions")
    .select("volume_bbl")
    .eq("batch_id", allocation.batch_id)
    .eq("channel", allocation.channel);
  exportsQuery = allocation.partner_id
    ? exportsQuery.eq("recipient_id", allocation.partner_id)
    : exportsQuery.is("recipient_id", null);
  const { data: exports_ } = await exportsQuery;
  const exportedBbl = (exports_ ?? []).reduce((s, e) => s + Number(e.volume_bbl), 0);

  const channel = allocation.channel as AllocationChannel;
  const booked = (allocation.commitments as unknown as { volume_bbl: number } | null)?.volume_bbl ?? null;
  const input: AllocationInput = {
    id: allocation.id,
    batchId: allocation.batch_id,
    channel,
    percentage: Number(allocation.percentage),
    bookedBbl: channel === "contract_brewing" ? booked : null,
    exportedBbl,
    writtenOff: !!allocation.written_off_at,
  };
  const batchInput: BatchInput = {
    batchId: allocation.batch_id,
    producedBbl,
    totalExportedBbl: 0, // not needed for the single-allocation view
    status: batch?.status ?? "",
    allocations: [input],
  };
  const view = allocationView(input, batchInput);
  const assessment = assessWriteOff({
    depositBacked: view.depositBacked,
    bookedBbl: view.bookedBbl,
    finalEntitlementBbl: view.finalEntitlementBbl,
    realizableBbl: view.realizableBbl,
    exportedBbl: view.exportedBbl,
  });
  return { allocation, assessment };
}

// POST /api/production/allocations/[id]/write-off
// Forgives the allocation's remaining owed volume and marks it fulfilled.
// Advisory only — NO refund is issued (refunds are the adjust/percentage flow).
// The `assessment` in the response carries the tolerance verdict so the caller
// can surface a warning; the write-off is never blocked on it.
export async function POST(req: NextRequest, { params }: RouteParams) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const note: string | null = body?.note ? String(body.note) : null;

  const loaded = await loadAllocationView(supabase, id);
  if (!loaded) return NextResponse.json({ error: "Allocation not found" }, { status: 404 });

  if (loaded.allocation.written_off_at) {
    return NextResponse.json({ error: "This allocation has already been written off." }, { status: 409 });
  }

  const { assessment } = loaded;

  const { data: updated, error } = await supabase
    .from("batch_allocations")
    .update({
      written_off_at: new Date().toISOString(),
      written_off_bbl: assessment.remainingBbl,
      write_off_note: note,
    })
    .eq("id", id)
    .select(`
      *,
      brew_batches(id, beer_name, batch_number, volume_bbl),
      contract_brewing_partners(id, company_name)
    `)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Writing off closes the obligation — fulfill the linked commitment too.
  if (loaded.allocation.contract_request_id) {
    await supabase
      .from("commitments")
      .update({ status: "fulfilled" })
      .eq("id", loaded.allocation.contract_request_id)
      .neq("status", "fulfilled");
  }

  return NextResponse.json({ allocation: updated, assessment });
}

// DELETE /api/production/allocations/[id]/write-off — reverse a write-off.
// Reopens the allocation (and its commitment) so it is no longer treated as
// fulfilled. No financial side effect.
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;

  const { data: current, error: fetchErr } = await supabase
    .from("batch_allocations")
    .select("id, contract_request_id, written_off_at")
    .eq("id", id)
    .single();
  if (fetchErr || !current) return NextResponse.json({ error: "Allocation not found" }, { status: 404 });
  if (!current.written_off_at) {
    return NextResponse.json({ error: "This allocation is not written off." }, { status: 409 });
  }

  const { data: updated, error } = await supabase
    .from("batch_allocations")
    .update({ written_off_at: null, written_off_bbl: null, write_off_note: null })
    .eq("id", id)
    .select(`
      *,
      brew_batches(id, beer_name, batch_number, volume_bbl),
      contract_brewing_partners(id, company_name)
    `)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Reopen a commitment that write-off had marked fulfilled.
  if (current.contract_request_id) {
    await supabase
      .from("commitments")
      .update({ status: "in_progress" })
      .eq("id", current.contract_request_id)
      .eq("status", "fulfilled");
  }

  return NextResponse.json({ allocation: updated });
}
