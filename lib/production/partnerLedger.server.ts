import type { SupabaseClient } from "@supabase/supabase-js";
import { loadDepositCharges } from "@/lib/production/depositCharges";
import { loadBatchYields } from "@/lib/production/batchYieldProjection.server";
import {
  buildPartnerLedger,
  type LedgerAllocationRow,
  type LedgerCommitmentRow,
  type LedgerExportRow,
  type LedgerInvoiceRow,
  type LedgerPartner,
} from "@/lib/production/partnerLedger";

/**
 * Loads every row the partner ledger is built from and shapes it. Lifted out of
 * the /api/production/partner-ledger route verbatim so the partner portal's
 * history tab reads the SAME ledger staff do — one builder, one set of numbers.
 *
 * Needs the service-role client: `invoices` and `allocation_deposit_charges`
 * sit in the admin-only RLS cluster. The caller's permission check is the
 * authorization.
 */
export async function loadPartnerLedger(admin: SupabaseClient): Promise<LedgerPartner[]> {

  const [{ data: partners }, { data: commitments }, { data: allocations }, { data: exports_ }] = await Promise.all([
    admin.from("contract_brewing_partners").select("id, company_name").order("company_name"),
    admin.from("commitments")
      .select("id, partner_id, recipe_id, channel, status, volume_bbl, desired_delivery_date, received_on, locked_on, split_from_commitment_id, notes, recipes(beer_name, style)"),
    admin.from("batch_allocations")
      .select(`id, batch_id, channel, partner_id, contract_request_id, percentage,
        invoice_paid_at, invoice_sent_at, invoice_generated_at, deposit_backcharged_invoice_id, square_deposit_invoice_id,
        deposit_amount_paid_cents, refund_amount_cents, refunded_at, written_off_at, written_off_bbl, write_off_note,
        brew_batches(batch_number, status, volume_bbl, beer_name)`),
    admin.from("export_transactions")
      .select("id, shipment_id, batch_id, recipe_id, allocation_id, channel, recipient_id, variant_label, quantity, volume_bbl, status, invoice_id, is_ad_hoc, over_allocation, is_phantom, source_ref, created_at, shipped_before_deposit, brew_batches(batch_number), recipes(beer_name), packaging_variations!variation_id(name)")
      .neq("channel", "taproom"),
  ]);

  const allocRows = (allocations ?? []) as unknown as Array<Omit<LedgerAllocationRow, "batch_number" | "batch_status" | "batch_planned_bbl" | "beer_name"> & {
    brew_batches: { batch_number: string | null; status: string | null; volume_bbl: number | null; beer_name: string | null } | null;
  }>;
  const batchIds = [...new Set(allocRows.map((a) => a.batch_id))];

  const [yields, chargesByAllocation, { data: invoices }, { data: conversions }] = await Promise.all([
    // Produced and projected per batch — the same loader the ship and re-home
    // planners measure a share against, so the ledger cannot disagree with
    // what the app lets through.
    loadBatchYields(admin, batchIds),
    loadDepositCharges(admin, allocRows.filter((a) => a.channel === "contract_brewing").map((a) => a.id)),
    admin.from("invoices")
      .select("id, invoice_number, invoice_date, status, source, invoice_type, total_cents, square_invoice_id, allocation_id")
      .in("invoice_type", ["allocation_deposit", "export_invoice"]),
    batchIds.length > 0
      ? admin.from("batch_conversions").select("source_batch_id, volume_bbl, target:brew_batches!target_batch_id(beer_name, batch_number)").in("source_batch_id", batchIds)
      : Promise.resolve({ data: [] as Array<{ source_batch_id: string; volume_bbl: number | null; target: unknown }> }),
  ]);

  const producedByBatch = new Map<string, number>();
  // What each batch is still expected to package: in-tank volume at the house
  // packaging yield. Zero once complete — nothing more is coming.
  const inTankByBatch = new Map<string, number>();
  for (const [bid, y] of yields) {
    producedByBatch.set(bid, y.producedBbl);
    inTankByBatch.set(bid, Math.max(0, y.projectedBbl - y.producedBbl));
  }
  const allocatedPctByBatch = new Map<string, number>();
  for (const a of allocRows) {
    allocatedPctByBatch.set(a.batch_id, (allocatedPctByBatch.get(a.batch_id) ?? 0) + Number(a.percentage));
  }
  // Converted liquid is allocated share too — the same reading Batch Log's
  // allocation bar gives (conversion volume ÷ planned volume).
  const plannedByBatch = new Map(allocRows.map((a) => [a.batch_id, Number(a.brew_batches?.volume_bbl ?? 0)]));
  const convertedByBatch = new Map<string, { pct: number; targets: string[] }>();
  for (const c of (conversions ?? []) as Array<{ source_batch_id: string; volume_bbl: number | null; target: { beer_name: string | null; batch_number: string | null } | { beer_name: string | null; batch_number: string | null }[] | null }>) {
    const planned = plannedByBatch.get(c.source_batch_id) ?? 0;
    if (planned <= 0) continue;
    const t = Array.isArray(c.target) ? c.target[0] : c.target;
    const entry = convertedByBatch.get(c.source_batch_id) ?? { pct: 0, targets: [] };
    entry.pct += (Number(c.volume_bbl ?? 0) / planned) * 100;
    if (t?.beer_name) entry.targets.push(`${t.beer_name}${t.batch_number ? ` #${t.batch_number}` : ""}`);
    convertedByBatch.set(c.source_batch_id, entry);
  }

  const ledger = buildPartnerLedger({
    partners: (partners ?? []) as Array<{ id: string; company_name: string }>,
    commitments: ((commitments ?? []) as unknown as Array<Omit<LedgerCommitmentRow, "recipe_name"> & { recipes: { beer_name: string; style?: string | null } | null }>)
      .map(({ recipes, ...c }) => ({ ...c, recipe_name: recipes?.beer_name ?? null, recipe_style: recipes?.style ?? null })),
    allocations: allocRows.map(({ brew_batches, ...a }) => ({
      ...a,
      batch_number: brew_batches?.batch_number ?? null,
      batch_status: brew_batches?.status ?? "",
      batch_planned_bbl: Number(brew_batches?.volume_bbl ?? 0),
      beer_name: brew_batches?.beer_name ?? null,
    })),
    producedByBatch,
    allocatedPctByBatch,
    convertedByBatch,
    inTankByBatch,
    exports: ((exports_ ?? []) as unknown as Array<Omit<LedgerExportRow, "batch_number" | "recipe_name"> & {
      brew_batches: { batch_number: string | null } | null;
      recipes: { beer_name: string } | null;
      packaging_variations: { name: string } | null;
    }>).map(({ brew_batches, recipes, packaging_variations, ...e }) => ({
      ...e,
      batch_number: brew_batches?.batch_number ?? null,
      recipe_name: recipes?.beer_name ?? null,
      // The variation's CURRENT name; variant_label is the name on the day.
      variant_label: packaging_variations?.name ?? e.variant_label,
    })),
    invoices: (invoices ?? []) as LedgerInvoiceRow[],
    chargesByAllocation,
  });

  return ledger;
}
