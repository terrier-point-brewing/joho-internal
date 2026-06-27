import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET /api/production/allocations?batch_id=<uuid>
// Returns allocations enriched with fulfillment data computed from export_transactions and batch_transfers.
export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const batch_id = req.nextUrl.searchParams.get("batch_id");

  let query = supabase
    .from("batch_allocations")
    .select(`
      *,
      brew_batches(id, beer_name, batch_number, volume_bbl, recipe_id),
      contract_brewing_partners(id, company_name),
      commitments(id, beer_style, volume_bbl, desired_delivery_date, received_on, created_at, channel)
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

  // Build fulfillment lookup: key = `${batch_id}:${channel}:${recipient_id ?? ""}`
  const exportedMap: Record<string, number> = {};
  for (const e of exports_ ?? []) {
    const key = `${e.batch_id}:${e.channel}:${e.recipient_id ?? ""}`;
    exportedMap[key] = (exportedMap[key] ?? 0) + (e.volume_bbl ?? 0);
  }

  const enriched = allocations.map((a) => {
    const produced = producedByBatch[a.batch_id] ?? 0;
    const allocated_bbl = produced > 0 ? (a.percentage / 100) * produced : null;
    const key = `${a.batch_id}:${a.channel}:${a.partner_id ?? ""}`;
    const exported_bbl = exportedMap[key] ?? 0;
    const fulfilled = allocated_bbl != null && exported_bbl >= allocated_bbl;
    return { ...a, allocated_bbl, exported_bbl, fulfilled, produced_bbl: produced > 0 ? produced : null };
  });

  // Fetch invoice numbers for any deposit invoices linked via square_deposit_invoice_id
  const squareDepositIds = enriched
    .map((a) => a.square_deposit_invoice_id)
    .filter((id): id is string => !!id);

  const invoiceNumberBySquareId = new Map<string, string | null>();
  if (squareDepositIds.length > 0) {
    const { data: depositInvoices } = await supabase
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
  const { batch_id, channel, label, percentage, partner_id, contract_request_id, notes } = body;

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
      label,
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
