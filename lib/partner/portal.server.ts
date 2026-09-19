import type { SupabaseClient } from "@supabase/supabase-js";
import { requirePermission, CAP, type Session } from "@/lib/auth";
import { can } from "@/lib/auth/resolve";
import { todayLocalDate } from "@/lib/utils/datetime";
import { getBreweryTimezone } from "@/lib/settings/breweryTimezone.server";
import type { LedgerInvoiceRef, LedgerPartner } from "@/lib/production/partnerLedger";
import { loadPackagingYieldPct, projectBatchYield } from "@/lib/production/exportIngredientDeposit";
import type { LedgerTransfer } from "@/lib/production/volumeLedger";
import { type BusyInterval, type Fermenter } from "./capacity";
import { claimPool, DEFAULT_TAPROOM_BUFFER_PCT, visibleToPartner, type ClaimPool } from "./claimable";

/**
 * Server half of the partner portal.
 *
 * THE RULE OF THIS FILE: a partner's browser receives only what a function here
 * explicitly builds for it. Every loader reads with the service-role client
 * (the partner's own token is denied at the database) and then projects to a
 * named, narrow shape — never `select *`, never a row passed through. Cost,
 * other partners, tank names and batch internals stay on this side.
 */

export const TAPROOM_BUFFER_KEY = "partner_portal_taproom_buffer_pct";
/** Assumed fermentation when a tank is occupied but nothing is scheduled for it. */
const UNSCHEDULED_OCCUPANCY_DAYS = 14;
/**
 * A tank still full after its planned end date frees up at an unknown time.
 * Assume a week: long enough not to promise a partner tomorrow, short enough
 * not to hide a tank that is about to open.
 */
const OVERRUN_GRACE_DAYS = 7;

export interface PortalCaller { session: Session; partnerId: string; preview: boolean }

/**
 * Who is asking, and for which company. The company comes from the caller's
 * profile — never from the request — with one exception: staff who manage
 * partners (in practice, admin) may preview the portal as a company with `?as=`.
 */
export async function requirePartner(req: Request): Promise<PortalCaller> {
  const session = await requirePermission(CAP.partnerPortal);
  if (session.partnerId) return { session, partnerId: session.partnerId, preview: false };

  const as = new URL(req.url).searchParams.get("as");
  if (as && can(session.grants, CAP.partnersManage.scope, CAP.partnersManage.level)) {
    return { session, partnerId: as, preview: true };
  }
  throw new Response("This login is not linked to a partner company.", { status: 403 });
}

export async function breweryToday(): Promise<string> {
  return todayLocalDate(await getBreweryTimezone());
}

export async function loadTaproomBufferPct(admin: SupabaseClient): Promise<number> {
  const { data } = await admin.from("system_settings").select("value").eq("key", TAPROOM_BUFFER_KEY).maybeSingle();
  const pct = Number(data?.value);
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : DEFAULT_TAPROOM_BUFFER_PCT;
}

// ── Capacity ────────────────────────────────────────────────────────────────

export async function loadCapacityInputs(admin: SupabaseClient, today: string): Promise<{ fermenters: Fermenter[]; busy: BusyInterval[] }> {
  const { data: equipment } = await admin.from("equipment").select("id, capacity_bbl").eq("type", "fermenter");
  const fermenters = (equipment ?? []) as Fermenter[];
  const ids = fermenters.map((f) => f.id);
  if (ids.length === 0) return { fermenters, busy: [] };

  const [{ data: entries }, { data: assignments }] = await Promise.all([
    // Every entry that has not finished — including ones past their planned
    // end. A fermentation that has overrun is still in the tank.
    admin.from("batch_schedule_entries")
      .select("equipment_id, planned_start, planned_end, actual_start")
      .in("equipment_id", ids).is("cancelled_at", null).is("actual_end", null).is("completed_at", null),
    admin.from("batch_tank_assignments").select("tank_id, assigned_at").in("tank_id", ids).is("released_at", null),
  ]);

  const iso = (daysFromToday: number) => new Date(Date.parse(`${today}T00:00:00Z`) + daysFromToday * 86_400_000).toISOString();
  const overrunEnd = iso(1 + OVERRUN_GRACE_DAYS);
  const busy: BusyInterval[] = [];
  const liveTanks = new Set<string>();
  for (const e of (entries ?? []) as Array<{ equipment_id: string; planned_start: string; planned_end: string; actual_start: string | null }>) {
    const started = e.actual_start != null;
    // Planned for the past and never started: a stale plan, not a tank in use.
    if (!started && e.planned_end < iso(0)) continue;
    if (started) liveTanks.add(e.equipment_id);
    // Beer that is in the tank past its plan will not be out tomorrow.
    const end = started && e.planned_end < overrunEnd ? overrunEnd : e.planned_end;
    busy.push({ equipment_id: e.equipment_id, start: e.planned_start, end });
  }
  // A tank holding beer with no live schedule entry is still not empty.
  for (const a of (assignments ?? []) as Array<{ tank_id: string; assigned_at: string }>) {
    if (liveTanks.has(a.tank_id)) continue;
    const assumed = new Date(Date.parse(a.assigned_at) + UNSCHEDULED_OCCUPANCY_DAYS * 86_400_000).toISOString();
    busy.push({ equipment_id: a.tank_id, start: a.assigned_at, end: assumed > overrunEnd ? assumed : overrunEnd });
  }
  return { fermenters, busy };
}

