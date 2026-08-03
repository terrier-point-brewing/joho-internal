// lib/production/invoiceInventoryWriteback.ts
//
// Beer that left on an invoice the app never shipped.
//
// The app's own export flow ships first and invoices second, so cold storage is
// already drained by the time the invoice exists. Square then decrements itself
// when that invoice is paid. Each side moves once and they stay in step — which
// is exactly why there is no push on the export path.
//
// The hole is an invoice raised DIRECTLY IN SQUARE against a mapped keg or can
// SKU. Square deducts at payment; the app never hears about it, so cold storage
// keeps counting stock that has gone. Nothing else covers this: the taproom
// consumption sync deliberately excludes invoice orders (correctly — they are
// wholesale, not taproom sales), and writeColdStorageShipment's only callers are
// the two Export Bay routes and taproom consumption.
//
// Currently a guard, not a repair: every invoice in prod carrying beer lines has
// an export transaction behind it, so there is nothing to back-fill. This exists
// so the first one does not go unnoticed.

import type { SupabaseClient } from "@supabase/supabase-js";
import { writeColdStorageShipment } from "./shipmentWriter";
import { INVOICE_WRITEBACK_ENABLED } from "@/lib/square/pushGate";

/** Invoice types the app itself raises. Their stock left via the Export Bay. */
const APP_RAISED_TYPES = new Set(["export_invoice", "allocation_deposit"]);

export interface InvoiceBeerLine {
  invoiceId: string;
  lineItemId: string;
  invoiceType: string | null;
  status: string | null;
  /** True when export_transactions already point at this invoice. */
  hasExportTransactions: boolean;
  squareVariationId: string;
  quantity: number;
  recipeId: string;
  variationId: string;
  partnerId: string | null;
  channel: string | null;
}

export interface WritebackPlanItem {
  invoiceId: string;
  sourceRef: string;
  recipeId: string;
  variationId: string;
  quantity: number;
  channel: string;
  partnerId: string | null;
}

export interface WritebackPlan {
  writes: WritebackPlanItem[];
  skips: { invoiceId: string; reason: string }[];
}

/** Stable per invoice line, so re-running never books the same beer twice. */
export function writebackSourceRef(invoiceId: string, lineItemId: string): string {
  return `sqinvoice:${invoiceId}:${lineItemId}`;
}

/**
 * PURE. Decides which invoice lines represent stock that left without the app
 * knowing.
 *
 * Four things must all hold, and each one is load-bearing:
 *  - the invoice is PAID, because Square only decrements at payment. Draining
 *    cold storage for an unpaid invoice would take stock that is still on the
 *    shelf and may never be sold.
 *  - it has NO export transactions, or the Export Bay already drained it and
 *    this would be the second bite.
 *  - it is not one of the app's own invoice types, which is the same guard from
 *    a different angle — belt and braces, because a shipment row going missing
 *    must not turn into a silent double-depletion.
 *  - the line is not already booked under its own source_ref.
 */
export function planInvoiceWriteback(input: {
  lines: InvoiceBeerLine[];
  alreadyBookedRefs: ReadonlySet<string>;
}): WritebackPlan {
  const plan: WritebackPlan = { writes: [], skips: [] };
  const seenSkip = new Set<string>();
  const skipOnce = (invoiceId: string, reason: string) => {
    const key = `${invoiceId}\t${reason}`;
    if (seenSkip.has(key)) return;
    seenSkip.add(key);
    plan.skips.push({ invoiceId, reason });
  };

  for (const line of input.lines) {
    if (line.status !== "paid") {
      skipOnce(line.invoiceId, `not paid (${line.status ?? "unknown"}) — Square has not decremented yet`);
      continue;
    }
    if (line.hasExportTransactions) {
      skipOnce(line.invoiceId, "already has export transactions — the Export Bay drained this");
      continue;
    }
    if (line.invoiceType && APP_RAISED_TYPES.has(line.invoiceType)) {
      skipOnce(line.invoiceId, `app-raised invoice type (${line.invoiceType}) — its stock left via the Export Bay`);
      continue;
    }
    if (line.quantity <= 0) continue;

    const sourceRef = writebackSourceRef(line.invoiceId, line.lineItemId);
    if (input.alreadyBookedRefs.has(sourceRef)) continue;

    plan.writes.push({
      invoiceId: line.invoiceId,
      sourceRef,
      recipeId: line.recipeId,
      variationId: line.variationId,
      quantity: line.quantity,
      // An invoice raised outside the app carries no channel of its own.
      // Distribution is the honest default for wholesale stock leaving on an
      // invoice, and it is visible on the row for anyone who needs to re-file it.
      channel: line.channel || "distribution",
      partnerId: line.partnerId,
    });
  }

  return plan;
}

