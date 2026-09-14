import { owedBbl, sumExportedByAllocation, type ExportVolumeRow } from "./allocationDelivery";
import { deriveCommitmentStage, type CommitmentStage } from "./commitmentStage";
import { classifyAdditions, type AdditionsStatus, type CoverageAllocFields } from "./depositCoverage";
import type { DepositChargesSummary } from "./depositCharges";

/**
 * The Partner Ledger: one partner's commitments, end to end.
 *
 * Every other screen shows one stage of the chain — Commitments shows the
 * ask, Batch Log the allocation, Deposit Invoices the deposit, Export Bay
 * the reserve, Shipments the drops, Export Invoices the bill. Staying on top
 * of a partner meant reading all six and doing the arithmetic. This module
 * folds the loaded rows into one structure per commitment:
 *
 *   booked → allocated (batch, %) → deposit ($ billed / paid / refunded)
 *          → shipped (per drop, credited by allocation_id)
 *          → export invoices ($ billed / paid) → remaining bbl
 *
 * plus the partner's over-delivery and ad-hoc shipments, which belong to no
 * commitment and are shown as their own lines rather than folded into one.
 *
 * Pure: the route loads, this shapes. Tested on the shapes.
 */

// ── Inputs (row shapes the route loads) ──────────────────────────────────────

export interface LedgerPartnerRow { id: string; company_name: string }

export interface LedgerCommitmentRow {
  id: string;
  partner_id: string | null;
  recipe_id: string | null;
  recipe_name: string | null;
  channel: string;
  status: string;
  volume_bbl: number | string | null;
  desired_delivery_date: string | null;
  received_on: string | null;
  locked_on: string | null;
  split_from_commitment_id: string | null;
  notes: string | null;
}

export interface LedgerAllocationRow extends CoverageAllocFields {
  id: string;
  batch_id: string;
  channel: string;
  partner_id: string | null;
  contract_request_id: string | null;
  percentage: number | string;
  deposit_amount_paid_cents: number | null;
  refunded_at: string | null;
  written_off_bbl: number | string | null;
  write_off_note: string | null;
  batch_number: string | null;
  batch_status: string;
  batch_planned_bbl: number;
  beer_name: string | null;
}

export interface LedgerExportRow extends ExportVolumeRow {
  id: string;
  shipment_id: string | null;
  batch_id: string | null;
  batch_number: string | null;
  recipe_id: string | null;
  recipe_name: string | null;
  channel: string;
  recipient_id: string | null;
  variant_label: string | null;
  quantity: number | string | null;
  status: string;
  invoice_id: string | null;
  is_ad_hoc: boolean | null;
  over_allocation: boolean | null;
  is_phantom: boolean | null;
  source_ref: string | null;
  created_at: string;
  /** Credited a contract allocation whose deposit was unpaid at ship time. */
  shipped_before_deposit?: boolean | null;
}

export interface LedgerInvoiceRow {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  status: string;
  source: string | null;
  invoice_type: string | null;
  total_cents: number | null;
  square_invoice_id: string | null;
  allocation_id: string | null;
}

export interface LedgerInput {
  partners: LedgerPartnerRow[];
  commitments: LedgerCommitmentRow[];
  allocations: LedgerAllocationRow[];
  /** kegging + canning net fill, per batch id */
  producedByBatch: Map<string, number>;
  /** sum of allocation percentages per batch id (any channel) */
  allocatedPctByBatch: Map<string, number>;
  /** every non-taproom export row for these partners (credited or not) */
  exports: LedgerExportRow[];
  /** invoices referenced by those exports or by the allocations' deposits */
  invoices: LedgerInvoiceRow[];
  chargesByAllocation: Map<string, DepositChargesSummary>;
}

// ── Output ───────────────────────────────────────────────────────────────────

export interface LedgerInvoiceRef {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  status: string;
  source: string | null;
  total_cents: number;
}

export interface LedgerShipment {
  shipment_id: string | null;
  date: string;
  batch_number: string | null;
  /** The (logical) batch the rows sit on — one per shipment in practice. */
  batch_id: string | null;
  /** export_transactions ids in this shipment, for re-homing. */
  transaction_ids: string[];
  lines: Array<{ variant_label: string | null; quantity: number; volume_bbl: number; over_allocation: boolean; is_ad_hoc: boolean; shipped_before_deposit: boolean }>;
  volume_bbl: number;
  status: string;
  invoice: LedgerInvoiceRef | null;
  /** Reversal / refund / revision rows carry a source_ref; shown as such. */
  kind: "shipment" | "reversal" | "refund" | "revision";
}