// ── Claimable beer ──────────────────────────────────────────────────────────

/** Less than a half-barrel keg is a rounding crumb, not an offer. */
const MIN_OFFER_BBL = 0.5;

export interface ClaimableBatch {
  batch_id: string;
  beer_name: string;
  style: string | null;
  abv: number | null;
  ready_by: string | null;
  /** True once the beer is packaged — it is ready now, not an estimate. */
  packaged: boolean;
  claimable_bbl: number;
}

interface BatchRow {
  id: string; beer_name: string | null; volume_bbl: number | null; status: string; expected_delivery_date: string | null;
  recipes: { beer_name: string | null; style: string | null; abv: number | null; partner_id: string | null; contract_brewing_partners: { recipes_exclusive: boolean } | null } | null;
}

/** Claim pools for the given batches (or every open batch), keyed by batch id. */
export async function loadClaimPools(
  admin: SupabaseClient,
  opts: { batchIds?: string[] } = {},
): Promise<Map<string, { batch: BatchRow; pool: ClaimPool; readyBy: string | null; packaged: boolean }>> {
  let q = admin.from("brew_batches")
    .select("id, beer_name, volume_bbl, status, expected_delivery_date, recipes(beer_name, style, abv, partner_id, contract_brewing_partners(recipes_exclusive))")
    .neq("status", "complete");
  if (opts.batchIds) q = q.in("id", opts.batchIds);
  const { data: batchRows } = await q;
  const batches = (batchRows ?? []) as unknown as BatchRow[];
  const ids = batches.map((b) => b.id);
  const out = new Map<string, { batch: BatchRow; pool: ClaimPool; readyBy: string | null; packaged: boolean }>();
  if (ids.length === 0) return out;

  const [{ data: allocs }, { data: transfers }, { data: exports_ }, { data: conversions }, { data: entries }, bufferPct, { data: equipment }, yieldPct] = await Promise.all([
    admin.from("batch_allocations").select("id, batch_id, channel, percentage, written_off_at").in("batch_id", ids),
    // The whole ledger, both sides of a conversion — what projectBatchYield needs
    // to say how much beer is still in tank.
    admin.from("batch_transfers")
      .select("batch_id, from_tank_id, to_tank_id, to_batch_id, volume_bbl, shrinkage_bbl, transferred_at, transfer_type")
      .or(`batch_id.in.(${ids.join(",")}),to_batch_id.in.(${ids.join(",")})`),
    admin.from("export_transactions").select("batch_id, allocation_id, volume_bbl").in("batch_id", ids),
    admin.from("batch_conversions").select("source_batch_id, volume_bbl").in("source_batch_id", ids),
    admin.from("batch_schedule_entries").select("batch_id, planned_end").in("batch_id", ids).is("cancelled_at", null),
    loadTaproomBufferPct(admin),
    admin.from("equipment").select("id, type"),
    loadPackagingYieldPct(admin),
  ]);
  const ledger = (transfers ?? []) as Array<LedgerTransfer & { transfer_type: string }>;
  const tankTypeById: Record<string, string> = {};
  for (const e of (equipment ?? []) as Array<{ id: string; type: string }>) tankTypeById[e.id] = e.type;

  const sum = <T,>(rows: T[] | null, key: (r: T) => string, val: (r: T) => number) => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) m.set(key(r), (m.get(key(r)) ?? 0) + val(r));
    return m;
  };
  const produced = sum(ledger.filter((t) => t.transfer_type === "kegging" || t.transfer_type === "canning"), (t) => t.batch_id, (t) => Number(t.volume_bbl ?? 0));
  const exportRows = (exports_ ?? []) as Array<{ batch_id: string; allocation_id: string | null; volume_bbl: number | null }>;
  const exported = sum(exportRows.filter((e) => e.allocation_id != null), (e) => e.allocation_id as string, (e) => Number(e.volume_bbl ?? 0));
  const exportedByBatch = sum(exportRows, (e) => e.batch_id, (e) => Number(e.volume_bbl ?? 0));
  const converted = sum(conversions as Array<{ source_batch_id: string; volume_bbl: number | null }> | null, (c) => c.source_batch_id, (c) => Number(c.volume_bbl ?? 0));
  const lastEnd = new Map<string, string>();
  for (const e of (entries ?? []) as Array<{ batch_id: string; planned_end: string }>) {
    if ((lastEnd.get(e.batch_id) ?? "") < e.planned_end) lastEnd.set(e.batch_id, e.planned_end);
  }

  for (const b of batches) {
    const producedBbl = produced.get(b.id) ?? 0;
    const projection = projectBatchYield(
      b.id, Number(b.volume_bbl ?? 0), ledger.filter((t) => t.batch_id === b.id || t.to_batch_id === b.id), tankTypeById, yieldPct);
    const pool = claimPool({
      planned_bbl: Number(b.volume_bbl ?? 0),
      produced_bbl: producedBbl,
      projected_bbl: projection.projectedYieldBbl,
      converted_bbl: converted.get(b.id) ?? 0,
      total_exported_bbl: exportedByBatch.get(b.id) ?? 0,
      bufferPct,
      allocations: ((allocs ?? []) as Array<{ id: string; batch_id: string; channel: string; percentage: number | string; written_off_at: string | null }>)
        .filter((a) => a.batch_id === b.id)
        .map((a) => ({ id: a.id, channel: a.channel, percentage: Number(a.percentage), written_off_at: a.written_off_at, exported_bbl: exported.get(a.id) ?? 0 })),
    });
    out.set(b.id, {
      batch: b, pool, packaged: producedBbl > 0 && projection.inTankBbl < 0.05,
      readyBy: b.expected_delivery_date ?? lastEnd.get(b.id)?.slice(0, 10) ?? null,
    });
  }
  return out;
}

