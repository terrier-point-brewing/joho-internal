import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  calculateIngredientDeposit,
  cancelInvoice,
  createDepositInvoice,
  publishInvoice,
  reviseDepositInvoice,
  getInvoiceStatus,
} from "@/lib/square/square-invoices";
import { reconcileInvoiceStatus } from "@/lib/finance/reconcileInvoiceStatus";
import { snapshotDepositBreakdown, type BreakdownInput } from "@/lib/production/depositBreakdown";
import { getNetTermsDays } from "@/lib/production/invoiceTerms";
import { addDaysStr, todayLocalDate } from "@/lib/utils/datetime";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

// ── GET /api/production/allocations/[id]/invoice ──────────────────────────────
// Preview the deposit calculation without creating anything in Square.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

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

  // Build the Square Dashboard URL directly from the invoice ID — public_url is only
  // populated by Square after an invoice is sent, so it's always null for drafts.
  const invoiceUrl = allocation.square_deposit_invoice_id
    ? `https://app.squareup.com/dashboard/invoices/${allocation.square_deposit_invoice_id}/edit?currentUnitToken=${process.env.SQUARE_LOCATION_ID}`
    : null;

  return NextResponse.json({ allocation, calculation, invoiceUrl });
}

// ── POST /api/production/allocations/[id]/invoice ────────────────────────────
// Actions: generate | send | sync
export async function POST(req: NextRequest, { params }: RouteParams) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  try {
    return await handleInvoiceAction(req, params);
  } catch (e: unknown) {
    console.error("[deposit-invoice] POST failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unexpected error" }, { status: 500 });
  }
}

