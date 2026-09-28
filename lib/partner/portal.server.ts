import type { SupabaseClient } from "@supabase/supabase-js";
import { requirePermission, CAP, type Session } from "@/lib/auth";
import { can } from "@/lib/auth/resolve";
import { todayLocalDate } from "@/lib/utils/datetime";
import { getBreweryTimezone } from "@/lib/settings/breweryTimezone.server";
import type { LedgerInvoiceRef, LedgerPartner, LedgerShipment } from "@/lib/production/partnerLedger";
import { loadPackagingYieldPct, projectBatchYield } from "@/lib/production/exportIngredientDeposit";
import type { LedgerTransfer } from "@/lib/production/volumeLedger";
import { getInvoiceStatus } from "@/lib/square/square-invoices";
import { EXCISE_LINE_CATEGORY, excisePerPartner, type ExciseInvoice, type ExciseLine, type PartnerExcise } from "@/lib/production/partnerExcise";
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

/** Under a barrel is a rounding crumb, not an offer worth a partner's attention. */
const MIN_OFFER_BBL = 1;

export interface ClaimableBatch {
  batch_id: string;
  beer_name: string;
  style: string | null;
  abv: number | null;
  ready_by: string | null;
  /** True once the beer is packaged — it is ready now, not an estimate. */
  packaged: boolean;
  claimable_bbl: number;
  /** Of that: packaged and here today. */
  ready_now_bbl: number;
  /** Of that: still in tank — an estimate until it is packaged. */
  in_tank_bbl: number;
  /** Where the batch is, in words a partner can use. No volumes: batch size is not theirs to see. */
  stage: "in_tank" | "packaging" | "packaged";
}

interface BatchRow {
  id: string; beer_name: string | null; volume_bbl: number | null; status: string; expected_delivery_date: string | null;
  recipes: { beer_name: string | null; style: string | null; abv: number | null; partner_id: string | null; contract_brewing_partners: { recipes_exclusive: boolean } | null } | null;
}

/** Claim pools for the given batches (or every open batch), keyed by batch id. */
export async function loadClaimPools(
  admin: SupabaseClient,
  opts: { batchIds?: string[] } = {},
): Promise<Map<string, { batch: BatchRow; pool: ClaimPool; readyBy: string | null; packaged: boolean; producedAny: boolean }>> {
  let q = admin.from("brew_batches")
    .select("id, beer_name, volume_bbl, status, expected_delivery_date, recipes(beer_name, style, abv, partner_id, contract_brewing_partners(recipes_exclusive))")
    .neq("status", "complete");
  if (opts.batchIds) q = q.in("id", opts.batchIds);
  const { data: batchRows } = await q;
  const batches = (batchRows ?? []) as unknown as BatchRow[];
  const ids = batches.map((b) => b.id);
  const out = new Map<string, { batch: BatchRow; pool: ClaimPool; readyBy: string | null; packaged: boolean; producedAny: boolean }>();
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
      batch: b, pool, packaged: producedBbl > 0 && projection.inTankBbl < 0.05, producedAny: producedBbl > 0,
      readyBy: b.expected_delivery_date ?? lastEnd.get(b.id)?.slice(0, 10) ?? null,
    });
  }
  return out;
}

export async function loadClaimableForPartner(admin: SupabaseClient, partnerId: string): Promise<ClaimableBatch[]> {
  const [pools, today] = await Promise.all([loadClaimPools(admin), breweryToday()]);
  const rows: ClaimableBatch[] = [];
  for (const { batch, pool, readyBy, packaged, producedAny } of pools.values()) {
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
      ready_now_bbl: pool.readyNowBbl,
      in_tank_bbl: pool.inTankBbl,
      stage: packaged ? "packaged" : producedAny ? "packaging" : "in_tank",
    });
  }
  return rows.sort((a, b) => (a.ready_by ?? "9999").localeCompare(b.ready_by ?? "9999"));
}

// ── Excise ──────────────────────────────────────────────────────────────────

