import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  calculateIngredientDeposit,
  createDepositInvoice,
  publishDepositInvoice,
  reviseDepositInvoice,
  getDepositInvoiceStatus,
} from "@/lib/square/deposit-invoices";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

// ── GET /api/production/allocations/[id]/invoice ──────────────────────────────
// Preview the deposit calculation without creating anything in Square.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;

  // Fetch allocation with partner and batch info
  const { data: allocation, error } = await supabase
    .from("batch_allocations")
    .select("*, brew_batches(id, beer_name, volume_bbl, turns, recipe_id), contract_brewing_partners(id, company_name, square_customer_id)")
    .eq("id", id)
    .single();

  if (error || !allocation) {
    return NextResponse.json({ error: "Allocation not found" }, { status: 404 });
  }

  if (allocation.channel !== "contract_brewing") {
    return NextResponse.json({ error: "Deposit invoices are only available for contract_brewing allocations" }, { status: 400 });
  }

  const partner = allocation.contract_brewing_partners as { id: string; company_name: string; square_customer_id: string | null } | null;
  if (!partner?.square_customer_id) {
    return NextResponse.json({ error: "Partner has no linked Square customer ID" }, { status: 400 });
  }

  const batchId = allocation.batch_id;
  const percentage = Number(allocation.percentage);

  const calculation = await calculateIngredientDeposit(supabase, batchId, percentage);
  return NextResponse.json({ allocation, calculation });
}

