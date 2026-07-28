/**
 * One-time repair for the sales-tax-as-revenue bug, plus the two invoice-side
 * defects found alongside it. Dry-run by default at the route.
 *
 * Steps 2 and 3 are ordered (3 needs the key 2 repairs); 1 and 4 are
 * independent. The pure planners are exported for tests -- the driver is thin
 * I/O around them.
 *
 * NEVER run against prod from an agent. The orchestrator runs it after a backup.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";

const UPDATE_CHUNK = 50;

export interface BackfillSalesTaxReport {
  dryRun: boolean;
  posNetSales: { scanned: number; corrected: number; skippedIdentityMismatch: number; centsRemoved: number; byMonth: Record<string, number> };
  invoiceUids: { invoicesScanned: number; rowsRepaired: number; invoicesSkipped: string[] };
  invoiceTaxes: { invoicesScanned: number; rowsWritten: number; centsWritten: number };
  invoiceTotals: { scanned: number; corrected: number };
  errors: string[];
}

// ── Step 1: pos_line_items.net_sales_cents ─────────────────────────────────

export interface PosRowForFix {
  id: string;
  gross_sales_cents: number;
  discount_cents: number;
  tax_cents: number;
  net_sales_cents: number;
  month: string;
}

/**
 * Pure. net_sales_cents must become gross - discount. A row already equal to
 * that is skipped (idempotent re-runs). A row that satisfies NEITHER
 * `net == gross - discount` nor `net == gross - discount + tax` is refused
 * rather than guessed at -- the correction is only provably safe where the
 * identity holds.
 */
export function planPosNetSalesFix(rows: PosRowForFix[]) {
  const updates: { id: string; net_sales_cents: number }[] = [];
  const byMonth: Record<string, number> = {};
  let centsRemoved = 0;
  let skippedIdentityMismatch = 0;

  for (const r of rows) {
    const target = r.gross_sales_cents - r.discount_cents;
    if (r.net_sales_cents === target) continue;
    if (r.net_sales_cents !== target + r.tax_cents) { skippedIdentityMismatch++; continue; }
    updates.push({ id: r.id, net_sales_cents: target });
    centsRemoved += r.tax_cents;
    byMonth[r.month] = (byMonth[r.month] ?? 0) + r.tax_cents;
  }

  return { updates, byMonth, centsRemoved, skippedIdentityMismatch };
}

// ── Step 2: invoice_line_items.square_line_item_uid ────────────────────────

export interface RawLine {
  uid?: string;
  name?: string;
  gross_sales_money?: { amount?: number };
  total_discount_money?: { amount?: number };
  total_tax_money?: { amount?: number };
}

export interface InvoiceRowForRepair {
  id: string;
  sort_order: number;
  gross_sales_cents: number;
  discount_cents: number;
  tax_cents: number;
  square_line_item_uid: string | null;
}

/**
 * Pure. Replays buildInvoiceLineItemRows' iteration -- carve-out excise lines
 * are skipped WITHOUT advancing sort_order -- to map each persisted row's
 * sort_order back to its Square line uid.
 *
 * Every mapping is verified against the row's (gross, discount, tax) triple.
 * A single mismatch fails the whole invoice (`ok: false`), because a wrong uid
 * would attach tax to the wrong line and corrupt the NC DOR taxable base.
 */