/** Barrel excise billed to one partner on shipment invoices: charged vs paid. */
export async function loadPartnerExcise(admin: SupabaseClient, partnerId: string): Promise<PartnerExcise> {
  const none: PartnerExcise = { charged_cents: 0, collected_cents: 0, outstanding_cents: 0, invoices: 0 };
  const { data: invoices } = await admin.from("invoices")
    .select("id, partner_id, status").eq("invoice_type", "export_invoice").eq("partner_id", partnerId);
  const rows = (invoices ?? []) as ExciseInvoice[];
  const lines: ExciseLine[] = [];
  // Chunked: an .in() list rides in the URL, and a few hundred uuids overflow it.
  for (let i = 0; i < rows.length; i += 150) {
    const { data } = await admin.from("invoice_line_items")
      .select("invoice_id, total_cents").eq("category", EXCISE_LINE_CATEGORY).in("invoice_id", rows.slice(i, i + 150).map((r) => r.id));
    lines.push(...((data ?? []) as ExciseLine[]));
  }
  return excisePerPartner(rows, lines)[partnerId] ?? none;
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
  /** When Square says it should be paid by. */
  due_date: string | null;
  /** Unpaid and past its due date, by the brewery's calendar. */
  overdue: boolean;
  days_overdue: number;
  /** Square's own hosted invoice page — the link Square emailed them. Null until the invoice is sent. */
  pay_url: string | null;
  /** What the invoice is for, in the partner's terms: "Mash Pit Lager (Lager)". */
  beers: string[];
  /** Beer it covers: shipped bbl for a shipment invoice, booked bbl for a deposit. */
  bbl: number;
}

export interface PortalDeal {
  id: string;
  beer_name: string | null;
  style: string | null;
  status: "open" | "closed" | "cancelled";
  /** What they asked for — whole turns, BEFORE shrinkage. A request, not a promise of volume. */
  booked_bbl: number;
  /** Their share of what the batch has actually packaged so far, capped at the booking. */
  produced_bbl: number;
  /**
   * What the deal will end up delivering: packaged share + share still in tank
   * (or what shipped, if that is more). The honest denominator for "shipped of".
   * Equals the booking only while no batch has been brewed for it yet.
   */
  expected_bbl: number;
  progress: DealProgress;
  /** False until a batch is allocated to the deal — nothing to measure against but the booking. */
  has_batch: boolean;
  shipped_bbl: number;
  remaining_bbl: number;
  in_tank_bbl: number;
  desired_delivery_date: string | null;
  received_on: string | null;
  /** Ingredient deposit, contract brewing only. Null when the deal has none. */
  deposit: {
    billed_cents: number; paid_cents: number; status: PaymentStatus;
    /** The invoice carrying the deposit: its own, or the shipment invoice it was back-charged onto. */
    invoice: PortalInvoice | null;
    billed_on: "own_invoice" | "shipment_invoice" | null;
  } | null;
  /** Every invoice on this deal (deposit, shipments, back-charges) still to be paid — one entry per invoice. */
  unpaid_invoices: PortalInvoice[];
  shipments: Array<{
    /** A return is beer that came back: negative volume, no invoice of its own. */
    kind: "shipment" | "return";
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
    overdue_cents: number;
    open_deals: number;
    to_come_bbl: number;
  };
  /**
   * Beer excise we billed this partner on shipment invoices. It is INSIDE the
   * paid / outstanding figures above, not on top of them — shown separately
   * because it is tax passed through, not a charge for the beer or the brewing.
   */
  excise: PartnerExcise;
  /** Invoices sent and not yet paid, oldest first. */
  open_invoices: PortalInvoice[];
  deals: PortalDeal[];
  /** Beer shipped outside any commitment. */
  other_shipments: PortalDeal["shipments"];
}

