import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { recheckCommitmentFulfillment } from "@/lib/production/commitmentFulfillment";
import { planShipmentEdit, type ShipmentEditRow } from "@/lib/production/shipmentEdit";

export const dynamic = "force-dynamic";

/**
 * Edit a booked shipment's channel / recipient / notes.
 *
 * `id` is the SHIPMENT_ID, not an export_transactions row id — the edit applies
 * to every row in the shipment atomically. That is not a convenience: an invoice
 * cannot span mixed channels (see resolveInvoiceChannel in exportInvoicePreview),
 * so editing a subset would leave the remainder permanently un-invoiceable.
 *
 * All legality rules live in the pure `planShipmentEdit`, shared with the
 * Shipments tab so the UI can never offer an edit this route would reject.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  // The session client, NOT the admin client: audit_trigger_fn reads auth.uid()
  // to attribute the audit_log row to the operator who made the change.
  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const body = await req.json();

  const { data: rows, error: readErr } = await supabase
    .from("export_transactions")
    .select("id, channel, status, invoice_id, is_phantom, allocation_id")
    .eq("shipment_id", id);
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!rows || rows.length === 0) {
    return NextResponse.json({ error: "Shipment not found" }, { status: 404 });
  }

  const plan = planShipmentEdit(rows as ShipmentEditRow[], body);
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 409 });

  // One statement, so the whole shipment moves together or not at all. When the
  // plan releases credits, `updates` already carries allocation_id: null and
  // over_allocation: false.
  const { data: updated, error: writeErr } = await supabase
    .from("export_transactions")
    .update(plan.updates)
    .eq("shipment_id", id)
    .select("id, shipment_id, channel, recipient_id, recipient_name, notes, edit_reason, allocation_id, over_allocation, status");
  if (writeErr) return NextResponse.json({ error: writeErr.message }, { status: 500 });

  // Idempotent and safely re-runnable, so a failure here leaves the ledger
  // consistent and the operator can simply retry. (Phase 2's delete+insert will
  // NOT have that property and needs a plpgsql transaction.)
  for (const allocationId of plan.allocationsToRecheck) {
    await recheckCommitmentFulfillment(supabase, allocationId);
  }

  return NextResponse.json({ updated: updated?.length ?? 0, rows: updated ?? [] });
}