export function planInvoiceUidRepair(
  rawLines: RawLine[],
  carveOutAmounts: number[],
  rows: InvoiceRowForRepair[],
): { ok: boolean; updates: { id: string; square_line_item_uid: string }[]; uidByRowId: Record<string, string> } {
  const remaining = [...carveOutAmounts];
  const orderedLines: RawLine[] = [];
  for (const li of rawLines) {
    const gross = li.gross_sales_money?.amount ?? 0;
    if ((li.name ?? "").toLowerCase().includes("barrel excise tax")) {
      const idx = remaining.findIndex((a) => Math.abs(a - gross) <= 1);
      if (idx >= 0) { remaining.splice(idx, 1); continue; }
    }
    orderedLines.push(li);
  }

  const updates: { id: string; square_line_item_uid: string }[] = [];
  const uidByRowId: Record<string, string> = {};

  for (const row of rows) {
    const li = orderedLines[row.sort_order];
    if (!li?.uid) return { ok: false, updates: [], uidByRowId: {} };
    const matches =
      (li.gross_sales_money?.amount ?? 0) === row.gross_sales_cents &&
      (li.total_discount_money?.amount ?? 0) === row.discount_cents &&
      (li.total_tax_money?.amount ?? 0) === row.tax_cents;
    if (!matches) return { ok: false, updates: [], uidByRowId: {} };
    uidByRowId[row.id] = li.uid;
    if (row.square_line_item_uid !== li.uid) updates.push({ id: row.id, square_line_item_uid: li.uid });
  }

  return { ok: true, updates, uidByRowId };
}

// ── Driver ─────────────────────────────────────────────────────────────────

/**
 * Per-row updates in bounded-concurrency chunks. NOT generic: rest-destructuring
 * a type parameter is a TypeScript error (TS2700 "Rest types may only be created
 * from object types"), so the parameter is a concrete object type.
 */
async function applyUpdates(
  sb: SupabaseClient,
  table: string,
  updates: Array<Record<string, unknown> & { id: string }>,
  errors: string[],
): Promise<void> {
  for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
    const chunk = updates.slice(i, i + UPDATE_CHUNK);
    const results = await Promise.all(
      chunk.map(({ id, ...patch }) => sb.from(table).update(patch).eq("id", id)),
    );
    for (const { error } of results) if (error) errors.push(`${table}: ${error.message}`);
  }
}