const EMPTY_HISTORY: PortalHistory = {
  summary: { shipped_bbl: 0, paid_cents: 0, outstanding_cents: 0, overdue_cents: 0, open_deals: 0, to_come_bbl: 0 },
  excise: { charged_cents: 0, collected_cents: 0, outstanding_cents: 0, invoices: 0 },
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
export interface InvoiceExtras {
  today: string;
  invoices: Map<string, { due_date: string | null; pay_url: string | null }>;
  /** Brew and ready dates of the batch behind each allocation, keyed by allocation id. */
  batches?: Map<string, { planned_brew_date: string | null; expected_delivery_date: string | null }>;
}
const NO_EXTRAS: InvoiceExtras = { today: "0000-00-00", invoices: new Map() };

/** Where a deal's beer is, in six steps a partner can follow. */
export const PROGRESS_STEPS = ["Scheduled", "Brewing", "Fermenting", "Conditioning", "Packaging", "Ready"] as const;
export interface DealProgress {
  /** Index into PROGRESS_STEPS; -1 while no batch has been scheduled for the deal. */
  step: number;
  label: string;
  brew_date: string | null;
  ready_by: string | null;
}

function dealProgress(c: LedgerPartner["commitments"][number], extras: InvoiceExtras): DealProgress {
  if (c.allocations.length === 0) return { step: -1, label: "Awaiting a brew date", brew_date: null, ready_by: null };
  // The batch furthest from done speaks for the deal.
  const order = ["planning", "brewing", "fermenting", "conditioning", "complete"];
  const a = [...c.allocations].sort((x, y) => order.indexOf(x.batch_status) - order.indexOf(y.batch_status))[0];
  const dates = extras.batches?.get(a.id);
  const packagedSome = a.produced_bbl > 0.005;
  const step = a.batch_status === "complete" || (packagedSome && a.in_tank_bbl < 0.05) ? 5
    : packagedSome ? 4
    : Math.max(0, ["planning", "brewing", "fermenting", "conditioning"].indexOf(a.batch_status));
  const label = step === 5 ? (c.totals.remaining_bbl > 0.005 ? "Packaged — ready to ship" : "Packaged and shipped")
    : step === 4 ? "Packaging under way" : step === 0 ? "Scheduled to brew" : PROGRESS_STEPS[step];
  const ready = dates?.expected_delivery_date ?? null;
  return { step, label, brew_date: dates?.planned_brew_date ?? null, ready_by: step < 5 && ready && ready >= extras.today ? ready : null };
}

/**
 * Due dates and Square pay links for a partner's invoices. The link is kept in
 * invoices.raw_data.public_url by the payment sync; an open invoice that
 * pre-dates that gets it from Square once, here, and is remembered.
 */
export async function loadInvoiceExtras(admin: SupabaseClient, partnerId: string, today: string): Promise<InvoiceExtras> {
  const { data } = await admin.from("invoices")
    .select("id, status, due_date, square_invoice_id, raw_data")
    .eq("partner_id", partnerId).in("invoice_type", ["allocation_deposit", "export_invoice"]);
  const invoices = new Map<string, { due_date: string | null; pay_url: string | null }>();
  for (const row of (data ?? []) as Array<{ id: string; status: string; due_date: string | null; square_invoice_id: string | null; raw_data: Record<string, unknown> | null }>) {
    let payUrl = typeof row.raw_data?.public_url === "string" ? row.raw_data.public_url : null;
    if (!payUrl && row.status === "open" && row.square_invoice_id) {
      try {
        payUrl = (await getInvoiceStatus(row.square_invoice_id)).publicUrl;
        if (payUrl) await admin.from("invoices").update({ raw_data: { ...(row.raw_data ?? {}), public_url: payUrl } }).eq("id", row.id);
      } catch { /* Square unreachable: the row still shows, just without a link */ }
    }
    invoices.set(row.id, { due_date: row.due_date, pay_url: payUrl });
  }
  const { data: allocs } = await admin.from("batch_allocations")
    .select("id, brew_batches(planned_brew_date, expected_delivery_date)").eq("partner_id", partnerId);
  const batches = new Map<string, { planned_brew_date: string | null; expected_delivery_date: string | null }>();
  for (const a of (allocs ?? []) as unknown as Array<{ id: string; brew_batches: { planned_brew_date: string | null; expected_delivery_date: string | null } | null }>) {
    if (a.brew_batches) batches.set(a.id, a.brew_batches);
  }
  return { today, invoices, batches };
}

/**
 * One drop, one row. The ledger keeps a shipment's rows apart by how they were
 * credited (a 21-case drop that outran the deal's share at ship time is a
 * 19.6-case row and a 1.4-case one). The partner took 21 cases: rows with the
 * same shipment id become one shipment, and lines with the same label one line.
 */
export function mergeShipments(rows: LedgerShipment[]): LedgerShipment[] {
  const byKey = new Map<string, LedgerShipment>();
  for (const s of rows) {
    const key = s.shipment_id ?? `row:${s.transaction_ids.join(",") || s.date}`;
    const have = byKey.get(key);
    if (!have) { byKey.set(key, { ...s, lines: s.lines.map((l) => ({ ...l })) }); continue; }
    have.date = s.date < have.date ? s.date : have.date;
    have.volume_bbl = Math.round((have.volume_bbl + s.volume_bbl) * 100) / 100;
    have.transaction_ids = [...have.transaction_ids, ...s.transaction_ids];
    have.invoice = have.invoice ?? s.invoice;
    have.lines = [...have.lines, ...s.lines];
  }
  for (const s of byKey.values()) {
    const byLabel = new Map<string, LedgerShipment["lines"][number]>();
    for (const l of s.lines) {
      const have = byLabel.get(l.variant_label ?? "");
      if (!have) { byLabel.set(l.variant_label ?? "", { ...l }); continue; }
      have.quantity += l.quantity;
      have.volume_bbl = Math.round((have.volume_bbl + l.volume_bbl) * 100) / 100;
      have.over_allocation = have.over_allocation || l.over_allocation;
      have.is_ad_hoc = have.is_ad_hoc || l.is_ad_hoc;
      have.shipped_before_deposit = have.shipped_before_deposit || l.shipped_before_deposit;
    }
    // A split row leaves 19.5999 + 1.4001 behind; the partner shipped 21.
    s.lines = [...byLabel.values()].map((l) => ({ ...l, quantity: Math.round(l.quantity * 100) / 100 }));
  }
  // The ledger already orders its rows; keep that order.
  return [...byKey.values()];
}

export function toPortalHistory(ledger: LedgerPartner | undefined, excise: PartnerExcise = EMPTY_HISTORY.excise, extras: InvoiceExtras = NO_EXTRAS): PortalHistory {
  if (!ledger) return { ...EMPTY_HISTORY, excise };

  const invoices = new Map<string, PortalInvoice>();
  const note = (ref: LedgerInvoiceRef | null | undefined, kind: PortalInvoice["kind"]): PortalInvoice | null => {
    if (!ref || ref.status === "voided") return null;
    const inv: PortalInvoice = {
      id: ref.id, number: ref.invoice_number, date: ref.invoice_date, kind,
      status: ref.status === "paid" ? "paid" : "unpaid", total_cents: ref.total_cents, beers: [], bbl: 0,
      due_date: null, overdue: false, days_overdue: 0, pay_url: null,
    };
    const extra = extras.invoices.get(ref.id);
    if (extra) {
      inv.due_date = extra.due_date;
      inv.pay_url = extra.pay_url;
      if (inv.status === "unpaid" && extra.due_date && extra.due_date < extras.today) {
        inv.overdue = true;
        inv.days_overdue = Math.round((Date.parse(`${extras.today}T00:00:00Z`) - Date.parse(`${extra.due_date}T00:00:00Z`)) / 86_400_000);
      }
    }
    if (!invoices.has(inv.id)) invoices.set(inv.id, inv);
    return invoices.get(inv.id)!;
  };
  /** Say what an invoice covers: which beer, and how much of it. */
  const covers = (inv: PortalInvoice | null, beer: string | null, bblCovered: number) => {
    if (!inv) return;
    if (beer && !inv.beers.includes(beer)) inv.beers.push(beer);
    inv.bbl = Math.round((inv.bbl + bblCovered) * 100) / 100;
  };
  const beerLabel = (name: string | null, style: string | null | undefined) =>
    name ? (style && !name.toLowerCase().includes(style.toLowerCase()) ? `${name.trim()} (${style})` : name.trim()) : null;

  // A shipment entered wrong and later corrected leaves two rows behind when it
  // sat in a filed excise period: the original, and a negative mirror that
  // cancels it. Neither ever happened as far as the partner is concerned — the
  // corrected shipment is its own, separate row. Drop both.
  const everyShipment = [...ledger.commitments.flatMap((c) => c.shipments), ...ledger.unallocated];
  const erased = new Set(everyShipment.map((s) => s.reverses_shipment_id).filter((id): id is string => !!id));
  const real = (s: LedgerPartner["unallocated"][number]) =>
    !s.reverses_shipment_id && s.kind !== "revision" && s.kind !== "reversal" && !(s.shipment_id && erased.has(s.shipment_id));

  const shipmentsOf = (rows: LedgerPartner["unallocated"], beer: string | null): PortalDeal["shipments"] =>
    mergeShipments(rows.filter(real)).map((s) => {
      const isReturn = s.kind === "refund";
      const invoice = isReturn ? null : note(s.invoice, "shipment");
      if (!isReturn) covers(invoice, beer, s.volume_bbl);
      return {
        kind: isReturn ? "return" as const : "shipment" as const,
        date: s.date, volume_bbl: s.volume_bbl,
        lines: s.lines.map((l) => ({ label: l.variant_label, quantity: l.quantity })),
        payment: !invoice ? "not_invoiced" : invoice.status,
        invoice,
      };
    });

  // Beer that reached this partner from a batch they have a deal on, but was
  // not credited to that deal — an over-delivery beyond their share of what
  // had packaged at ship time, or an ad-hoc drop. The partner received it and
  // is billed for it; to them it is simply part of that batch's shipments, so
  // it is folded into the deal here (and its rows merged back into the
  // shipment they were split from). Only beer from a batch they hold no deal
  // on is "other". Staff still see the over-delivery flag on the ledger.
  const stageOf = new Map(ledger.commitments.map((c) => [c.id, c.stage]));
  const dealForBatch = (batchId: string | null): string | null => {
    const targets = batchId ? (ledger.allocations_by_batch?.[batchId] ?? []) : [];
    const open = targets.find((t) => stageOf.get(t.commitment_id) === "open");
    return (open ?? targets[0])?.commitment_id ?? null;
  };
  const folded = new Map<string, LedgerPartner["unallocated"]>();
  const strays: LedgerPartner["unallocated"] = [];
  for (const s of ledger.unallocated) {
    const dealId = dealForBatch(s.batch_id);
    if (dealId) (folded.get(dealId) ?? folded.set(dealId, []).get(dealId)!).push(s);
    else strays.push(s);
  }

  let looseDepositPaid = 0;
  let refunded = 0;
  const deals: PortalDeal[] = ledger.commitments.map((c) => {
    const beer = beerLabel(c.recipe_name, c.recipe_style);
    for (const ref of c.export_invoices) note(ref, "shipment");
    let depositStatus: PaymentStatus = "not_invoiced";
    let depositInvoice: PortalInvoice | null = null;
    const backcharges: PortalInvoice[] = [];
    for (const a of c.allocations) {
      for (const ref of a.deposit.backcharge_invoices) {
        const inv = note(ref, "shipment");
        if (inv) backcharges.push(inv);
      }
      refunded += a.deposit.refunded_cents;
      const sentOrPaid = a.deposit.invoice && (a.deposit.sent_at || a.deposit.invoice.status === "paid");
      if (sentOrPaid) {
        const inv = note(a.deposit.invoice, "deposit");
        covers(inv, beer,
          // Before anything is packaged nothing is "owed" yet; the deposit is for the booked share of the planned batch.
          a.owed_bbl > 0 ? a.owed_bbl : (a.percentage / 100) * a.batch_planned_bbl);
        // The one still to pay is the one worth a link; otherwise any of them.
        if (inv && (!depositInvoice || inv.status === "unpaid")) depositInvoice = inv;
      }
      // Marked paid from QuickBooks: money received with no invoice row to carry it.
      else if (!a.deposit.invoice && a.deposit.paid_cents > 0) looseDepositPaid += a.deposit.paid_cents;
    }
    if (c.channel === "contract_brewing") {
      const billed = c.totals.deposit_billed_cents, paid = c.totals.deposit_paid_cents;
      depositStatus = billed <= 0 && paid <= 0 ? "not_invoiced" : paid >= billed ? "paid" : "unpaid";
    }
    // A deposit not paid up front rides as a line on the first shipment
    // invoice. Point the partner at that invoice rather than at nothing.
    const depositBackcharge = backcharges.find((i) => i.status === "unpaid") ?? backcharges[0] ?? null;
    const depositBilledOn = depositInvoice ? "own_invoice" as const : depositBackcharge ? "shipment_invoice" as const : null;
    const extra = folded.get(c.id) ?? [];
    const shipments = shipmentsOf([...c.shipments, ...extra], beer);
    const extraBbl = extra.filter(real).reduce((s, x) => s + x.volume_bbl, 0);
    const shipped = Math.round((c.totals.shipped_bbl + extraBbl) * 100) / 100;
    // One entry per invoice, however many shipments it bills.
    const unpaid = new Map<string, PortalInvoice>();
    for (const inv of [...shipments.map((s) => s.invoice), depositInvoice, ...backcharges]) {
      if (inv && inv.status === "unpaid") unpaid.set(inv.id, inv);
    }
    return {
      id: c.id,
      beer_name: c.recipe_name,
      style: c.recipe_style ?? null,
      status: c.stage,
      booked_bbl: c.booked_bbl,
      produced_bbl: c.totals.owed_bbl,
      // The staff ledger's scale (PartnerLedgerTab DeliveryCell), on purpose:
      // owed is capped at what the batch produced, so measuring against the
      // booking would leave a fully delivered deal looking short forever.
      expected_bbl: c.allocations.length === 0 ? c.booked_bbl
        : Math.round(Math.max(shipped, c.totals.owed_bbl + (c.stage === "open" ? c.totals.in_tank_bbl : 0)) * 100) / 100,
      has_batch: c.allocations.length > 0,
      progress: dealProgress(c, extras),
      shipped_bbl: shipped,
      remaining_bbl: Math.round(Math.max(0, c.totals.remaining_bbl - extraBbl) * 100) / 100,
      in_tank_bbl: c.totals.in_tank_bbl,
      desired_delivery_date: c.desired_delivery_date,
      received_on: c.received_on,
      deposit: c.channel === "contract_brewing"
        ? { billed_cents: c.totals.deposit_billed_cents, paid_cents: c.totals.deposit_paid_cents - c.totals.deposit_refunded_cents, status: depositStatus, invoice: depositInvoice ?? depositBackcharge, billed_on: depositBilledOn }
        : null,
      shipments,
      unpaid_invoices: [...unpaid.values()].sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.due_date ?? a.date ?? "").localeCompare(b.due_date ?? b.date ?? "")),
    };
  });
  // Open deals first, in the order they will land: beer that is packaged
  // and ready, then batches by the date they should be ready, then deals
  // still waiting for a brew date. Closed deals after, newest first.
  const rank = { open: 0, closed: 1, cancelled: 2 } as const;
  const landing = (d: PortalDeal) => d.progress.step === 5 ? "0" : d.progress.step < 0 ? "9" : `5${d.progress.ready_by ?? "9999-99-99"}`;
  deals.sort((a, b) => rank[a.status] - rank[b.status]
    || (a.status === "open" ? landing(a).localeCompare(landing(b)) : 0)
    || (b.received_on ?? "").localeCompare(a.received_on ?? ""));

  const other_shipments = shipmentsOf(strays, null);
  const all = [...invoices.values()];
  const open = deals.filter((d) => d.status === "open");
  return {
    summary: {
      shipped_bbl: Math.round((deals.reduce((s, d) => s + d.shipped_bbl, 0) + other_shipments.reduce((s, x) => s + x.volume_bbl, 0)) * 100) / 100,
      paid_cents: Math.max(0, all.filter((i) => i.status === "paid").reduce((s, i) => s + i.total_cents, 0) + looseDepositPaid - refunded),
      outstanding_cents: all.filter((i) => i.status === "unpaid").reduce((s, i) => s + i.total_cents, 0),
      overdue_cents: all.filter((i) => i.overdue).reduce((s, i) => s + i.total_cents, 0),
      open_deals: open.length,
      // Packaged and waiting, plus the share still in tank.
      to_come_bbl: Math.round(open.reduce((s, d) => s + Math.max(0, d.expected_bbl - d.shipped_bbl), 0) * 100) / 100,
    },
    excise,
    open_invoices: all.filter((i) => i.status === "unpaid")
      .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.due_date ?? a.date ?? "").localeCompare(b.due_date ?? b.date ?? "")),
    deals,
    other_shipments,
  };
}