async function handleInvoiceAction(req: NextRequest, params: RouteParams["params"]) {
  const supabase = await createSupabaseServerClient();
  const adminSupabase = createSupabaseAdminClient();
  const { id } = await params;
  const body = await req.json();
  const action = body.action as "generate" | "send" | "sync";

  if (!["generate", "send", "sync", "delete", "mark_paid"].includes(action)) {
    return NextResponse.json({ error: "action must be generate | send | sync | delete | mark_paid" }, { status: 400 });
  }

  // Fetch allocation with all needed joined data
  const { data: allocation, error: fetchErr } = await supabase
    .from("batch_allocations")
    .select("*, brew_batches(id, beer_name, volume_bbl, turns, recipe_id, expected_delivery_date), contract_brewing_partners(id, company_name, square_customer_id), commitments!contract_request_id(volume_bbl)")
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

  const batch = allocation.brew_batches as { id: string; beer_name: string; volume_bbl: number; turns: number; recipe_id: string; expected_delivery_date: string | null } | null;
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  // ── generate ──────────────────────────────────────────────────────────────
  if (action === "generate") {
    if (allocation.invoice_paid_at) {
      return NextResponse.json({ error: "Invoice has already been paid — allocation is locked" }, { status: 422 });
    }

    const calculation = await calculateIngredientDeposit(supabase, batch.id, Number(allocation.percentage));

    if (calculation.deposit_cents === 0) {
      return NextResponse.json({ error: "Deposit amount is $0 — check that recipe ingredients have costs set" }, { status: 422 });
    }

    // Resolve the Ingredient Deposit Square item: partner-specific override first, then default.
    const { data: mappingRows, error: mappingErr } = await supabase
      .from("invoice_item_mappings")
      .select("partner_id, square_catalog_item_id, square_catalog_variation_id")
      .eq("service_type", "ingredient_deposit")
      .or(`partner_id.eq.${partner.id},partner_id.is.null`);
    if (mappingErr) return NextResponse.json({ error: mappingErr.message }, { status: 500 });
    const mapping = (mappingRows ?? []).find((m) => m.partner_id === partner.id) ?? (mappingRows ?? []).find((m) => m.partner_id === null);
    if (!mapping?.square_catalog_variation_id) {
      return NextResponse.json({ error: "Ingredient Deposit is not configured in Deposit Settings — set the Square item mapping before generating this invoice" }, { status: 422 });
    }

    // Due date = the date this invoice is drafted (today) + the single configured
    // net-terms value. Service date is the same draft date, so both flows behave
    // identically and the ledger stays consistent (due_date = invoice_date + terms).
    const netTerms = await getNetTermsDays(supabase, "deposit");
    const draftDate = todayLocalDate();
    const serviceDate = draftDate;
    const dueDate = addDaysStr(draftDate, netTerms);
    const pct = Number(allocation.percentage);
    const batchBbl = Number(batch.volume_bbl);
    const commitment = allocation.commitments as { volume_bbl: number } | null;
    const requestedBbl = commitment?.volume_bbl != null ? Number(commitment.volume_bbl) : null;

    const title = `Ingredient Deposit — ${batch.beer_name} (${pct.toFixed(1)}% allocation)`;
    const description = requestedBbl != null
      ? `Deposit for your ${requestedBbl.toFixed(1)} bbl commitment of a ${batchBbl.toFixed(1)} bbl ${batch.beer_name} batch (${requestedBbl.toFixed(1)} bbl ÷ ${batchBbl.toFixed(1)} bbl = ${pct.toFixed(1)}%). Covers ingredient costs for your contracted share.`
      : `Deposit for ${pct.toFixed(1)}% of ${batch.beer_name} batch (${batchBbl.toFixed(1)} bbl). Covers ingredient costs for your allocated share.`;

    const invoiceParams = {
      squareCustomerId: partner.square_customer_id,
      title,
      description,
      depositCents: calculation.deposit_cents,
      serviceDate,
      dueDate,
      depositVariationId: mapping.square_catalog_variation_id,
    };

    const isRevision = !!allocation.square_deposit_invoice_id;
    let result;
    if (isRevision) {
      await adminSupabase
        .from("invoices")
        .update({ status: "voided" })
        .eq("source", "square")
        .eq("square_invoice_id", allocation.square_deposit_invoice_id!);

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
      invoiceNumber: result.invoiceNumber,
    });

    if (ledgerInvoiceId) {
      await adminSupabase
        .from("invoice_batch_links")
        .upsert(
          { invoice_id: ledgerInvoiceId, batch_id: batch.id },
          { onConflict: "invoice_id,batch_id", ignoreDuplicates: true }
        );
    }

    if (ledgerInvoiceId) {
      try {
        await snapshotDepositBreakdown(
          adminSupabase,
          ledgerInvoiceId,
          calcToBreakdownInputs(calculation),
          calculation.deposit_cents
        );
      } catch (e) {
        console.error("[deposit-invoice] generate breakdown snapshot failed:", e);
      }
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
    const currentSquareStatus = await getInvoiceStatus(allocation.square_deposit_invoice_id);
    if (currentSquareStatus.status === "PAID") {
      return NextResponse.json({ error: "Invoice is already paid in Square — use sync to update status" }, { status: 422 });
    }
    if (currentSquareStatus.status === "DRAFT") {
      await publishInvoice(allocation.square_deposit_invoice_id);
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
      .eq("square_invoice_id", allocation.square_deposit_invoice_id);

    return NextResponse.json({ allocation: updated });
  }

  // ── sync ──────────────────────────────────────────────────────────────────
  if (action === "sync") {
    if (!allocation.square_deposit_invoice_id) {
      return NextResponse.json({ error: "No invoice to sync" }, { status: 400 });
    }

    const result = await reconcileInvoiceStatus(adminSupabase, allocation.square_deposit_invoice_id);

    // Re-read the allocation (server client, RLS-correct) for the response.
    const { data: updated, error: reReadErr } = await supabase
      .from("batch_allocations")
      .select("*")
      .eq("id", id)
      .single();
    if (reReadErr) return NextResponse.json({ error: reReadErr.message }, { status: 500 });

    return NextResponse.json({ allocation: updated, squareStatus: result.squareStatus });
  }

  // ── delete ────────────────────────────────────────────────────────────────
  if (action === "delete") {
    if (!allocation.square_deposit_invoice_id) {
      return NextResponse.json({ error: "No invoice to delete" }, { status: 400 });
    }
    if (allocation.invoice_paid_at) {
      return NextResponse.json({ error: "Cannot delete a paid invoice" }, { status: 422 });
    }

    // Cancel in Square first — swallow errors for already-cancelled invoices.
    try {
      await cancelInvoice(allocation.square_deposit_invoice_id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // If it's already cancelled/not found, proceed so DB is cleaned up.
      if (!msg.includes("CANCELED") && !msg.includes("NOT_FOUND")) {
        throw e;
      }
    }

    // Void in finance ledger
    await adminSupabase
      .from("invoices")
      .update({ status: "voided" })
      .eq("source", "square")
      .eq("square_invoice_id", allocation.square_deposit_invoice_id);

    // Clear invoice fields so a new one can be generated
    const { data: updated, error: updateErr } = await supabase
      .from("batch_allocations")
      .update({
        square_deposit_invoice_id: null,
        square_deposit_order_id: null,
        invoice_generated_at: null,
        invoice_sent_at: null,
      })
      .eq("id", id)
      .select("*")
      .single();

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    return NextResponse.json({ allocation: updated });
  }

  // ── mark_paid ─────────────────────────────────────────────────────────────
  if (action === "mark_paid") {
    const source = body.source as string;
    if (!["quickbooks", "other"].includes(source)) {
      return NextResponse.json({ error: "source must be quickbooks or other" }, { status: 422 });
    }
    if (allocation.invoice_paid_at) {
      return NextResponse.json({ error: "Allocation is already marked as paid" }, { status: 422 });
    }

    const paidAt      = body.paid_at      as string | undefined;
    const amountCents = body.amount_cents  as number | undefined;
    const externalRef = body.external_ref  as string | undefined;

    if (!paidAt)                          return NextResponse.json({ error: "paid_at is required" }, { status: 400 });
    if (amountCents === undefined || amountCents < 0) return NextResponse.json({ error: "amount_cents must be non-negative" }, { status: 400 });
    if (source === "quickbooks" && !externalRef) return NextResponse.json({ error: "external_ref (QB invoice number) is required" }, { status: 400 });

    const now = new Date().toISOString();

    const { data: updated, error: updateErr } = await supabase
      .from("batch_allocations")
      .update({
        invoice_paid_at:           paidAt,
        deposit_amount_paid_cents: amountCents,
        invoice_generated_at:      allocation.invoice_generated_at ?? now,
        invoice_sent_at:           allocation.invoice_sent_at ?? now,
      })
      .eq("id", id)
      .select("*")
      .single();

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    const pct = Number(allocation.percentage);
    const { data: inv } = await adminSupabase
      .from("invoices")
      .upsert(
        {
          source:        source === "quickbooks" ? "quickbooks" : "other",
          external_id:   externalRef,
          invoice_number: externalRef,
          invoice_type:  "allocation_deposit",
          allocation_id: id,
          partner_id:    partner.id,
          customer_name: partner.company_name,
          invoice_date:  paidAt.slice(0, 10),
          status:        "paid",
          subtotal_cents: amountCents,
          tax_cents:     0,
          total_cents:   amountCents,
          notes:         `QB backfill — ${batch.beer_name} deposit (${pct.toFixed(1)}%)`,
        },
        { onConflict: "source,external_id", ignoreDuplicates: false }
      )
      .select("id")
      .single();

    if (inv?.id) {
      await adminSupabase
        .from("invoice_batch_links")
        .upsert(
          { invoice_id: inv.id, batch_id: batch.id },
          { onConflict: "invoice_id,batch_id", ignoreDuplicates: true }
        );
    }

    if (inv?.id) {
      try {
        const calc = await calculateIngredientDeposit(supabase, batch.id, Number(allocation.percentage));
        await snapshotDepositBreakdown(adminSupabase, inv.id, calcToBreakdownInputs(calc), amountCents);
      } catch (e) {
        console.error("[deposit-invoice] mark_paid breakdown snapshot failed:", e);
      }
    }

    return NextResponse.json({ allocation: updated });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcToBreakdownInputs(calc: { breakdown: Array<{ ingredient_id: string; name: string; unit: string; quantity_per_bbl: number; cost_per_unit: number; line_total_usd: number }> }): BreakdownInput[] {
  return calc.breakdown.map((b) => ({
    ingredient_id: b.ingredient_id,
    name: b.name,
    unit: b.unit,
    quantity_per_bbl: b.quantity_per_bbl,
    cost_per_unit: b.cost_per_unit,
    weight: b.line_total_usd, // full-batch cost; volume/% cancel under scaling
  }));
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
  invoiceNumber?: string | null;
}

async function upsertFinanceLedgerInvoice(
  adminSupabase: ReturnType<typeof createSupabaseAdminClient>,
  p: LedgerInvoiceParams
) {
  const { data: inv } = await adminSupabase
    .from("invoices")
    .upsert(
      {
        source:            "square",
        external_id:       p.squareInvoiceId,
        square_invoice_id: p.squareInvoiceId,
        invoice_type:      "allocation_deposit",
        allocation_id:   p.allocationId,
        partner_id:      p.partnerId,
        customer_name:   p.customerName,
        invoice_date:    p.invoiceDate,
        due_date:        p.dueDate,
        invoice_number:  p.invoiceNumber ?? null,
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
        category:         "ingredient_deposit",
        quantity:         1,
        unit_price_cents: p.depositCents,
        total_cents:      p.depositCents,
      },
      { onConflict: "invoice_id,sort_order" }
    );

  return inv.id;
}
