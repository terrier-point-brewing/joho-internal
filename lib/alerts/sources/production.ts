/**
 * Production alerts. Each reads the same tables its screen does, so an item
 * here and a flag on that screen are always the same fact.
 */
import { CAP } from "@/lib/auth/capabilities";
import { loadPartnerLedger } from "@/lib/production/partnerLedger.server";
import { commitmentAttention } from "@/lib/production/ledgerAttention";
import type { AlertItem, AlertSource } from "../types";
import { agedSeverity, bbl, isoDate, one, plural } from "./helpers";

// ── Shipments to reconcile ───────────────────────────────────────────────────
// A taproom sale that charged excise with no cold-storage stock to draw down.
// Same filter as fetchOpenPhantomAlerts (lib/production/phantomExportAlerts.ts),
// without the per-row lot lookups the Export Bay panel needs to resolve one.

const ORIGIN_LABEL: Record<string, string> = {
  draft_swap: "keg swapped onto a tap",
  keg_sale: "keg sold",
  can_sale: "cans sold",
};

export const phantomShipments: AlertSource = {
  key: "shipments-reconcile",
  label: "Shipments to reconcile",
  section: "production",
  href: "/production/export?tab=export_bay",
  requires: CAP.exportRead,
  async load(admin) {
    const { data, error } = await admin
      .from("export_transactions")
      .select("id, quantity, volume_bbl, created_at, phantom_origin, recipes(beer_name)")
      .eq("is_phantom", true)
      .is("alert_acknowledged_at", null)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    type Row = { id: string; quantity: number | null; volume_bbl: number | string | null; created_at: string; phantom_origin: string | null; recipes: { beer_name: string } | { beer_name: string }[] | null };
    return ((data ?? []) as Row[]).map((r) => ({
      key: `phantom:${r.id}`,
      title: `${one(r.recipes)?.beer_name?.trim() ?? "Unknown beer"} — ${ORIGIN_LABEL[r.phantom_origin ?? ""] ?? "taproom sale"} with no stock on hand`,
      detail: `${bbl(r.volume_bbl)} booked against nothing in cold storage. Pick the lot it came from, or dismiss it.`,
      href: "/production/export?tab=export_bay",
      severity: "danger",
      when: isoDate(r.created_at),
    }));
  },
};

// ── Invoices to issue ────────────────────────────────────────────────────────
// Partner shipments still at `invoice_required`. One item per shipment, not per
// line, because an invoice is raised per shipment.

export const invoicesToIssue: AlertSource = {
  key: "invoices-to-issue",
  label: "Invoices to issue",
  section: "production",
  href: "/production/export?tab=shipments",
  requires: CAP.exportRead,
  async load(admin, { today }) {
    const { data, error } = await admin
      .from("export_transactions")
      .select("id, shipment_id, channel, recipient_name, volume_bbl, invoice_id, created_at, recipes(beer_name)")
      .eq("status", "invoice_required")
      .neq("channel", "taproom")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    type Row = { id: string; shipment_id: string | null; channel: string; recipient_name: string | null; volume_bbl: number | string | null; invoice_id: string | null; created_at: string; recipes: { beer_name: string } | { beer_name: string }[] | null };

    const byShipment = new Map<string, { rows: Row[] }>();
    for (const r of (data ?? []) as Row[]) {
      const k = r.shipment_id ?? r.id;
      (byShipment.get(k) ?? byShipment.set(k, { rows: [] }).get(k)!).rows.push(r);
    }

    const items: AlertItem[] = [];
    for (const [shipmentId, { rows }] of byShipment) {
      const first = rows[0];
      const beers = [...new Set(rows.map((r) => one(r.recipes)?.beer_name?.trim()).filter(Boolean))];
      const volume = rows.reduce((s, r) => s + Number(r.volume_bbl ?? 0), 0);
      const drafted = rows.some((r) => r.invoice_id);
      items.push({
        key: `invoice:${shipmentId}`,
        title: `${first.recipient_name ?? first.channel} — ${beers.join(", ") || "shipment"}`,
        detail: `${bbl(volume)} shipped ${isoDate(first.created_at)}. ${drafted ? "A draft invoice exists in Square but has not been sent." : "No invoice has been raised."}`,
        href: "/production/export?tab=shipments",
        severity: agedSeverity(first.created_at, today, 14),
        when: isoDate(first.created_at),
      });
    }
    return items;
  },
};

// ── Partner requests awaiting a decision ─────────────────────────────────────

export const partnerRequests: AlertSource = {
  key: "partner-requests",
  label: "Partner requests awaiting a reply",
  section: "production",
  href: "/production/intake",
  requires: CAP.partnersRead,
  async load(admin, { today }) {
    const { data, error } = await admin
      .from("partner_requests")
      .select("id, kind, volume_bbl, desired_date, created_at, new_beer, contract_brewing_partners(company_name), recipes(beer_name)")
      .eq("status", "submitted")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    type Row = { id: string; kind: "batch" | "claim"; volume_bbl: number | string; desired_date: string | null; created_at: string; new_beer: { name?: string } | null; contract_brewing_partners: { company_name: string } | { company_name: string }[] | null; recipes: { beer_name: string } | { beer_name: string }[] | null };
    return ((data ?? []) as Row[]).map((r) => {
      const beer = one(r.recipes)?.beer_name?.trim() ?? r.new_beer?.name?.trim() ?? "a new beer";
      return {
        key: `partner-request:${r.id}`,
        title: `${one(r.contract_brewing_partners)?.company_name ?? "A partner"} asks for ${r.kind === "batch" ? "a batch of" : "beer from"} ${beer}`,
        detail: `${bbl(r.volume_bbl)}${r.desired_date ? ` wanted by ${r.desired_date}` : ""}. Approve or decline it.`,
        href: "/production/intake",
        severity: agedSeverity(r.created_at, today, 7),
        when: isoDate(r.created_at),
      };
    });
  },
};

