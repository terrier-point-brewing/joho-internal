import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyAdditions, classifyBase, type CoverageAllocFields } from "@/lib/production/depositCoverage";

export const dynamic = "force-dynamic";

interface PackagingPrefInput {
  variation_id: string;
  qty: number;
}

function parsePackaging(b: Record<string, unknown>): PackagingPrefInput[] | undefined {
  if (!Array.isArray(b.packaging)) return undefined;
  return (b.packaging as Array<{ variation_id?: string; qty?: number | string }>)
    .filter((p) => p.variation_id && p.qty != null && Number(p.qty) > 0)
    .map((p) => ({ variation_id: p.variation_id as string, qty: Number(p.qty) }));
}

async function replacePackagingPreferences(supabase: SupabaseClient, commitmentId: string, prefs: PackagingPrefInput[]) {
  await supabase.from("commitment_packaging_preferences").delete().eq("commitment_id", commitmentId);
  if (prefs.length === 0) return;
  await supabase.from("commitment_packaging_preferences").insert(
    prefs.map((p) => ({ commitment_id: commitmentId, variation_id: p.variation_id, qty: p.qty }))
  );
}

const COMMITMENT_SELECT = `*, recipes(beer_name, style), contract_brewing_partners(company_name),
  commitment_packaging_preferences(id, commitment_id, variation_id, qty, created_at, packaging_variations(id, name, total_volume_fl_oz, container_id, format))`;

