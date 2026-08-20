import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { reviseShipment, ReviseShipmentError } from "@/lib/production/reviseShipment";
import { isDateInFiledExcisePeriod, filedPeriodExplanation } from "@/lib/production/filedPeriods";
import { isShipmentRevisable, type ShipmentEditRow } from "@/lib/production/shipmentEdit";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET — what the operator needs to see BEFORE revising: what shipped, and
 * whether the correction will be booked in place or as a reversal.
 *
 * The filing check runs here as well as inside the revision so the banner and
 * the behaviour come from one function. The modal never decides this for itself.
 */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();
  const { id } = await params;

  const { data: rows, error } = await supabase
    .from("export_transactions")
    .select(
      "id, channel, status, invoice_id, is_phantom, allocation_id, quantity, recipe_id, variant_label, recipient_id, recipient_name, created_at",
    )
    .eq("shipment_id", id)
    .gt("quantity", 0)
    .order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rows?.length) return NextResponse.json({ error: "Shipment not found" }, { status: 404 });

  const filing = await isDateInFiledExcisePeriod(supabase, String(rows[0].created_at).slice(0, 10));

  // The variations shippable for this recipe, so the modal can offer packaging
  // the shipment did not originally use — a 1/2 keg revised into sixtels.
  const { data: variations } = await supabase
    .from("recipe_packaging_variations")
    .select("variation_id, packaging_variations!inner(id, name, format)")
    .eq("recipe_id", rows[0].recipe_id);

  return NextResponse.json({
    revisable: isShipmentRevisable(rows as ShipmentEditRow[]),
    shippedOn: String(rows[0].created_at).slice(0, 10),
    channel: rows[0].channel,
    recipientName: rows[0].recipient_name,
    filedPeriodNote: filedPeriodExplanation(filing),
    lines: rows.map((r) => ({
      id: r.id,
      variantLabel: r.variant_label,
      quantity: Number(r.quantity),
    })),
    variations: (variations ?? []).map((v) => {
      const pv = v.packaging_variations as unknown as { id: string; name: string; format: string };
      return { variationId: pv.id, name: pv.name, format: pv.format };
    }),
  });
}

/**
 * POST — revise the shipment: unship it and rebook it at the stated quantities.
 *
 * The admin client, not the session client: `reverse_shipment` is SECURITY
 * DEFINER and granted to service_role only. The operator's reason is written to
 * `edit_reason` and to the replacement's notes, and the audit trigger on
 * export_transactions records the rows either way.
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const { id } = await params;

  let body: { lines?: Array<{ variation_id: string; quantity: number }>; reason?: string; channel?: string; recipient_id?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  try {
    const result = await reviseShipment(supabase, id, {
      lines: body.lines ?? [],
      reason: body.reason ?? null,
      channel: body.channel,
      recipient_id: body.recipient_id,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ReviseShipmentError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Revision failed" },
      { status: 500 },
    );
  }
}