// ── POST /api/production/allocations/[id]/invoice ────────────────────────────
// Actions: generate | send | sync
export async function POST(req: NextRequest, { params }: RouteParams) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const adminSupabase = createSupabaseAdminClient();
  const { id } = await params;
  const body = await req.json();
  const action = body.action as "generate" | "send" | "sync";

  if (!["generate", "send", "sync"].includes(action)) {
    return NextResponse.json({ error: "action must be generate | send | sync" }, { status: 400 });
  }

  // Fetch allocation with all needed joined data
  const { data: allocation, error: fetchErr } = await supabase
    .from("batch_allocations")
    .select("*, brew_batches(id, beer_name, volume_bbl, turns, recipe_id, planned_brew_date, expected_delivery_date), contract_brewing_partners(id, company_name, square_customer_id)")
    .eq("id", id)
    .single();

  if (fetchErr || !allocation) {
    return NextResponse.json({ error: "Allocation not found" }, { status: 404 });
  }

  if (allocation.channel !== "contract_brewing") {
    return NextResponse.json({ error: "Deposit invoices are only available for contract_brewing allocations" }, { status: 400 });
  }

  const partner = allocation.contract_brewing_partners as { id: string; company_name: string; square_customer_id: string | null } | null;
  if (!partner?.square_customer_id) {
    return NextResponse.json({ error: "Partner has no linked Square customer ID — add it in the Partners tab" }, { status: 400 });
  }

  const batch = allocation.brew_batches as { id: string; beer_name: string; volume_bbl: number; turns: number; recipe_id: string; planned_brew_date: string; expected_delivery_date: string | null } | null;
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  // ── generate ──────────────────────────────────────────────────────────────
  if (action === "generate") {
    // If there's already a paid invoice, block generation
    if (allocation.invoice_paid_at) {
      return NextResponse.json({ error: "Invoice has already been paid — allocation is locked" }, { status: 422 });
    }

    const calculation = await calculateIngredientDeposit(supabase, batch.id, Number(allocation.percentage));

    if (calculation.deposit_cents === 0) {
      return NextResponse.json({ error: "Deposit amount is $0 — check that recipe ingredients have costs set" }, { status: 422 });
    }

    const serviceDate = batch.planned_brew_date;
    const dueDate = batch.expected_delivery_date ?? batch.planned_brew_date;
    const title = `Ingredient Deposit — ${batch.beer_name} (${Number(allocation.percentage).toFixed(1)}% allocation)`;
    const description = `Deposit for ${Number(allocation.percentage).toFixed(1)}% of ${batch.beer_name} batch. Covers ingredient costs for your allocated share.`;

    const invoiceParams = {
      squareCustomerId: partner.square_customer_id,
      title,
      description,
      depositCents: calculation.deposit_cents,
      serviceDate,
      dueDate,
    };

    // If there's an existing invoice (paid check already done above), cancel + recreate.
    const isRevision = !!allocation.square_deposit_invoice_id;
    let result;
    if (isRevision) {
      // Void the old ledger row before creating the replacement
      await adminSupabase
        .from("invoices")
        .update({ status: "voided" })
        .eq("source", "square")
        .eq("external_id", allocation.square_deposit_invoice_id!);

      result = await reviseDepositInvoice(allocation.square_deposit_invoice_id!, invoiceParams);
    } else {
      result = await createDepositInvoice(invoiceParams);
    }

    // Persist the new Square IDs and generation timestamp
    const { data: updated, error: updateErr } = await supabase
      .from("batch_allocations")
      .update({
        square_deposit_invoice_id: result.invoiceId,
        square_deposit_order_id: result.orderId,
        invoice_generated_at: new Date().toISOString(),
        invoice_sent_at: null, // reset if this was a revision
      })
      .eq("id", id)
      .select("*")
      .single();

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    // Upsert into the finance invoices ledger and link to batch
    const ledgerInvoiceId = await upsertFinanceLedgerInvoice(adminSupabase, {
      squareInvoiceId: result.invoiceId,
      allocationId: id,
      partnerId: partner.id,
      customerName: partner.company_name,
      invoiceDate: serviceDate,
      dueDate,
      title,
      depositCents: calculation.deposit_cents,
      status: "draft",
    });

    if (ledgerInvoiceId) {
      await adminSupabase
        .from("invoice_batch_links")
        .upsert(
          { invoice_id: ledgerInvoiceId, batch_id: batch.id },
          { onConflict: "invoice_id,batch_id", ignoreDuplicates: true }
        );
    }

    return NextResponse.json({ allocation: updated, calculation, invoiceId: result.invoiceId, invoiceUrl: result.invoiceUrl });
  }

  // ── send ──────────────────────────────────────────────────────────────────
  if (action === "send") {
    if (!allocation.square_deposit_invoice_id) {
      return NextResponse.json({ error: "No invoice has been generated yet — run generate first" }, { status: 400 });
    }
    if (allocation.invoice_paid_at) {
      return NextResponse.json({ error: "Invoice is already paid" }, { status: 422 });
    }
    if (allocation.invoice_sent_at) {
      return NextResponse.json({ error: "Invoice has already been sent — sync to check payment status" }, { status: 400 });
    }

    // Check Square status first — if the invoice is already UNPAID/PAID (e.g. a
    // prior send succeeded but our DB update failed), skip the publish call to
    // avoid a Square error and just record the sent timestamp below.
    const currentSquareStatus = await getDepositInvoiceStatus(allocation.square_deposit_invoice_id);
    if (currentSquareStatus.status === "PAID") {
      return NextResponse.json({ error: "Invoice is already paid in Square — use sync to update status" }, { status: 422 });
    }
    if (currentSquareStatus.status === "DRAFT") {
      await publishDepositInvoice(allocation.square_deposit_invoice_id);
    }
    // If UNPAID/SCHEDULED: already published, just record the timestamp below.

    const sentAt = new Date().toISOString();
    const { data: updated, error: updateErr } = await supabase
      .from("batch_allocations")
      .update({ invoice_sent_at: sentAt })
      .eq("id", id)
      .select("*")
      .single();

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    // Update finance ledger status to open (sent = awaiting payment)
    await adminSupabase
      .from("invoices")
      .update({ status: "open" })
      .eq("source", "square")
      .eq("external_id", allocation.square_deposit_invoice_id);

    return NextResponse.json({ allocation: updated });
  }

  // ── sync ──────────────────────────────────────────────────────────────────
  if (action === "sync") {
    if (!allocation.square_deposit_invoice_id) {
      return NextResponse.json({ error: "No invoice to sync" }, { status: 400 });
    }

    const squareStatus = await getDepositInvoiceStatus(allocation.square_deposit_invoice_id);

    const allocationUpdate: Record<string, unknown> = {};
    const invoiceUpdate: Record<string, unknown> = { status: mapSquareStatus(squareStatus.status) };

    if (squareStatus.status === "PAID" && !allocation.invoice_paid_at) {
      allocationUpdate.invoice_paid_at = squareStatus.paidAt ?? new Date().toISOString();
      allocationUpdate.locked = true;
      allocationUpdate.lock_reason = "deposit_paid";
      allocationUpdate.locked_at = new Date().toISOString();
    }

    if (squareStatus.status === "CANCELED" || squareStatus.status === "FAILED") {
      allocationUpdate.invoice_sent_at = null;
    }

    let updated = allocation;
    if (Object.keys(allocationUpdate).length > 0) {
      const { data, error: updateErr } = await supabase
        .from("batch_allocations")
        .update(allocationUpdate)
        .eq("id", id)
        .select("*")
        .single();
      if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
      updated = data;
    }

    // Update finance ledger
    await adminSupabase
      .from("invoices")
      .update(invoiceUpdate)
      .eq("source", "square")
      .eq("external_id", allocation.square_deposit_invoice_id);

    return NextResponse.json({ allocation: updated, squareStatus: squareStatus.status });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapSquareStatus(squareStatus: string): string {
  const map: Record<string, string> = {
    DRAFT:           "draft",
    UNPAID:          "open",
    SCHEDULED:       "open",
    PARTIALLY_PAID:  "partial",
    PAID:            "paid",
    REFUNDED:        "paid",
    CANCELED:        "voided",
    FAILED:          "voided",
  };
  return map[squareStatus] ?? "unknown";
}

interface LedgerInvoiceParams {
  squareInvoiceId: string;
  allocationId: string;
  partnerId: string;
  customerName: string;
  invoiceDate: string;
  dueDate: string;
  title: string;
  depositCents: number;
  status: string;
}

async function upsertFinanceLedgerInvoice(
  adminSupabase: ReturnType<typeof createSupabaseAdminClient>,
  p: LedgerInvoiceParams
) {
  const { data: inv } = await adminSupabase
    .from("invoices")
    .upsert(
      {
        source:          "square",
        external_id:     p.squareInvoiceId,
        invoice_type:    "allocation_deposit",
        allocation_id:   p.allocationId,
        partner_id:      p.partnerId,
        customer_name:   p.customerName,
        invoice_date:    p.invoiceDate,
        due_date:        p.dueDate,
        invoice_number:  null,
        status:          p.status,
        subtotal_cents:  p.depositCents,
        tax_cents:       0,
        total_cents:     p.depositCents,
        notes:           p.title,
      },
      { onConflict: "source,external_id", ignoreDuplicates: false }
    )
    .select("id")
    .single();

  if (!inv?.id) return null;

  // Add the deposit line item
  await adminSupabase
    .from("invoice_line_items")
    .upsert(
      {
        invoice_id:       inv.id,
        sort_order:       0,
        description:      "Ingredient Deposit",
        category:         "other_services",
        quantity:         1,
        unit_price_cents: p.depositCents,
        total_cents:      p.depositCents,
      },
      { onConflict: "invoice_id,sort_order" }
    );

  return inv.id;
}