export async function backfillSalesTax(
  sb: SupabaseClient,
  opts: { dryRun: boolean },
): Promise<BackfillSalesTaxReport> {
  const { dryRun } = opts;
  const errors: string[] = [];

  // ── Step 1 ──
  const posRaw = await fetchAllRows<{
    id: string; gross_sales_cents: number | null; discount_cents: number | null;
    tax_cents: number | null; net_sales_cents: number | null;
    square_orders: { transaction_date: string } | { transaction_date: string }[] | null;
  }>(() =>
    sb.from("pos_line_items")
      .select("id, gross_sales_cents, discount_cents, tax_cents, net_sales_cents, square_orders!inner ( transaction_date )")
      .order("id", { ascending: true }),
  );
  const posRows: PosRowForFix[] = posRaw.map((r) => {
    const so = Array.isArray(r.square_orders) ? r.square_orders[0] : r.square_orders;
    return {
      id: r.id,
      gross_sales_cents: r.gross_sales_cents ?? 0,
      discount_cents: r.discount_cents ?? 0,
      tax_cents: r.tax_cents ?? 0,
      net_sales_cents: r.net_sales_cents ?? 0,
      month: (so?.transaction_date ?? "").slice(0, 7),
    };
  });
  const posPlan = planPosNetSalesFix(posRows);
  if (!dryRun) await applyUpdates(sb, "pos_line_items", posPlan.updates, errors);

  // ── Steps 2 + 3 ──
  const orders = await fetchAllRows<{ invoice_id: string | null; raw_data: { line_items?: RawLine[]; discounts?: { name?: string; applied_money?: { amount?: number } }[]; taxes?: { uid?: string; catalog_object_id?: string; name?: string; percentage?: string }[] } }>(() =>
    sb.from("square_orders").select("invoice_id, raw_data").not("invoice_id", "is", null).order("id", { ascending: true }),
  );

  const invoiceUids = { invoicesScanned: 0, rowsRepaired: 0, invoicesSkipped: [] as string[] };
  const invoiceTaxes = { invoicesScanned: 0, rowsWritten: 0, centsWritten: 0 };

  for (const o of orders) {
    if (!o.invoice_id) continue;
    invoiceUids.invoicesScanned++;

    const rows = await fetchAllRows<InvoiceRowForRepair>(() =>
      sb.from("invoice_line_items")
        .select("id, sort_order, gross_sales_cents, discount_cents, tax_cents, square_line_item_uid")
        .eq("invoice_id", o.invoice_id)
        .order("sort_order", { ascending: true }),
    );
    if (rows.length === 0) continue;

    const carveOuts = (o.raw_data?.discounts ?? [])
      .filter((d) => (d.name ?? "").toLowerCase().includes("carve out"))
      .map((d) => d.applied_money?.amount ?? 0)
      .filter((a) => a > 0);

    const repair = planInvoiceUidRepair(o.raw_data?.line_items ?? [], carveOuts, rows);
    if (!repair.ok) { invoiceUids.invoicesSkipped.push(o.invoice_id); continue; }

    invoiceUids.rowsRepaired += repair.updates.length;
    if (!dryRun) await applyUpdates(sb, "invoice_line_items", repair.updates, errors);

    // ── Step 3: taxes, keyed off the now-correct uid ──
    const taxByUid = new Map((o.raw_data?.taxes ?? []).map((t) => [t.uid, t]));
    const rowIdByUid = new Map(Object.entries(repair.uidByRowId).map(([rowId, uid]) => [uid, rowId]));
    const taxRows: { line_item_id: string; square_tax_id: string; tax_name: string | null; tax_pct: number | null; amount_cents: number }[] = [];
    for (const li of o.raw_data?.line_items ?? []) {
      const rowId = li.uid ? rowIdByUid.get(li.uid) : undefined;
      if (!rowId) continue;
      for (const at of (li as RawLine & { applied_taxes?: { tax_uid?: string; applied_money?: { amount?: number } }[] }).applied_taxes ?? []) {
        const tax = at.tax_uid ? taxByUid.get(at.tax_uid) : undefined;
        if (!tax) continue;
        taxRows.push({
          line_item_id: rowId,
          square_tax_id: tax.catalog_object_id ?? tax.uid ?? "",
          tax_name: tax.name ?? null,
          tax_pct: tax.percentage != null ? parseFloat(tax.percentage) : null,
          amount_cents: at.applied_money?.amount ?? 0,
        });
      }
    }
    if (taxRows.length > 0) {
      invoiceTaxes.invoicesScanned++;
      invoiceTaxes.rowsWritten += taxRows.length;
      invoiceTaxes.centsWritten += taxRows.reduce((s, t) => s + t.amount_cents, 0);
      if (!dryRun) {
        await sb.from("invoice_line_item_taxes").delete().in("line_item_id", rows.map((r) => r.id));
        const { error } = await sb.from("invoice_line_item_taxes").insert(taxRows);
        if (error) errors.push(`invoice_line_item_taxes (${o.invoice_id}): ${error.message}`);
      }
    }
  }

  // ── Step 4: invoice_line_items.total_cents ──
  const invRows = await fetchAllRows<{ id: string; gross_sales_cents: number | null; discount_cents: number | null; net_sales_cents: number | null; total_cents: number | null }>(() =>
    sb.from("invoice_line_items")
      .select("id, gross_sales_cents, discount_cents, net_sales_cents, total_cents")
      .not("net_sales_cents", "is", null)
      .order("id", { ascending: true }),
  );
  const totalUpdates = invRows
    .filter((r) => r.total_cents !== (r.gross_sales_cents ?? 0) - (r.discount_cents ?? 0))
    .map((r) => ({ id: r.id, total_cents: (r.gross_sales_cents ?? 0) - (r.discount_cents ?? 0) }));
  if (!dryRun) await applyUpdates(sb, "invoice_line_items", totalUpdates, errors);

  return {
    dryRun,
    posNetSales: {
      scanned: posRows.length,
      corrected: posPlan.updates.length,
      skippedIdentityMismatch: posPlan.skippedIdentityMismatch,
      centsRemoved: posPlan.centsRemoved,
      byMonth: posPlan.byMonth,
    },
    invoiceUids,
    invoiceTaxes,
    invoiceTotals: { scanned: invRows.length, corrected: totalUpdates.length },
    errors,
  };
}
