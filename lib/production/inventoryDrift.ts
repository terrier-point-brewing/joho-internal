// lib/production/inventoryDrift.ts
//
// Where do Square and cold storage disagree, and by how much?
//
// This is the measurement that the taproom Inventory tab renders. It is the only
// place the two systems are compared side by side; before it existed, drift was
// invisible unless someone ran SQL by hand, which is how a stale mapping went
// nine days without anyone noticing.
//
// Read-only. Nothing here writes to Square or to cold storage.

import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcileSquareCanInventory, type FamilyMeasurement } from "./reconcileSquareCanInventory";
import { measureKegDrift, type KegMeasurement, type KegUnmeasured } from "./kegDrift";
import { loadKegLinks } from "./kegLinks";
import { fetchColdStorageOnHand } from "./coldStorageOnHand";
import { fetchCurrentCounts } from "@/lib/square/inventory";
import { findDeadLinks, type DeadLink } from "@/lib/square/linkHealth";
import { loadPendingDeductionHolds, loadCommittedBySquareSku, type PendingHold } from "./pendingSquareDeduction";

/** A mapping problem the last consumption sync ran into, as recorded in cron_runs. */
export interface SyncDiscrepancySummary {
  kind: string;
  detail: string;
}

export interface InventoryDrift {
  cans: FamilyMeasurement[];
  kegs: KegMeasurement[];
  /** Mappings pointed at a variation that is not live in Square. */
  deadLinks: DeadLink[];
  /** Comparable in principle, but one side could not be read this run. */
  unmeasured: (KegUnmeasured | { recipeId: string; reason: string })[];
  /** Mapping-shaped findings from the most recent consumption sync. */
  syncFindings: { at: string | null; items: SyncDiscrepancySummary[] };
  /**
   * Recipes with stock shipped but not yet deducted by Square's own invoice.
   * Their variance is expected and temporary, so it is labelled rather than
   * counted as drift — Square is legitimately still holding those units.
   */
  pendingDeductionRecipeIds: string[];
  /**
   * The same recipes, with WHY each is held — so the view can distinguish a
   * recipe waiting on a customer's payment from one waiting on an invoice
   * nobody has raised yet. Square commits an invoice's units when it is raised
   * and only deducts them at payment, so both are legitimate holds, but only one
   * of them is the operator's to clear.
   */
  pendingDeductionHolds: PendingHold[];
  /** Invoice id → number, for every invoice named by a hold above. */
  invoiceNumbers: Record<string, string>;
  warnings: string[];
  /** Beer names for every recipe referenced above, so the UI needs no second call. */
  recipeNames: Record<string, string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient | { from: (t: string) => any };

async function loadRecipeNames(db: Db, recipeIds: string[]): Promise<Record<string, string>> {
  if (recipeIds.length === 0) return {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from("recipes")
    .select("id, beer_name")
    .in("id", [...new Set(recipeIds)]);
  if (error) throw new Error(error.message);
  const out: Record<string, string> = {};
  for (const r of (data ?? []) as { id: string; beer_name: string | null }[]) {
    out[r.id] = r.beer_name ?? "";
  }
  return out;
}

/** Invoice id → its human number, so a hold can name the invoice to chase. */
async function loadInvoiceNumbers(db: Db, invoiceIds: string[]): Promise<Record<string, string>> {
  if (invoiceIds.length === 0) return {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from("invoices")
    .select("id, invoice_number")
    .in("id", [...new Set(invoiceIds)]);
  if (error) throw new Error(error.message);
  const out: Record<string, string> = {};
  for (const r of (data ?? []) as { id: string; invoice_number: string | null }[]) {
    if (r.invoice_number) out[r.id] = r.invoice_number;
  }
  return out;
}

/** Discrepancy kinds that mean "a mapping is wrong", as opposed to operational noise. */
const MAPPING_KINDS = new Set([
  "unmapped_sale",
  "link_missing_cold_storage_variation",
  "unmapped_restock",
  "unconfigured_draft_swap",
]);

/** PURE: turn a run's raw discrepancy list into one readable line each. */
export function summariseSyncDiscrepancies(
  discrepancies: Record<string, unknown>[],
): SyncDiscrepancySummary[] {
  const out: SyncDiscrepancySummary[] = [];
  for (const d of discrepancies) {
    const kind = String(d.kind ?? "");
    if (!MAPPING_KINDS.has(kind)) continue;
    switch (kind) {
      case "unmapped_sale":
        out.push({
          kind,
          detail: `${d.quantity} sold on Square variation ${d.squareVariationId} with no mapping to book it against`,
        });
        break;
      case "link_missing_cold_storage_variation":
        out.push({
          kind,
          detail: `${d.beerName || d.recipeId} · ${d.variationName || "?"} is linked to Square but has no cold-storage variation`,
        });
        break;
      case "unmapped_restock":
        out.push({
          kind,
          detail: `${d.count} restock ring(s) on variation ${d.squareVariationId}, which maps to no tap`,
        });
        break;
      case "unconfigured_draft_swap":
        out.push({
          kind,
          detail: `${d.beerName || d.recipeId}: ${d.swapCount} keg swap(s) with no swap keg configured`,
        });
        break;
    }
  }
  return out;
}

async function loadSyncFindings(db: Db): Promise<InventoryDrift["syncFindings"]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from("cron_runs")
    .select("started_at, detail")
    .eq("job", "taproom-consumption-sync")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);

  const run = (data ?? [])[0] as { started_at: string; detail: Record<string, unknown> | null } | undefined;
  if (!run) return { at: null, items: [] };

  const raw = (run.detail?.discrepancies ?? []) as Record<string, unknown>[];
  return { at: run.started_at, items: summariseSyncDiscrepancies(raw) };
}

export async function measureInventoryDrift(db: Db): Promise<InventoryDrift> {
  const warnings: string[] = [];

  // Cans reuse the reconciler's family/tier resolution rather than reimplementing
  // it. Safe to call for a read: the push is observe-only, so it measures and
  // plans without mutating Square. See PUSH_TO_SQUARE_ENABLED.
  let cans: FamilyMeasurement[] = [];
  try {
    const plan = await reconcileSquareCanInventory(db);
    cans = plan.measurements;
    warnings.push(...plan.warnings);
  } catch (e) {
    warnings.push(`can drift unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Kegs: one cold-storage row against one Square count, no tiers involved.
  let kegs: KegMeasurement[] = [];
  let kegUnmeasured: KegUnmeasured[] = [];
  try {
    const links = await loadKegLinks(db);
    if (links.length > 0) {
      const [coldStorage, counts] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchColdStorageOnHand(db as any),
        fetchCurrentCounts(links.map((l) => l.squareVariationId)),
      ]);
      const squareCountByVar: Record<string, number> = {};
      for (const [id, qty] of counts) squareCountByVar[id] = qty;

      // Same compensation the push applies, or the view would report the
      // committed units the push deliberately added as fresh drift.
      let committedByVar: Record<string, number> = {};
      try {
        for (const [sku, units] of await loadCommittedBySquareSku()) committedByVar[sku] = units;
      } catch (e) {
        warnings.push(`committed stock unreadable: ${e instanceof Error ? e.message : String(e)}`);
        committedByVar = {};
      }

      const res = measureKegDrift({ links, coldStorage, squareCountByVar, committedByVar });
      kegs = res.measurements;
      kegUnmeasured = res.unmeasured;
    }
  } catch (e) {
    warnings.push(`keg drift unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }

  let deadLinks: DeadLink[] = [];
  try {
    deadLinks = await findDeadLinks(db);
  } catch (e) {
    warnings.push(`link health unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Sales that could not be booked are found by the consumption sync, not here —
  // detecting them needs a Square order search, which this read has no business
  // repeating. The sync already records them in cron_runs.detail, so they are
  // read back from there rather than recomputed.
  let syncFindings: InventoryDrift["syncFindings"] = { at: null, items: [] };
  try {
    syncFindings = await loadSyncFindings(db);
  } catch (e) {
    warnings.push(`sync findings unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }

  let pendingDeductionHolds: PendingHold[] = [];
  try {
    pendingDeductionHolds = await loadPendingDeductionHolds(db);
  } catch (e) {
    warnings.push(`pending-deduction check unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }

  const recipeNames = await loadRecipeNames(db, [
    ...cans.map((c) => c.recipeId),
    ...kegs.map((k) => k.recipeId),
    ...deadLinks.map((d) => d.recipeId),
    ...kegUnmeasured.map((u) => u.recipeId),
    ...pendingDeductionHolds.map((h) => h.recipeId),
  ]);

  // Best-effort: a hold is still worth showing without its invoice number.
  let invoiceNumbers: Record<string, string> = {};
  try {
    invoiceNumbers = await loadInvoiceNumbers(db, pendingDeductionHolds.flatMap((h) => h.invoiceIds));
  } catch (e) {
    warnings.push(`invoice numbers unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    cans, kegs, deadLinks, unmeasured: kegUnmeasured, syncFindings,
    pendingDeductionRecipeIds: pendingDeductionHolds.map((h) => h.recipeId),
    pendingDeductionHolds, invoiceNumbers, warnings, recipeNames,
  };
}