export interface LedgerAllocation {
  id: string;
  batch_number: string | null;
  batch_status: string;
  beer_name: string | null;
  percentage: number;
  /** How the % was derived: booked ÷ planned batch volume. */
  batch_planned_bbl: number;
  /** Share of the batch nobody has claimed (100 − Σ allocations), in % and bbl of planned. */
  batch_unallocated_pct: number;
  produced_bbl: number;
  owed_bbl: number;
  exported_bbl: number;
  remaining_bbl: number;
  written_off_bbl: number | null;
  write_off_note: string | null;
  deposit: {
    state: AdditionsStatus;
    via: "backcharge" | "own_invoice" | null;
    invoice: LedgerInvoiceRef | null;
    /** When the deposit was marked paid. Survives a later write-off of the
     *  remaining VOLUME — that forgives beer, not the money already taken. */
    paid_at: string | null;
    paid_cents: number;
    refunded_cents: number;
    charged_cents: number;
    collected_cents: number;
    backcharge_invoices: LedgerInvoiceRef[];
  };
}

export interface LedgerCommitment {
  id: string;
  recipe_name: string | null;
  channel: string;
  stage: CommitmentStage;
  booked_bbl: number;
  desired_delivery_date: string | null;
  received_on: string | null;
  locked_on: string | null;
  is_split: boolean;
  notes: string | null;
  allocations: LedgerAllocation[];
  shipments: LedgerShipment[];
  export_invoices: LedgerInvoiceRef[];
  totals: LedgerCommitmentTotals;
}

export interface LedgerCommitmentTotals {
  /** Shipments credited to this deal that have no invoice yet — bill them from the row. */
  uninvoiced_transaction_ids?: string[];
  owed_bbl: number;
  shipped_bbl: number;
  remaining_bbl: number;
  uninvoiced_bbl: number;
  deposit_billed_cents: number;
  deposit_paid_cents: number;
  deposit_refunded_cents: number;
  export_billed_cents: number;
  export_paid_cents: number;
}

export interface LedgerPartner {
  partner_id: string;
  company_name: string;
  /** This partner's allocations by batch id — the targets a stray shipment can be re-homed to. */
  allocations_by_batch: Record<string, { allocation_id: string; commitment_id: string; recipe_name: string | null; batch_number: string | null }[]>;
  commitments: LedgerCommitment[];
  /** Shipped with no commitment behind it: over-delivery and ad-hoc drops. */
  unallocated: LedgerShipment[];
  unallocated_bbl: number;
  unallocated_uninvoiced_transaction_ids: string[];
  totals: LedgerCommitmentTotals;
}

// ── Builder ──────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;

function invoiceRef(inv: LedgerInvoiceRow | undefined): LedgerInvoiceRef | null {
  if (!inv) return null;
  return {
    id: inv.id,
    invoice_number: inv.invoice_number,
    invoice_date: inv.invoice_date,
    status: inv.status,
    source: inv.source,
    total_cents: Number(inv.total_cents ?? 0),
  };
}

function shipmentKind(rows: LedgerExportRow[]): LedgerShipment["kind"] {
  const ref = rows.find((r) => r.source_ref)?.source_ref ?? null;
  if (!ref) return "shipment";
  if (ref.startsWith("refund:")) return "refund";
  if (ref.startsWith("revision:")) return "revision";
  return "reversal";
}