export async function loadClaimableForPartner(admin: SupabaseClient, partnerId: string): Promise<ClaimableBatch[]> {
  const [pools, today] = await Promise.all([loadClaimPools(admin), breweryToday()]);
  const rows: ClaimableBatch[] = [];
  for (const { batch, pool, readyBy, packaged } of pools.values()) {
    if (pool.claimableBbl < MIN_OFFER_BBL) continue;
    const owner = { partner_id: batch.recipes?.partner_id ?? null, exclusive: batch.recipes?.contract_brewing_partners?.recipes_exclusive ?? false };
    if (!visibleToPartner(partnerId, owner)) continue;
    rows.push({
      batch_id: batch.id,
      beer_name: batch.recipes?.beer_name ?? batch.beer_name ?? "Beer",
      style: batch.recipes?.style ?? null,
      abv: batch.recipes?.abv ?? null,
      // A planned date that has already passed is not a promise worth showing.
      ready_by: readyBy && readyBy >= today ? readyBy : null,
      packaged,
      claimable_bbl: pool.claimableBbl,
    });
  }
  return rows.sort((a, b) => (a.ready_by ?? "9999").localeCompare(b.ready_by ?? "9999"));
}

// ── History ─────────────────────────────────────────────────────────────────

export type PaymentStatus = "paid" | "unpaid" | "not_invoiced";

export interface PortalInvoice {
  id: string;
  number: string | null;
  date: string | null;
  kind: "shipment" | "deposit";
  status: "paid" | "unpaid";
  total_cents: number;
}

export interface PortalDeal {
  id: string;
  beer_name: string | null;
  status: "open" | "closed" | "cancelled";
  booked_bbl: number;
  shipped_bbl: number;
  remaining_bbl: number;
  in_tank_bbl: number;
  desired_delivery_date: string | null;
  received_on: string | null;
  /** Ingredient deposit, contract brewing only. Null when the deal has none. */
  deposit: { billed_cents: number; paid_cents: number; status: PaymentStatus } | null;
  shipments: Array<{
    date: string; volume_bbl: number;
    lines: Array<{ label: string | null; quantity: number }>;
    payment: PaymentStatus;
    invoice: PortalInvoice | null;
  }>;
}

export interface PortalHistory {
  summary: {
    shipped_bbl: number;
    paid_cents: number;
    outstanding_cents: number;
    open_deals: number;
    to_come_bbl: number;
  };
  /** Invoices sent and not yet paid, oldest first. */
  open_invoices: PortalInvoice[];
  deals: PortalDeal[];
  /** Beer shipped outside any commitment. */
  other_shipments: PortalDeal["shipments"];
}

const EMPTY_HISTORY: PortalHistory = {
  summary: { shipped_bbl: 0, paid_cents: 0, outstanding_cents: 0, open_deals: 0, to_come_bbl: 0 },
  open_invoices: [], deals: [], other_shipments: [],
};

