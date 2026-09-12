import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

// POST /api/production/allocations/[id]/transfer-coverage
// The entitlement-follows case of a conversion: a PAID deposit on the source
// allocation keeps covering the liquid after it becomes the child batch, so
// no money moves — the paid invoice is recorded as spanning both batches
// (invoice_batch_links) and the allocation carries the audit note. This is
// the agreed alternative to refund-and-rebill for same-commitment transfers.
export async function POST(req: NextRequest, { params }: RouteParams) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  const { id } = await params;
  const body = await req.json();
  const childBatchId = body.child_batch_id as string | undefined;

  if (!childBatchId) {
    return NextResponse.json({ error: "child_batch_id is required" }, { status: 400 });
  }

  const { data: allocation } = await supabase
    .from("batch_allocations")
    .select("id, batch_id, notes, square_deposit_invoice_id, invoice_paid_at")
    .eq("id", id)
    .maybeSingle();
  if (!allocation) return NextResponse.json({ error: "Allocation not found" }, { status: 404 });

  // Coverage transfer is only meaningful for money already captured — an
  // unpaid invoice is simply revised instead.
  if (!allocation.invoice_paid_at || !allocation.square_deposit_invoice_id) {
    return NextResponse.json(
      { error: "This allocation has no paid deposit invoice — nothing to transfer coverage from." },
      { status: 422 },
    );
  }

  // The child must actually be a conversion child of this allocation's batch;
  // linking a paid invoice to an unrelated batch would fabricate coverage.
  const { data: child } = await supabase
    .from("brew_batches")
    .select("id, batch_number, beer_name, converted_from_batch_id")
    .eq("id", childBatchId)
    .maybeSingle();
  if (!child) return NextResponse.json({ error: "Child batch not found" }, { status: 404 });
  if ((child as { converted_from_batch_id: string | null }).converted_from_batch_id !== allocation.batch_id) {
    return NextResponse.json(
      { error: "That batch is not a conversion child of this allocation's batch." },
      { status: 422 },
    );
  }

  // `invoices` and `invoice_batch_links` are finance-locked under RLS; the
  // capability check above is the authority here, same as the adjust route.
  const { data: invoice } = await admin
    .from("invoices")
    .select("id")
    .eq("source", "square")
    .eq("square_invoice_id", allocation.square_deposit_invoice_id)
    .neq("status", "voided")
    .maybeSingle();
  if (!invoice?.id) {
    return NextResponse.json(
      { error: "The paid deposit invoice is not in the finance ledger — sync it from the Deposit Invoices tab first." },
      { status: 422 },
    );
  }

  const { error: linkErr } = await admin
    .from("invoice_batch_links")
    .upsert(
      { invoice_id: invoice.id, batch_id: childBatchId },
      { onConflict: "invoice_id,batch_id", ignoreDuplicates: true },
    );
  if (linkErr) return NextResponse.json({ error: linkErr.message }, { status: 500 });

  // The durable, human-readable half of the record, on the allocation itself.
  const childLabel = (child as { batch_number: string | null; beer_name: string | null });
  const stamp = `${new Date().toISOString().slice(0, 10)}: deposit coverage extended to ${childLabel.batch_number ? `#${childLabel.batch_number} ` : ""}${childLabel.beer_name ?? childBatchId} (conversion, same commitment — no refund).`;
  const notes = allocation.notes ? `${allocation.notes}\n${stamp}` : stamp;
  await supabase.from("batch_allocations").update({ notes }).eq("id", id);

  return NextResponse.json({ linked_invoice_id: invoice.id, note: stamp });
}