/** Group export rows into shipments (one shipment_id = one drop). Exported for tests. */
export function groupShipments(rows: LedgerExportRow[], invoiceById: Map<string, LedgerInvoiceRow>): LedgerShipment[] {
  const groups = new Map<string, LedgerExportRow[]>();
  for (const r of rows) {
    const key = r.shipment_id ?? `row:${r.id}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const first = group[0];
      const invoiceId = group.find((g) => g.invoice_id)?.invoice_id ?? null;
      return {
        shipment_id: first.shipment_id ?? null,
        date: group.reduce((d, g) => (g.created_at < d ? g.created_at : d), first.created_at),
        batch_number: [...new Set(group.map((g) => g.batch_number).filter(Boolean))].join(", ") || null,
        batch_id: first.batch_id ?? null,
        transaction_ids: group.map((g) => g.id),
        lines: group.map((g) => ({
          variant_label: g.variant_label,
          quantity: Number(g.quantity ?? 0),
          volume_bbl: r2(Number(g.volume_bbl ?? 0)),
          over_allocation: !!g.over_allocation,
          is_ad_hoc: !!g.is_ad_hoc,
          shipped_before_deposit: !!g.shipped_before_deposit,
        })),
        volume_bbl: r2(group.reduce((s, g) => s + Number(g.volume_bbl ?? 0), 0)),
        status: first.status,
        invoice: invoiceRef(invoiceId ? invoiceById.get(invoiceId) : undefined),
        kind: shipmentKind(group),
        _key: key,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(({ _key: _ignored, ...s }) => { void _ignored; return s; });
}

function emptyTotals(): LedgerCommitmentTotals {
  return {
    owed_bbl: 0, shipped_bbl: 0, remaining_bbl: 0, uninvoiced_bbl: 0,
    deposit_billed_cents: 0, deposit_paid_cents: 0, deposit_refunded_cents: 0,
    export_billed_cents: 0, export_paid_cents: 0,
  };
}

function addTotals(into: LedgerCommitmentTotals, t: LedgerCommitmentTotals): void {
  for (const k of Object.keys(into) as Array<keyof LedgerCommitmentTotals>) {
    if (k === "uninvoiced_transaction_ids") continue;
    into[k] = r2((into[k] as number) + (t[k] as number));
  }
}

export function buildPartnerLedger(input: LedgerInput): LedgerPartner[] {
  const invoiceById = new Map(input.invoices.map((i) => [i.id, i]));
  const depositInvoiceBySquareId = new Map(
    input.invoices.filter((i) => i.invoice_type === "allocation_deposit" && i.square_invoice_id && i.status !== "voided")
      .map((i) => [i.square_invoice_id as string, i]),
  );
  const depositInvoiceByAllocation = new Map(
    input.invoices.filter((i) => i.invoice_type === "allocation_deposit" && i.allocation_id && i.status !== "voided")
      .map((i) => [i.allocation_id as string, i]),
  );
  const exportedByAllocation = sumExportedByAllocation(input.exports);
  const exportsByAllocation = new Map<string, LedgerExportRow[]>();
  for (const e of input.exports) {
    if (!e.allocation_id) continue;
    (exportsByAllocation.get(e.allocation_id) ?? exportsByAllocation.set(e.allocation_id, []).get(e.allocation_id)!).push(e);
  }
  const allocsByCommitment = new Map<string, LedgerAllocationRow[]>();
  for (const a of input.allocations) {
    if (!a.contract_request_id) continue;
    (allocsByCommitment.get(a.contract_request_id) ?? allocsByCommitment.set(a.contract_request_id, []).get(a.contract_request_id)!).push(a);
  }

  const partners: LedgerPartner[] = [];
  for (const p of input.partners) {
    const commitments = input.commitments
      .filter((c) => c.partner_id === p.id)
      .map((c): LedgerCommitment => {
        const booked = Number(c.volume_bbl ?? 0);
        const allocs = (allocsByCommitment.get(c.id) ?? []).map((a): LedgerAllocation => {
          const produced = input.producedByBatch.get(a.batch_id) ?? 0;
          const pct = Number(a.percentage);
          const owed = owedBbl({ channel: a.channel, percentage: pct, producedBbl: produced, bookedBbl: a.channel === "contract_brewing" && booked > 0 ? booked : null });
          const exported = exportedByAllocation.get(a.id) ?? 0;
          const charges = input.chargesByAllocation.get(a.id) ?? null;
          const additions = classifyAdditions(a, charges);
          const depositInvoice = (a.square_deposit_invoice_id ? depositInvoiceBySquareId.get(a.square_deposit_invoice_id) : undefined)
            ?? depositInvoiceByAllocation.get(a.id);
          const backchargeInvoices = (charges?.invoiceIds ?? [])
            .map((id) => invoiceRef(invoiceById.get(id)))
            .filter((x): x is LedgerInvoiceRef => !!x);
          return {
            id: a.id,
            batch_number: a.batch_number,
            batch_status: a.batch_status,
            beer_name: a.beer_name,
            percentage: pct,
            batch_planned_bbl: a.batch_planned_bbl,
            batch_unallocated_pct: r2(Math.max(0, 100 - (input.allocatedPctByBatch.get(a.batch_id) ?? 0))),
            produced_bbl: r2(produced),
            owed_bbl: r2(owed),
            exported_bbl: r2(exported),
            remaining_bbl: r2(Math.max(0, owed - exported)),
            written_off_bbl: a.written_off_bbl != null ? Number(a.written_off_bbl) : null,
            write_off_note: a.write_off_note,
            deposit: {
              state: additions.status,
              via: additions.via,
              invoice: invoiceRef(depositInvoice),
              paid_at: a.invoice_paid_at ?? null,
              paid_cents: Number(a.deposit_amount_paid_cents ?? 0),
              refunded_cents: Number(a.refund_amount_cents ?? 0),
              charged_cents: additions.chargedCents,
              collected_cents: additions.collectedCents,
              backcharge_invoices: backchargeInvoices,
            },
          };
        });

        const rows = allocs.flatMap((a) => exportsByAllocation.get(a.id) ?? []);
        const shipments = groupShipments(rows, invoiceById);
        const exportInvoiceIds = [...new Set(rows.map((r) => r.invoice_id).filter((id): id is string => !!id))];
        const exportInvoices = exportInvoiceIds
          .map((id) => invoiceRef(invoiceById.get(id)))
          .filter((x): x is LedgerInvoiceRef => !!x)
          .sort((x, y) => (y.invoice_date ?? "").localeCompare(x.invoice_date ?? ""));

        const totals = emptyTotals();
        totals.owed_bbl = r2(allocs.reduce((s, a) => s + a.owed_bbl, 0));
        totals.shipped_bbl = r2(allocs.reduce((s, a) => s + a.exported_bbl, 0));
        totals.remaining_bbl = r2(allocs.filter((a) => a.written_off_bbl == null).reduce((s, a) => s + a.remaining_bbl, 0));
        const uninvoicedRows = rows.filter((r) => !r.invoice_id && r.status === "invoice_required");
        totals.uninvoiced_bbl = r2(rows.filter((r) => !r.invoice_id).reduce((s, r) => s + Number(r.volume_bbl ?? 0), 0));
        totals.uninvoiced_transaction_ids = uninvoicedRows.map((r) => r.id);
        totals.deposit_billed_cents = allocs.reduce((s, a) => s + (a.deposit.invoice?.total_cents ?? 0) + a.deposit.charged_cents, 0);
        totals.deposit_paid_cents = allocs.reduce((s, a) => s + a.deposit.paid_cents + a.deposit.collected_cents, 0);
        totals.deposit_refunded_cents = allocs.reduce((s, a) => s + a.deposit.refunded_cents, 0);
        totals.export_billed_cents = exportInvoices.filter((i) => i.status !== "voided").reduce((s, i) => s + i.total_cents, 0);
        totals.export_paid_cents = exportInvoices.filter((i) => i.status === "paid").reduce((s, i) => s + i.total_cents, 0);

        const stage = deriveCommitmentStage({
          storedStatus: c.status,
          allocations: allocs.map((a) => ({
            exportedBbl: a.exported_bbl, owedBbl: a.owed_bbl, writtenOff: a.written_off_bbl != null,
          })),
        });

        return {
          id: c.id,
          recipe_name: c.recipe_name,
          channel: c.channel,
          stage,
          booked_bbl: r2(booked),
          desired_delivery_date: c.desired_delivery_date,
          received_on: c.received_on,
          locked_on: c.locked_on,
          is_split: !!c.split_from_commitment_id,
          notes: c.notes,
          allocations: allocs,
          shipments,
          export_invoices: exportInvoices,
          totals,
        };
      })
      .sort((a, b) => (a.desired_delivery_date ?? "9999").localeCompare(b.desired_delivery_date ?? "9999"));

    const unallocatedRows = input.exports.filter((e) => e.recipient_id === p.id && !e.allocation_id && e.channel !== "taproom");
    const unallocated = groupShipments(unallocatedRows, invoiceById);
    const totals = emptyTotals();
    for (const c of commitments) addTotals(totals, c.totals);

    if (commitments.length === 0 && unallocated.length === 0) continue;
    const allocationsByBatch: LedgerPartner["allocations_by_batch"] = {};
    for (const c of commitments) {
      for (const a of c.allocations) {
        const row = input.allocations.find((r) => r.id === a.id);
        if (!row) continue;
        (allocationsByBatch[row.batch_id] ??= []).push({ allocation_id: a.id, commitment_id: c.id, recipe_name: c.recipe_name, batch_number: a.batch_number });
      }
    }
    partners.push({
      partner_id: p.id,
      company_name: p.company_name,
      allocations_by_batch: allocationsByBatch,
      commitments,
      unallocated,
      unallocated_bbl: r2(unallocatedRows.reduce((s, r) => s + Number(r.volume_bbl ?? 0), 0)),
      unallocated_uninvoiced_transaction_ids: unallocatedRows.filter((r) => !r.invoice_id && r.status === "invoice_required").map((r) => r.id),
      totals,
    });
  }
  return partners.sort((a, b) => a.company_name.localeCompare(b.company_name));
}
