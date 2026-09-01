import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { recheckCommitmentFulfillment } from "@/lib/production/commitmentFulfillment";
import { planShipmentEdit, type ShipmentEditRow } from "@/lib/production/shipmentEdit";
import { isDateInFiledExcisePeriod, filedPeriodExplanation } from "@/lib/production/filedPeriods";
import { crossesExciseTreatmentBoundary } from "@/lib/tax/parties/ncDorBeerExcise/rates";
import { triggerSquarePush } from "@/lib/production/triggerSquarePush";

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
 * Shipments tab so the UI can never offer an edit this route would reject —
 * except the two guards below that need I/O the pure planner cannot do:
 *
 *  - THE EXCISE BOUNDARY. Excise liability follows the STORED channel (both
 *    worksheets and the accrual read export_transactions.channel), and NC
 *    treats wholesale differently from every other channel. A channel edit
 *    that crosses that line inside an already-filed period would silently
 *    restate a submitted return, so it is refused — a revision reverses with a
 *    negative mirror instead, which is the filing-safe correction. Outside a
 *    filed period it proceeds with a warning.
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
    .select("id, channel, status, invoice_id, is_phantom, allocation_id, recipe_id, created_at")
    .eq("shipment_id", id);
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!rows || rows.length === 0) {
    return NextResponse.json({ error: "Shipment not found" }, { status: 404 });
  }

  const plan = planShipmentEdit(rows as ShipmentEditRow[], body);
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 409 });

  const warnings: string[] = [];
  const targetChannel = plan.updates.channel as string | undefined;
  const crossesExciseBoundary =
    targetChannel !== undefined &&
    rows.some((r) => r.channel !== targetChannel && crossesExciseTreatmentBoundary(r.channel, targetChannel));

  if (crossesExciseBoundary) {
    const shippedOn = String(rows[0].created_at).slice(0, 10);
    const filing = await isDateInFiledExcisePeriod(supabase, shippedOn);
    if (filing.isFiled) {
      return NextResponse.json(
        {
          error:
            "This channel change moves the shipment across the excise treatment line, and its period has " +
            "already been filed — an in-place edit would restate that return. Revise the shipment instead " +
            "(it reverses with a dated mirror), or leave the channel and use the invoice's billing-channel override.",
        },
        { status: 409 },
      );
    }
    warnings.push(
      "This channel change moves the shipment across the excise treatment line (wholesale is deducted on the " +
      "NC return; other channels are taxed). The excise worksheets will follow the new channel." +
      (filedPeriodExplanation(filing) ? ` ${filedPeriodExplanation(filing)}` : ""),
    );
  }

  // One statement, so the whole shipment moves together or not at all. When the
  // plan releases credits, `updates` already carries allocation_id: null and
  // over_allocation: false.
  const { data: updated, error: writeErr } = await supabase
    .from("export_transactions")
    .update(plan.updates)
    .eq("shipment_id", id)
    .select("id, shipment_id, channel, recipient_id, recipient_name, notes, edit_reason, allocation_id, over_allocation, is_ad_hoc, status");
  if (writeErr) return NextResponse.json({ error: writeErr.message }, { status: 500 });

  // Idempotent and safely re-runnable, so a failure here leaves the ledger
  // consistent and the operator can simply retry. (Phase 2's delete+insert will
  // NOT have that property and needs a plpgsql transaction.)
  for (const allocationId of plan.allocationsToRecheck) {
    await recheckCommitmentFulfillment(supabase, allocationId);
  }

  // Crossing INTO a fee-only channel releases a deferred Square deduction: the
  // shipment's product invoice was going to decrement Square, and now no invoice
  // ever will (contract bills fees only). Restate the counts immediately rather
  // than waiting for the nightly push. The reverse crossing needs no push here —
  // the ship-time push already ran, and the product invoice's extra deduction is
  // the same labelled drift the nightly absolute push already corrects.
  const enteredFeeOnly =
    targetChannel === "contract_brewing" && rows.some((r) => r.channel !== "contract_brewing");
  if (enteredFeeOnly) {
    await triggerSquarePush(
      supabase,
      rows.map((r) => r.recipe_id as string | null),
      `shipment ${id} edited into contract_brewing`,
    );
  }

  return NextResponse.json({ updated: updated?.length ?? 0, rows: updated ?? [], warnings });
}