// ── Partner deals needing attention ──────────────────────────────────────────
// The ledger's own "needs attention" flags, minus not_invoiced, which the
// Invoices-to-issue group already lists shipment by shipment.

const DANGER_KINDS = new Set(["deposit_uncharged", "deposit_unpaid"]);

export const partnerDeals: AlertSource = {
  key: "partner-deals",
  label: "Partner deals needing attention",
  section: "production",
  href: "/production/export",
  requires: CAP.exportRead,
  async load(admin) {
    const partners = await loadPartnerLedger(admin);
    const items: AlertItem[] = [];
    for (const p of partners) {
      for (const c of p.commitments) {
        const flags = commitmentAttention(c).filter((f) => f.actionable && f.kind !== "not_invoiced");
        if (flags.length === 0) continue;
        items.push({
          key: `deal:${c.id}`,
          title: `${p.company_name} — ${c.recipe_name?.trim() ?? "beer"}: ${flags.map((f) => f.label).join(", ")}`,
          detail: `${bbl(c.booked_bbl)} booked${c.desired_delivery_date ? `, wanted by ${c.desired_delivery_date}` : ""}.`,
          href: `/production/export?commitment=${c.id}`,
          severity: flags.some((f) => DANGER_KINDS.has(f.kind)) ? "danger" : "info",
          when: c.desired_delivery_date,
        });
      }
      if (p.unallocated_uninvoiced_transaction_ids.length > 0) {
        items.push({
          key: `deal-unallocated:${p.partner_id}`,
          title: `${p.company_name} — ${bbl(p.unallocated_bbl)} shipped with no deal behind it`,
          detail: `${plural(p.unallocated_uninvoiced_transaction_ids.length, "shipment line")} not invoiced. Give it a home on the ledger or bill it.`,
          href: "/production/export",
          severity: "info",
        });
      }
    }
    return items;
  },
};

// ── Batches with an incomplete allocation plan ───────────────────────────────
// The Batch Log's "!" dot: an active batch whose allocations plus conversions
// leave part of it unclaimed.

const ACTIVE_BATCH_STATUSES = ["planning", "brewing", "fermenting", "conditioning"];

export const allocationPlans: AlertSource = {
  key: "allocation-plans",
  label: "Batches with an incomplete allocation plan",
  section: "production",
  href: "/production/brewing/batch-log",
  requires: CAP.brewingRead,
  async load(admin) {
    const { data: batches, error } = await admin
      .from("brew_batches")
      .select("id, batch_number, beer_name, volume_bbl, status")
      .in("status", ACTIVE_BATCH_STATUSES)
      .gt("volume_bbl", 0);
    if (error) throw new Error(error.message);
    type Batch = { id: string; batch_number: string | null; beer_name: string | null; volume_bbl: number | string; status: string };
    const rows = (batches ?? []) as Batch[];
    if (rows.length === 0) return [];
    const ids = rows.map((b) => b.id);

    const [{ data: allocs, error: aErr }, { data: convs, error: cErr }] = await Promise.all([
      admin.from("batch_allocations").select("batch_id, percentage").in("batch_id", ids),
      admin.from("batch_conversions").select("source_batch_id, volume_bbl").in("source_batch_id", ids),
    ]);
    if (aErr) throw new Error(aErr.message);
    if (cErr) throw new Error(cErr.message);

    const pct = new Map<string, number>();
    for (const a of (allocs ?? []) as { batch_id: string; percentage: number | string }[]) {
      pct.set(a.batch_id, (pct.get(a.batch_id) ?? 0) + Number(a.percentage ?? 0));
    }
    const volume = new Map(rows.map((b) => [b.id, Number(b.volume_bbl)]));
    for (const c of (convs ?? []) as { source_batch_id: string; volume_bbl: number | string }[]) {
      const v = volume.get(c.source_batch_id) ?? 0;
      if (v > 0) pct.set(c.source_batch_id, (pct.get(c.source_batch_id) ?? 0) + (Number(c.volume_bbl) / v) * 100);
    }

    return rows
      .filter((b) => (pct.get(b.id) ?? 0) < 99.9)
      .map((b) => ({
        key: `allocation:${b.id}`,
        title: `${b.batch_number ?? "Batch"} ${b.beer_name?.trim() ?? ""} — ${(pct.get(b.id) ?? 0).toFixed(0)}% allocated`,
        detail: `${bbl(b.volume_bbl)} ${b.status}. The rest has no channel or partner yet.`,
        href: "/production/brewing/batch-log",
        severity: "info" as const,
      }));
  },
};

export const PRODUCTION_SOURCES: AlertSource[] = [
  phantomShipments,
  invoicesToIssue,
  partnerRequests,
  partnerDeals,
  allocationPlans,
];