export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.partnersRead); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from("commitments")
    .select(COMMITMENT_SELECT)
    .order("created_at", { ascending: false });
  const channel = req.nextUrl.searchParams.get("channel");
  if (channel) query = query.eq("channel", channel);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data || data.length === 0) return NextResponse.json(data);

  // Rename the join to the field name the UI expects.
  const withPrefs = data.map((c) => {
    const row = c as typeof c & { commitment_packaging_preferences?: unknown };
    const { commitment_packaging_preferences, ...rest } = row;
    return { ...rest, packaging_preferences: commitment_packaging_preferences ?? [] };
  });

  // Pull linked batch_allocations once: used both to sum committed BBL (across
  // all channels) and to surface invoicing controls for contract_brewing rows.
  const ids = withPrefs.map((c) => c.id);
  const { data: allocs } = await supabase
    .from("batch_allocations")
    .select(`id, batch_id, partner_id, contract_request_id, percentage, channel,
      square_deposit_invoice_id, deposit_backcharged_invoice_id,
      invoice_generated_at, invoice_sent_at, invoice_paid_at,
      refund_amount_cents, written_off_at,
      brew_batches(id, beer_name, batch_number, volume_bbl, converted_from_batch_id),
      contract_brewing_partners(id, company_name)`)
    .in("contract_request_id", ids);

  // Parent allocations for conversion children — the base half of the deposit
  // coverage line lives on the batch the liquid was brewed in.
  const parentIds = [...new Set(
    (allocs ?? [])
      .filter((a) => a.channel === "contract_brewing"
        && (a.brew_batches as { converted_from_batch_id?: string | null } | null)?.converted_from_batch_id)
      .map((a) => (a.brew_batches as unknown as { converted_from_batch_id: string }).converted_from_batch_id),
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
    for (const p of parentAllocs ?? []) parentAllocByKey.set(`${p.batch_id}:${p.partner_id ?? ""}`, p);
    for (const b of parentBatches ?? []) parentBatchNumberById.set(b.id, (b as { batch_number: string | null }).batch_number ?? null);
  }

  const committedById: Record<string, number> = {};
  const allocsById: Record<string, typeof allocs> = {};
  for (const a of allocs ?? []) {
    if (!a.contract_request_id) continue;
    const vol = Number((a.brew_batches as { volume_bbl?: number } | null)?.volume_bbl ?? 0);
    committedById[a.contract_request_id] = (committedById[a.contract_request_id] ?? 0) + (Number(a.percentage) / 100) * vol;
    if (a.channel === "contract_brewing") {
      (allocsById[a.contract_request_id] ??= []).push(a);
    }
  }

  // Fetch invoice numbers for deposit invoices and for export invoices that
  // carry a back-charged deposit.
  const parentAllocList = [...parentAllocByKey.values()];
  const squareDepositIds = [
    ...(allocs ?? []).map((a) => a.square_deposit_invoice_id),
    ...parentAllocList.map((p) => p.square_deposit_invoice_id as string | null),
  ].filter((id): id is string => !!id);
  const backchargeInvoiceIds = [
    ...(allocs ?? []).map((a) => (a as { deposit_backcharged_invoice_id?: string | null }).deposit_backcharged_invoice_id),
    ...parentAllocList.map((p) => p.deposit_backcharged_invoice_id as string | null),
  ].filter((id): id is string => !!id);

  const invoiceNumberBySquareId = new Map<string, string | null>();
  const invoiceNumberById = new Map<string, string | null>();
  if (squareDepositIds.length > 0 || backchargeInvoiceIds.length > 0) {
    // `invoices` is RLS-locked to admins; read via the service-role client so
    // deposit invoice numbers resolve for non-admin callers too (see the export
    // invoices route for the same rationale).
    const admin = createSupabaseAdminClient();
    if (squareDepositIds.length > 0) {
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
    if (backchargeInvoiceIds.length > 0) {
      const { data: exportInvoices } = await admin
        .from("invoices")
        .select("id, invoice_number")
        .in("id", backchargeInvoiceIds);
      for (const inv of exportInvoices ?? []) {
        invoiceNumberById.set(inv.id, inv.invoice_number ?? null);
      }
    }
  }

  const enriched = withPrefs.map((c) => ({
    ...c,
    committed_allocated_bbl: committedById[c.id] ?? 0,
    batch_allocations: (allocsById[c.id] ?? []).map((a) => {
      const backchargeId = (a as { deposit_backcharged_invoice_id?: string | null }).deposit_backcharged_invoice_id ?? null;

      // Deposit coverage for conversion children: base = the parent batch's
      // deposit state (chargeable again when refunded), additions = this
      // allocation's own invoice or back-charge. Same classifiers as the
      // allocations GET and the billing exclusions.
      const parentBatchId = (a.brew_batches as { converted_from_batch_id?: string | null } | null)?.converted_from_batch_id ?? null;
      const parent = parentBatchId
        ? (parentAllocByKey.get(`${parentBatchId}:${(a as { partner_id?: string | null }).partner_id ?? ""}`) ?? null) as (CoverageAllocFields & { square_deposit_invoice_id: string | null }) | null
        : null;
      const additions = classifyAdditions(a as unknown as CoverageAllocFields);
      const base = classifyBase(!!parentBatchId, parent);

      return {
        ...a,
        deposit_invoice_number: a.square_deposit_invoice_id
          ? (invoiceNumberBySquareId.get(a.square_deposit_invoice_id) ?? null)
          : null,
        backcharge_invoice_number: backchargeId ? (invoiceNumberById.get(backchargeId) ?? null) : null,
        deposit_coverage: {
          base: {
            status: base.status,
            parent_batch_number: parentBatchId ? (parentBatchNumberById.get(parentBatchId) ?? null) : null,
            parent_refund_cents: base.parentRefundCents,
            covered_by_invoice_number: parent
              ? (parent.square_deposit_invoice_id
                  ? (invoiceNumberBySquareId.get(parent.square_deposit_invoice_id) ?? null)
                  : parent.deposit_backcharged_invoice_id
                    ? (invoiceNumberById.get(parent.deposit_backcharged_invoice_id) ?? null)
                    : null)
              : null,
          },
          additions: {
            status: additions.status,
            via: additions.via,
            invoice_number: backchargeId
              ? (invoiceNumberById.get(backchargeId) ?? null)
              : (a.square_deposit_invoice_id ? (invoiceNumberBySquareId.get(a.square_deposit_invoice_id) ?? null) : null),
          },
        },
      };
    }),
  }));
  return NextResponse.json(enriched);
}

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.partnersOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  const b = await req.json();
  const { recipe_id, partner_id, volume_bbl } = b;
  if (!recipe_id || volume_bbl == null) {
    return NextResponse.json({ error: "recipe_id and volume_bbl are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("commitments")
    .insert({
      recipe_id,
      partner_id: partner_id || null,
      volume_bbl,
      desired_delivery_date: b.desired_delivery_date || null,
      status: b.status || "open",
      notes: b.notes || null,
      channel: b.channel || "contract_brewing",
      cadence: b.cadence || "one_time",
      recurrence: b.recurrence || null,
      start_date: b.start_date || null,
      end_date: b.end_date || null,
      received_on: b.received_on || null,
      locked_on: b.locked_on || null,
      last_edited_on: new Date().toISOString(),
    })
    .select(COMMITMENT_SELECT)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const prefs = parsePackaging(b);
  if (prefs && prefs.length > 0) {
    await replacePackagingPreferences(supabase, data.id, prefs);
  }

  const { data: full } = await supabase.from("commitments").select(COMMITMENT_SELECT).eq("id", data.id).single();
  return NextResponse.json(full ?? data, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  try { await requirePermission(CAP.partnersOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const b = await req.json();
  const allowed = ["recipe_id", "status", "notes", "volume_bbl", "desired_delivery_date", "partner_id", "channel", "cadence", "recurrence", "start_date", "end_date", "received_on", "locked_on"];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in b) patch[k] = b[k];
  const prefs = parsePackaging(b);
  if (Object.keys(patch).length === 0 && !prefs) return NextResponse.json({ error: "no fields to update" }, { status: 400 });

  if (Object.keys(patch).length > 0) {
    patch.last_edited_on = new Date().toISOString();
    const { error } = await supabase.from("commitments").update(patch).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (prefs) {
    await replacePackagingPreferences(supabase, id, prefs);
  }

  // Propagate commitment changes to linked unlocked allocations.
  // "Unlocked" = invoice_paid_at IS NULL. Paid allocations are frozen.
  const syncableFields = ["channel", "partner_id", "volume_bbl"] as const;
  const hasSyncableChange = syncableFields.some(f => f in patch);
  if (hasSyncableChange) {
    // Fetch linked allocations with their batch volumes for percentage recalculation.
    type LinkedAlloc = {
      id: string;
      channel: string;
      invoice_generated_at: string | null;
      invoice_sent_at: string | null;
      brew_batches: { volume_bbl: string } | null;
    };
    const { data: linked } = await supabase
      .from("batch_allocations")
      .select("id, channel, invoice_generated_at, invoice_sent_at, brew_batches(volume_bbl)")
      .eq("contract_request_id", id)
      .is("invoice_paid_at", null) as { data: LinkedAlloc[] | null };

    for (const alloc of linked ?? []) {
      const allocUpdate: Record<string, unknown> = {};

      if ("channel" in patch) allocUpdate.channel = patch.channel;
      if ("partner_id" in patch) allocUpdate.partner_id = patch.partner_id ?? null;
      if ("volume_bbl" in patch) {
        const batchVol = Number(alloc.brew_batches?.volume_bbl ?? 0);
        if (batchVol > 0) {
          const newPct = Math.round((Number(patch.volume_bbl) / batchVol) * 1000) / 10;
          // Guard: only apply if the recalculated value is a valid percentage.
          if (newPct > 0 && newPct <= 100) allocUpdate.percentage = newPct;
        }
      }

      // If channel is changing to/from contract_brewing, or percentage is recalculating,
      // clear stale draft invoice timestamps so the user must regenerate.
      const oldChannel = alloc.channel;
      const newChannel = ("channel" in patch ? String(patch.channel) : oldChannel);
      const isContractBrewingRelated = oldChannel === "contract_brewing" || newChannel === "contract_brewing";
      if (isContractBrewingRelated && ("channel" in allocUpdate || "percentage" in allocUpdate)) {
        allocUpdate.invoice_generated_at = null;
        allocUpdate.invoice_sent_at = null;
      }

      if (Object.keys(allocUpdate).length > 0) {
        await supabase.from("batch_allocations").update(allocUpdate).eq("id", alloc.id);
      }
    }
  }

  const { data, error } = await supabase.from("commitments").select(COMMITMENT_SELECT).eq("id", id).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  try { await requirePermission(CAP.partnersOperate); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabase.from("commitments").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