export interface WritebackResult extends WritebackPlan {
  applied: number;
  warnings: string[];
  enabled: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient | { from: (t: string) => any };

async function loadCandidateLines(db: Db): Promise<InvoiceBeerLine[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from("invoice_line_items")
    .select(
      "id, invoice_id, quantity, square_catalog_variation_id, " +
      "invoices!inner ( id, status, invoice_type, partner_id, billed_channel, shipped_channel )",
    )
    .not("square_catalog_variation_id", "is", null);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as {
    id: string; invoice_id: string; quantity: number | string;
    square_catalog_variation_id: string;
    invoices: {
      id: string; status: string | null; invoice_type: string | null;
      partner_id: string | null; billed_channel: string | null; shipped_channel: string | null;
    } | null;
  }[];
  if (rows.length === 0) return [];

  // Only variations mapped to a cold-storage keg/can variation are inventory.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: linkRows, error: linkErr } = await (db as any)
    .from("recipe_square_links")
    .select("square_variation_id, recipe_id, variation_id, packaging")
    .in("packaging", ["keg", "can"]);
  if (linkErr) throw new Error(linkErr.message);

  const linkByVar = new Map<string, { recipeId: string; variationId: string }>();
  for (const l of (linkRows ?? []) as { square_variation_id: string; recipe_id: string; variation_id: string | null }[]) {
    if (l.variation_id) linkByVar.set(l.square_variation_id, { recipeId: l.recipe_id, variationId: l.variation_id });
  }

  const invoiceIds = [...new Set(rows.map((r) => r.invoice_id))];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: txRows, error: txErr } = await (db as any)
    .from("export_transactions")
    .select("invoice_id")
    .in("invoice_id", invoiceIds);
  if (txErr) throw new Error(txErr.message);
  const invoicesWithTx = new Set(
    ((txRows ?? []) as { invoice_id: string | null }[]).map((r) => r.invoice_id).filter((x): x is string => !!x),
  );

  const out: InvoiceBeerLine[] = [];
  for (const r of rows) {
    const link = linkByVar.get(r.square_catalog_variation_id);
    if (!link) continue; // a fee, an excise line, merch — not inventory
    out.push({
      invoiceId: r.invoice_id,
      lineItemId: r.id,
      invoiceType: r.invoices?.invoice_type ?? null,
      status: r.invoices?.status ?? null,
      hasExportTransactions: invoicesWithTx.has(r.invoice_id),
      squareVariationId: r.square_catalog_variation_id,
      quantity: Number(r.quantity),
      recipeId: link.recipeId,
      variationId: link.variationId,
      partnerId: r.invoices?.partner_id ?? null,
      channel: r.invoices?.billed_channel ?? r.invoices?.shipped_channel ?? null,
    });
  }
  return out;
}

/**
 * Book cold-storage shipments for invoices that took stock without one.
 *
 * Gated by INVOICE_WRITEBACK_ENABLED. While shut it reports what it would book
 * without touching cold storage — this depletes the app's own inventory, so the
 * first real case should be looked at by a person before it is booked
 * automatically.
 */
export async function writeBackInvoiceInventory(db: Db): Promise<WritebackResult> {
  const warnings: string[] = [];
  const lines = await loadCandidateLines(db);

  const refs = lines.map((l) => writebackSourceRef(l.invoiceId, l.lineItemId));
  const alreadyBookedRefs = new Set<string>();
  if (refs.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from("export_transactions")
      .select("source_ref")
      .in("source_ref", refs);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { source_ref: string }[]) alreadyBookedRefs.add(r.source_ref);
  }

  const plan = planInvoiceWriteback({ lines, alreadyBookedRefs });
  let applied = 0;

  if (INVOICE_WRITEBACK_ENABLED) {
    for (const w of plan.writes) {
      try {
        await writeColdStorageShipment(db as SupabaseClient, {
          channel: w.channel,
          recipeId: w.recipeId,
          variationId: w.variationId,
          quantity: w.quantity,
          recipientId: w.partnerId,
          sourceRef: w.sourceRef,
          notes: `Booked from Square invoice ${w.invoiceId} — no Export Bay shipment recorded it.`,
        });
        applied++;
      } catch (e) {
        warnings.push(`writeback failed for invoice ${w.invoiceId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return { ...plan, applied, warnings, enabled: INVOICE_WRITEBACK_ENABLED };
}
