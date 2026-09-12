import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  loadPackagingYieldPct,
  projectBatchYield,
} from "@/lib/production/exportIngredientDeposit";
import type { LedgerTransfer } from "@/lib/production/volumeLedger";

export const dynamic = "force-dynamic";

interface AllocationJoin {
  id: string;
  batch_id: string | null;
  channel: string | null;
  partner_id: string | null;
  contract_request_id: string | null;
  percentage: number | null;
  invoice_generated_at: string | null;
  invoice_sent_at: string | null;
  invoice_paid_at: string | null;
  refund_amount_cents: number | null;
  refunded_at: string | null;
  brew_batches: { beer_name: string; batch_number: string; volume_bbl: number } | null;
}

export async function GET() {
  try { await requirePermission(CAP.exportRead); } catch (res) { return res as Response; }

  // Admin client, not the server client: `invoices` and
  // `deposit_invoice_ingredients` both carry an admin-ONLY RLS policy (see
  // 20260609_invoices.sql / 20260709_deposit_invoice_ingredients.sql), so a
  // brewer passing the exportRead gate above still got a silent empty list.
  // The requirePermission call is the authorization gate — same pattern as
  // every sibling route that reads this table (export/invoices, export/invoice,
  // deposit-invoices/backfill).
  const supabase = createSupabaseAdminClient();

  const { data, error } = await supabase
    .from("invoices")
    .select(`
      id, invoice_number, invoice_date, customer_name, partner_id,
      status, source, square_invoice_id, total_cents,
      deposit_invoice_ingredients(
        id, ingredient_name, unit, quantity_per_bbl, cost_per_unit_usd, line_total_cents, sort_order
      ),
      contract_brewing_partners!partner_id(company_name),
      batch_allocations!allocation_id(
        id, batch_id, channel, partner_id, contract_request_id,
        percentage, invoice_generated_at, invoice_sent_at, invoice_paid_at,
        refund_amount_cents, refunded_at,
        brew_batches(beer_name, batch_number, volume_bbl)
      )
    `)
    .eq("invoice_type", "allocation_deposit")
    .order("invoice_date", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const allocations = (data ?? [])
    .map((inv) => inv.batch_allocations as unknown as AllocationJoin | null)
    .filter((a): a is AllocationJoin => !!a?.batch_id);
  const batchIds = [...new Set(allocations.map((a) => a.batch_id as string))];
  const commitmentIds = [...new Set(allocations.map((a) => a.contract_request_id).filter(Boolean))] as string[];

  // Everything the yield projection and fulfillment figures need, fetched once
  // for all invoices rather than per row.
  const packagingYieldPct = await loadPackagingYieldPct(supabase);

  const tankTypeById: Record<string, string> = {};
  const ledgerByBatch = new Map<string, Array<LedgerTransfer & { transfer_type: string }>>();
  const exportsByBatch = new Map<string, Array<{ channel: string | null; recipient_id: string | null; volume_bbl: number | null }>>();
  const bookedByCommitment = new Map<string, number>();

  if (batchIds.length > 0) {
    const [{ data: equipment }, { data: transfers }, { data: exports_ }, { data: commitments }] =
      await Promise.all([
        supabase.from("equipment").select("id, type"),
        supabase
          .from("batch_transfers")
          .select("batch_id, from_tank_id, to_tank_id, to_batch_id, volume_bbl, shrinkage_bbl, transferred_at, transfer_type")
          .or(`batch_id.in.(${batchIds.join(",")}),to_batch_id.in.(${batchIds.join(",")})`),
        supabase
          .from("export_transactions")
          .select("batch_id, channel, recipient_id, volume_bbl")
          .in("batch_id", batchIds),
        commitmentIds.length > 0
          ? supabase.from("commitments").select("id, volume_bbl").in("id", commitmentIds)
          : Promise.resolve({ data: [] as Array<{ id: string; volume_bbl: number | null }> }),
      ]);

    for (const e of equipment ?? []) tankTypeById[e.id as string] = e.type as string;
    for (const t of (transfers ?? []) as Array<LedgerTransfer & { transfer_type: string }>) {
      // A conversion row belongs to BOTH ledgers: it leaves the source batch and
      // hands volume into the target — projectBatchYield needs it on each side.
      for (const id of new Set([t.batch_id, t.to_batch_id].filter(Boolean) as string[])) {
        if (!batchIds.includes(id)) continue;
        const list = ledgerByBatch.get(id) ?? [];
        list.push(t);
        ledgerByBatch.set(id, list);
      }
    }
    for (const e of exports_ ?? []) {
      const id = e.batch_id as string | null;
      if (!id) continue;
      const list = exportsByBatch.get(id) ?? [];
      list.push(e as { channel: string | null; recipient_id: string | null; volume_bbl: number | null });
      exportsByBatch.set(id, list);
    }
    for (const c of (commitments ?? []) as Array<{ id: string; volume_bbl: number | null }>) {
      bookedByCommitment.set(c.id, Number(c.volume_bbl ?? 0));
    }
  }

  const enriched = (data ?? []).map((inv) => {
    const partner = inv.contract_brewing_partners as unknown as { company_name: string } | null;
    const alloc = inv.batch_allocations as unknown as AllocationJoin | null;
    const squareDashboardUrl = inv.square_invoice_id
      ? `https://app.squareup.com/dashboard/invoices/${inv.square_invoice_id}/edit?currentUnitToken=${process.env.SQUARE_LOCATION_ID}`
      : null;

    // Yield projection + fulfillment against the deposited allocation, so the
    // deposit invoice reads against the same numbers Export → Cold Storage
    // credits shipments with.
    let projectedYieldBbl: number | null = null;
    let packagedBbl: number | null = null;
    let inTankBbl: number | null = null;
    let guaranteedBbl: number | null = null;
    let fulfilledBbl: number | null = null;
    if (alloc?.batch_id && alloc.percentage != null) {
      const ledger = ledgerByBatch.get(alloc.batch_id) ?? [];
      if (ledger.length > 0) {
        const yieldProj = projectBatchYield(
          alloc.batch_id,
          Number(alloc.brew_batches?.volume_bbl ?? 0),
          ledger,
          tankTypeById,
          packagingYieldPct,
        );
        projectedYieldBbl = yieldProj.projectedYieldBbl;
        packagedBbl = yieldProj.packagedBbl;
        inTankBbl = yieldProj.inTankBbl;

        // Same cap as commitment fulfillment: the deposit guarantees the
        // allocation's share of what the batch yields, never more than the
        // commitment actually booked.
        const shareBbl = (Number(alloc.percentage) / 100) * yieldProj.projectedYieldBbl;
        const bookedBbl = alloc.contract_request_id
          ? bookedByCommitment.get(alloc.contract_request_id) ?? 0
          : 0;
        guaranteedBbl = bookedBbl > 0 ? Math.min(shareBbl, bookedBbl) : shareBbl;
      }
      fulfilledBbl = (exportsByBatch.get(alloc.batch_id) ?? [])
        .filter((e) => e.channel === alloc.channel && e.recipient_id === alloc.partner_id)
        .reduce((s, e) => s + Number(e.volume_bbl ?? 0), 0);
    }

    return {
      id: inv.id,
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      customer_name: inv.customer_name,
      partner_id: inv.partner_id,
      partner_name: partner?.company_name ?? null,
      status: inv.status,
      source: inv.source,
      square_invoice_id: inv.square_invoice_id,
      square_dashboard_url: squareDashboardUrl,
      total_cents: inv.total_cents,
      percentage: alloc?.percentage ?? null,
      beer_name: alloc?.brew_batches?.beer_name ?? null,
      batch_number: alloc?.brew_batches?.batch_number ?? null,
      volume_bbl: alloc?.brew_batches?.volume_bbl ?? null,
      generated_at: alloc?.invoice_generated_at ?? null,
      sent_at: alloc?.invoice_sent_at ?? null,
      paid_at: alloc?.invoice_paid_at ?? null,
      refund_amount_cents: alloc?.refund_amount_cents ?? null,
      refunded_at: alloc?.refunded_at ?? null,
      projected_yield_bbl: projectedYieldBbl,
      packaged_bbl: packagedBbl,
      in_tank_bbl: inTankBbl,
      packaging_yield_pct: packagingYieldPct,
      guaranteed_bbl: guaranteedBbl,
      fulfilled_bbl: fulfilledBbl,
      breakdown: (inv.deposit_invoice_ingredients ?? []).sort(
        (a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order
      ),
    };
  });

  return NextResponse.json(enriched);
}