/**
 * The partner's own deals, from the same ledger staff read. What is dropped on
 * purpose: batch numbers and percentages (they reveal batch size and who else
 * is on it), invoice LINES and unit prices (they hold those on the invoice we
 * sent), notes (written for staff), and every attention flag.
 *
 * Money is summed per INVOICE, deduplicated by id, never per deal: one invoice
 * can bill shipments on several deals, and a back-charged deposit is a line on
 * a shipment invoice — summing the ledger's per-deal totals would count both
 * twice. A voided invoice is not money owed; a deposit drafted but not yet
 * sent is not the partner's to pay yet.
 */
export function toPortalHistory(ledger: LedgerPartner | undefined): PortalHistory {
  if (!ledger) return EMPTY_HISTORY;

  const invoices = new Map<string, PortalInvoice>();
  const note = (ref: LedgerInvoiceRef | null | undefined, kind: PortalInvoice["kind"]): PortalInvoice | null => {
    if (!ref || ref.status === "voided") return null;
    const inv: PortalInvoice = {
      id: ref.id, number: ref.invoice_number, date: ref.invoice_date, kind,
      status: ref.status === "paid" ? "paid" : "unpaid", total_cents: ref.total_cents,
    };
    if (!invoices.has(inv.id)) invoices.set(inv.id, inv);
    return invoices.get(inv.id)!;
  };
  const shipmentsOf = (rows: LedgerPartner["unallocated"]): PortalDeal["shipments"] =>
    rows.filter((s) => s.kind === "shipment").map((s) => {
      const invoice = note(s.invoice, "shipment");
      return {
        date: s.date, volume_bbl: s.volume_bbl,
        lines: s.lines.map((l) => ({ label: l.variant_label, quantity: l.quantity })),
        payment: !invoice ? "not_invoiced" : invoice.status,
        invoice,
      };
    });

  let looseDepositPaid = 0;
  let refunded = 0;
  const deals: PortalDeal[] = ledger.commitments.map((c) => {
    for (const ref of c.export_invoices) note(ref, "shipment");
    let depositStatus: PaymentStatus = "not_invoiced";
    for (const a of c.allocations) {
      for (const ref of a.deposit.backcharge_invoices) note(ref, "shipment");
      refunded += a.deposit.refunded_cents;
      const sentOrPaid = a.deposit.invoice && (a.deposit.sent_at || a.deposit.invoice.status === "paid");
      if (sentOrPaid) note(a.deposit.invoice, "deposit");
      // Marked paid from QuickBooks: money received with no invoice row to carry it.
      else if (!a.deposit.invoice && a.deposit.paid_cents > 0) looseDepositPaid += a.deposit.paid_cents;
    }
    if (c.channel === "contract_brewing") {
      const billed = c.totals.deposit_billed_cents, paid = c.totals.deposit_paid_cents;
      depositStatus = billed <= 0 && paid <= 0 ? "not_invoiced" : paid >= billed ? "paid" : "unpaid";
    }
    return {
      id: c.id,
      beer_name: c.recipe_name,
      status: c.stage,
      booked_bbl: c.booked_bbl,
      shipped_bbl: c.totals.shipped_bbl,
      remaining_bbl: c.totals.remaining_bbl,
      in_tank_bbl: c.totals.in_tank_bbl,
      desired_delivery_date: c.desired_delivery_date,
      received_on: c.received_on,
      deposit: c.channel === "contract_brewing"
        ? { billed_cents: c.totals.deposit_billed_cents, paid_cents: c.totals.deposit_paid_cents - c.totals.deposit_refunded_cents, status: depositStatus }
        : null,
      shipments: shipmentsOf(c.shipments),
    };
  });
  // Open deals first — they are the ones with something still to happen.
  const rank = { open: 0, closed: 1, cancelled: 2 } as const;
  deals.sort((a, b) => rank[a.status] - rank[b.status] || (b.received_on ?? "").localeCompare(a.received_on ?? ""));

  const other_shipments = shipmentsOf(ledger.unallocated);
  const all = [...invoices.values()];
  const open = deals.filter((d) => d.status === "open");
  return {
    summary: {
      shipped_bbl: Math.round((deals.reduce((s, d) => s + d.shipped_bbl, 0) + other_shipments.reduce((s, x) => s + x.volume_bbl, 0)) * 100) / 100,
      paid_cents: Math.max(0, all.filter((i) => i.status === "paid").reduce((s, i) => s + i.total_cents, 0) + looseDepositPaid - refunded),
      outstanding_cents: all.filter((i) => i.status === "unpaid").reduce((s, i) => s + i.total_cents, 0),
      open_deals: open.length,
      to_come_bbl: Math.round(open.reduce((s, d) => s + d.remaining_bbl, 0) * 100) / 100,
    },
    open_invoices: all.filter((i) => i.status === "unpaid").sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "")),
    deals,
    other_shipments,
  };
}
