import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { buildStandalonePriceMap } from "@/lib/square/catalog";
import { GALLONS_PER_BBL } from "@/lib/constants/production";
import { resolveProductSku } from "@/lib/square/skuMappings";
import { dollarsToCents } from "@/lib/money";
import {
  computeMaterialBreakdown,
  type MaterialComponent,
  type MaterialCostBreakdown,
  type MaterialTxnInput,
} from "./packagingMaterials";

export interface InvoiceLineItemDraft {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  squareCatalogVariationId: string | null;
  discountCatalogId?: string | null;
}

export interface InvoicePreviewResult {
  customerId: string;
  customerName: string;
  squareCustomerId: string | null;
  lineItems: InvoiceLineItemDraft[];
  /**
   * The effective channel used to build the line items — the billing-channel
   * override when one is supplied, otherwise the shared stored channel.
   */
  channel: string;
  /**
   * The channel the selected transactions were actually SHIPPED under (the
   * stored `export_transactions.channel`), or "mixed" if they differ. Equals
   * `channel` when no override is in effect. For display / audit only — never
   * used to build line items.
   */
  shippedChannel: string;
  /**
   * Square catalog discount mapped for this channel (the "bulk discount" for
   * distribution / the wholesale discount for wholesale), or null when none is
   * configured. The modal uses this to label the auto-applied discount and to
   * offer re-applying it after manual edits.
   */
  defaultDiscountCatalogId: string | null;
  /**
   * Non-blocking advisories raised while building the preview (e.g. packaging
   * components with no unit cost, or a shipment whose packaging variation could
   * not be resolved for the materials charge). Rendered in the modal; never
   * blocks invoice generation. Empty for non-contract-brewing channels.
   */
  warnings: string[];
  /**
   * Per-line derivation of every Packaging Materials line, keyed by the line's
   * `id`. Lets the modal show how the charge was computed (components consumed
   * × unit cost) without recomputing it client-side. Display only — the
   * authoritative amount is the line's `unitPriceCents`. Empty for channels
   * that don't charge materials.
   */
  materialBreakdowns: Record<string, MaterialLineBreakdown>;
}

/** A Packaging Materials line's derivation, plus the recipe it belongs to. */
export interface MaterialLineBreakdown extends MaterialCostBreakdown {
  recipeId: string;
  beerName: string | null;
}

interface ExportTxRow {
  id: string;
  recipient_id: string | null;
  status: string;
  quantity: number;
  volume_bbl: number;
  packaging_item_id: string;
  packaging_format: string | null;
  units_per_package: number;
  channel: string;
  recipe_id: string | null;
  // The literal packaging variation shipped, stored by name at ship time
  // (writeExportTransaction: variant_label = variation.name). Pinpoints the exact
  // label-variant for the materials charge — (recipe ∩ container ∩ format) can be
  // ambiguous when one liquid ships under two brand labels.
  variant_label: string;
  /** Canning loss % inherited from the run that filled these cans; 0 for kegs. */
  packaging_loss_pct: number | null;
}

/**
 * Decide the channel the invoice line-item branch should use.
 * - No override: every selected row must share one stored channel (else throw).
 * - Override: any mix of stored channels is allowed; the effective channel is the
 *   override, and shippedChannel is the single stored channel or "mixed".
 * Exported for unit testing.
 */
export function resolveInvoiceChannel(
  storedChannels: string[],
  billAsChannel?: string | null
): { shippedChannel: string; channel: string } {
  const distinct = new Set(storedChannels);
  const shippedChannel = distinct.size === 1 ? [...distinct][0] : "mixed";
  if (billAsChannel) return { shippedChannel, channel: billAsChannel };
  if (distinct.size !== 1) {
    throw new Error("All selected transactions must share the same channel — mixed-channel invoices are not supported");
  }
  return { shippedChannel, channel: shippedChannel };
}

/**
 * Packaging Fee line descriptions carry the recipe (beer) name so a single
 * invoice spanning multiple recipes shows which beer each fee belongs to
 * ("Packaging Fee — Fortnight" vs. a bare "Packaging Fee" that's ambiguous
 * once two recipes are on the same invoice). Falls back to the bare display
 * name when the transaction has no recipe. Exported for unit testing.
 */
export function packagingFeeDescription(
  displayName: string,
  beerName: string | null | undefined
): string {
  return beerName ? `${displayName} — ${beerName}` : displayName;
}

/**
 * Keg-cleaning line quantity = the total number of kegs across every keg-type
 * transaction in the selection, NOT the number of transactions. Kegs are
 * cleaned per unit, so two transactions of 6 and 4 kegs yield a cleaning qty of
 * 10. Non-keg (can) transactions are ignored. Exported for unit testing.
 */
export function sumKegCleaningQuantity(
  rows: Pick<ExportTxRow, "packaging_item_id" | "quantity">[],
  pkgTypeById: Map<string, string>
): number {
  let total = 0;
  for (const tx of rows) {
    if (pkgTypeById.get(tx.packaging_item_id) === "keg") total += tx.quantity;
  }
  return total;
}

/**
 * A packaging-fee charge unit: one recipe × packaging type × mapping format.
 *
 * A single physical shipment can be stored as SEVERAL export_transactions when
 * its volume is drawn from more than one commitment (e.g. 16 half-kegs split
 * into 5.8034 + 10.1966 keg fulfillments against the same batch). Those splits
 * are an allocation-ledger concern, not a billing one — the customer packaged
 * 16 kegs and owes one packaging fee for 16. Grouping before pricing collapses
 * them, and also keeps the case/loose remainder math honest: 2.5 + 2.5 cases
 * must bill as 5 whole cases, not as two 2-case lines plus two half-case
 * remainders.
 */
export interface PackagingFeeGroup {
  recipeId: string | null;
  packagingItemId: string;
  /** Mapping's format dimension — null for kegs, else "case" / "loose" / … */
  mapFormat: string | null;
  quantity: number;
  unitsPerPackage: number;
}

type PackagingFeeRow = Pick<
  ExportTxRow,
  "recipe_id" | "packaging_item_id" | "packaging_format" | "quantity" | "units_per_package"
>;

/**
 * Collapse transactions into one group per recipe × packaging item × format,
 * summing quantities. Group order follows first appearance so line order stays
 * stable. Totals are rounded to 6 decimals to clear the float dust left by
 * summing fractional commitment splits (5.8034 + 10.1966 → 16, not
 * 15.999999999999998). Exported for unit testing.
 */
export function groupPackagingFeeRows(
  rows: PackagingFeeRow[],
  pkgTypeById: Map<string, string>
): PackagingFeeGroup[] {
  const groups = new Map<string, PackagingFeeGroup>();
  for (const tx of rows) {
    // Cans carry a case/loose format dimension on the mapping; kegs don't.
    const mapFormat = pkgTypeById.get(tx.packaging_item_id) === "keg" ? null : tx.packaging_format ?? "loose";
    const key = `${tx.recipe_id ?? ""}|${tx.packaging_item_id}|${mapFormat ?? ""}`;
    const existing = groups.get(key);
    if (existing) {
      existing.quantity += tx.quantity;
      continue;
    }
    groups.set(key, {
      recipeId: tx.recipe_id,
      packagingItemId: tx.packaging_item_id,
      mapFormat,
      quantity: tx.quantity,
      unitsPerPackage: tx.units_per_package || 1,
    });
  }
  return [...groups.values()].map((g) => ({ ...g, quantity: Math.round(g.quantity * 1e6) / 1e6 }));
}

// Exported for unit testing of the amount_usd → cents conversion seam.
export async function buildExciseTaxLines(
  supabase: SupabaseClient,
  transactionIds: string[],
  rows: ExportTxRow[]
): Promise<InvoiceLineItemDraft[]> {
  const { data: taxRows } = await supabase
    .from("export_transaction_taxes")
    .select("export_transaction_id, amount_usd, excise_tax_rate_id")
    .in("export_transaction_id", transactionIds);

  if (!taxRows || taxRows.length === 0) return [];

  const rateIds = [...new Set(taxRows.map((t) => t.excise_tax_rate_id).filter((id): id is string => !!id))];
  const { data: rates } = await supabase
    .from("tax_rates")
    .select("id, receiving_party, basis, square_catalog_variation_id")
    .in("id", rateIds);
  const rateById = new Map((rates ?? []).map((r) => [r.id, r]));
  const volumeByTx = new Map(rows.map((r) => [r.id, r.volume_bbl]));

  const byParty = new Map<string, { amountCents: number; units: number; unit: "bbl" | "gallon"; variationId: string | null }>();
  for (const t of taxRows) {
    const rate = t.excise_tax_rate_id ? rateById.get(t.excise_tax_rate_id) : undefined;
    const party = rate?.receiving_party ?? "Unknown";
    const volumeBbl = volumeByTx.get(t.export_transaction_id) ?? 0;
    const unit = rate?.basis === "per_gallon" ? "gallon" : "bbl";
    const units = unit === "bbl" ? volumeBbl : volumeBbl * GALLONS_PER_BBL;
    const entry = byParty.get(party) ?? { amountCents: 0, units: 0, unit, variationId: rate?.square_catalog_variation_id ?? null };
    // UNIT CROSSING: export_transaction_taxes.amount_usd is decimal USD dollars;
    // invoice line item unit prices are integer cents. Round dollars → cents.
    entry.amountCents += dollarsToCents(t.amount_usd);
    entry.units += units;
    byParty.set(party, entry);
  }

  return [...byParty.entries()].map(([party, entry]) => ({
    id: crypto.randomUUID(),
    description: `Excise Tax — ${party} (${entry.units.toFixed(2)} ${entry.unit}${entry.units !== 1 ? "s" : ""})`,
    quantity: 1,
    unitPriceCents: entry.amountCents,
    squareCatalogVariationId: entry.variationId,
  }));
}

// Contract-brewing "Packaging Materials" lines: one per recipe, priced at the
// summed unit cost of the packaging components each can shipment consumed. Cans
// only (kegs are reusable / get keg-cleaning). Never throws — an unresolvable
// variation or missing unit cost degrades to a warning so it can't block an
// otherwise-valid invoice. Exported for unit testing.
const MATERIAL_SLOT_SELECT = `
  packaging_variations!inner(
    container:packaging_items!packaging_variations_container_id_fkey(name, unit_cost_usd, can_count, type),
    lid:packaging_items!packaging_variations_lid_id_fkey(name, unit_cost_usd),
    label:packaging_items!packaging_variations_label_id_fkey(name, unit_cost_usd),
    paktech:packaging_items!packaging_variations_paktech_id_fkey(name, unit_cost_usd, can_count),
    tray:packaging_items!packaging_variations_tray_id_fkey(name, unit_cost_usd, can_count)
  )
`;

interface SlotItem { name: string; unit_cost_usd: number | null; can_count?: number | null }

// Map a resolved variation's populated slot items to priced material components.
function slotComponents(pv: Record<string, SlotItem | null>): MaterialComponent[] {
  const roleBySlot: Array<[string, MaterialComponent["role"]]> = [
    ["container", "container"], ["lid", "lid"], ["label", "label"], ["paktech", "paktech"], ["tray", "tray"],
  ];
  const out: MaterialComponent[] = [];
  for (const [slot, role] of roleBySlot) {
    const item = pv[slot];
    if (!item) continue; // slot not populated on this variation
    out.push({ role, name: item.name, unitCostDollars: item.unit_cost_usd, canCount: item.can_count ?? null });
  }
  return out;
}

export async function buildPackagingMaterialLines(
  supabase: SupabaseClient,
  rows: ExportTxRow[],
  pkgTypeById: Map<string, string>,
  pkgNameById: Map<string, string>,
  recipeNameById: Map<string, string>,
  materialVariationId: string | null,
): Promise<{ lines: InvoiceLineItemDraft[]; warnings: string[]; breakdowns: Record<string, MaterialLineBreakdown> }> {
  const warnings: string[] = [];
  // recipe → (variation × format) → the collapsed charge unit. Transactions are
  // merged the same way packaging fees are (see groupPackagingFeeRows): a
  // shipment split across commitments is one packaging run, so its packages sum
  // before the per-component quantities are rounded.
  const byRecipe = new Map<string, Map<string, MaterialTxnInput>>();

  for (const tx of rows) {
    if (pkgTypeById.get(tx.packaging_item_id) === "keg") continue; // cans only
    const containerName = pkgNameById.get(tx.packaging_item_id) ?? tx.packaging_item_id;
    const beerName = tx.recipe_id ? recipeNameById.get(tx.recipe_id) ?? null : null;
    const format = tx.packaging_format ?? "loose";

    if (!tx.recipe_id) {
      warnings.push(`Couldn't resolve packaging materials for "${containerName}" (${format}) — no recipe on the shipment, no materials charged.`);
      continue;
    }

    // Merge into an already-resolved charge unit before hitting the DB — the
    // components are a property of the variation, not of the transaction.
    const group = byRecipe.get(tx.recipe_id) ?? new Map<string, MaterialTxnInput>();
    byRecipe.set(tx.recipe_id, group);
    const key = `${tx.variant_label}|${format}`;
    const existing = group.get(key);
    if (existing) {
      // Two shipments of the same variation can come off canning runs with
      // different loss rates, so the merged charge unit carries their
      // package-weighted average rather than whichever row happened to land first.
      const merged = Math.round((existing.packages + tx.quantity) * 1e6) / 1e6;
      if (merged > 0) {
        const weighted =
          (existing.lossPct ?? 0) * existing.packages +
          Number(tx.packaging_loss_pct ?? 0) * tx.quantity;
        existing.lossPct = Math.round((weighted / merged) * 1000) / 1000;
      }
      existing.packages = merged;
      continue;
    }

    // Resolve the LITERAL variation shipped, recorded on the export as
    // variant_label (= the variation's name at ship time). This pinpoints the
    // exact label-variant — (recipe ∩ container ∩ format) alone is ambiguous when
    // one liquid ships under two brand labels sharing a can + format.
    const { data: pvRows, error } = await supabase
      .from("recipe_packaging_variations")
      .select(MATERIAL_SLOT_SELECT)
      .eq("recipe_id", tx.recipe_id)
      .eq("packaging_variations.name", tx.variant_label);
    if (error || !pvRows || pvRows.length !== 1) {
      warnings.push(`Couldn't resolve packaging materials for ${beerName ?? containerName} ("${tx.variant_label}") — no materials charged. Check Link Styles to Square.`);
      continue;
    }

    const components = slotComponents((pvRows[0] as unknown as { packaging_variations: Record<string, SlotItem | null> }).packaging_variations);
    group.set(key, {
      format,
      packages: tx.quantity,
      unitsPerPackage: tx.units_per_package || 1,
      components,
      label: tx.variant_label,
      lossPct: Number(tx.packaging_loss_pct ?? 0),
    });
  }

  const lines: InvoiceLineItemDraft[] = [];
  const breakdowns: Record<string, MaterialLineBreakdown> = {};
  const missingAll = new Set<string>();
  for (const [recipeId, txns] of byRecipe) {
    const breakdown = computeMaterialBreakdown([...txns.values()]);
    breakdown.missingCostNames.forEach((n) => missingAll.add(n));
    if (breakdown.totalCents <= 0) continue; // no meaningful $0 line
    const beerName = recipeNameById.get(recipeId) ?? null;
    const id = crypto.randomUUID();
    lines.push({
      id,
      description: beerName ? `Packaging Materials — ${beerName}` : "Packaging Materials",
      quantity: 1,
      unitPriceCents: breakdown.totalCents,
      squareCatalogVariationId: materialVariationId,
    });
    breakdowns[id] = { ...breakdown, recipeId, beerName };
  }
  if (missingAll.size > 0) {
    warnings.push(`No unit cost set for ${[...missingAll].join(", ")} — those components billed at $0. Set costs under Packaging Items.`);
  }

  return { lines, warnings, breakdowns };
}

// Packaging item type ('keg' detection) + display name, keyed by id.
async function loadPackagingMaps(
  supabase: SupabaseClient,
  rows: Pick<ExportTxRow, "packaging_item_id">[]
): Promise<{ pkgTypeById: Map<string, string>; pkgNameById: Map<string, string> }> {
  const ids = [...new Set(rows.map((r) => r.packaging_item_id))];
  const { data } = await supabase.from("packaging_items").select("id, type, name").in("id", ids);
  return {
    pkgTypeById: new Map((data ?? []).map((p) => [p.id as string, p.type as string])),
    pkgNameById: new Map((data ?? []).map((p) => [p.id as string, p.name as string])),
  };
}

// Beer name per recipe id, so each line can name the beer it belongs to.
async function loadRecipeNames(
  supabase: SupabaseClient,
  rows: Pick<ExportTxRow, "recipe_id">[]
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.recipe_id).filter((id): id is string => !!id))];
  const byId = new Map<string, string>();
  if (ids.length === 0) return byId;
  const { data } = await supabase.from("recipes").select("id, beer_name").in("id", ids);
  for (const r of data ?? []) byId.set(r.id as string, r.beer_name as string);
  return byId;
}

/**
 * Recompute the Packaging Materials derivation for a set of shipments, outside
 * the invoice-preview flow — used to snapshot the computation onto the invoice
 * at generate/record time. Deliberately does NOT enforce the preview's
 * same-customer / invoice_required guards: `record` flips status before the
 * invoice row exists, and the caller has already validated the selection.
 * Returns one entry per recipe; empty when nothing is materials-billable.
 */
export async function computeMaterialBreakdownsForTransactions(
  supabase: SupabaseClient,
  transactionIds: string[]
): Promise<MaterialLineBreakdown[]> {
  if (transactionIds.length === 0) return [];
  const { data: txs, error } = await supabase
    .from("export_transactions")
    .select("id, recipient_id, status, quantity, volume_bbl, packaging_item_id, packaging_format, units_per_package, channel, recipe_id, variant_label, packaging_loss_pct")
    .in("id", transactionIds);
  if (error || !txs?.length) return [];

  const rows = txs as ExportTxRow[];
  const { pkgTypeById, pkgNameById } = await loadPackagingMaps(supabase, rows);
  const recipeNameById = await loadRecipeNames(supabase, rows);

  const { breakdowns } = await buildPackagingMaterialLines(
    supabase, rows, pkgTypeById, pkgNameById, recipeNameById, null,
  );
  return Object.values(breakdowns);
}

// Distribution / wholesale product lines: one per shipped transaction, priced
// from the resolved Square SKU. Fail-closed — an unresolvable shipped variation
// or a missing Square product link throws, since a product line IS the invoice
// and silently dropping it would undercharge the customer. Exported for unit
// testing.
export async function buildProductLines(
  supabase: SupabaseClient,
  rows: ExportTxRow[],
  priceByVariationId: Map<string, number>,
  pkgNameById: Map<string, string>
): Promise<InvoiceLineItemDraft[]> {
  // export_transactions does NOT store variation_id (confirmed against the live
  // schema), so resolve the packaging_variation each transaction shipped, then
  // the product SKU at variation grain via the unified resolver. Match on the
  // LITERAL variation shipped — variant_label (= packaging_variations.name at
  // ship time) — scoped to the recipe. (recipe ∩ container ∩ format) is
  // ambiguous when one liquid ships under two brand labels sharing a can +
  // format, and would block the whole invoice.
  const lineItems: InvoiceLineItemDraft[] = [];
  for (const tx of rows) {
    if (!tx.recipe_id) {
      throw new Error(
        `Transaction ${tx.id} has no recipe — cannot build product line items for this channel`
      );
    }
    const pkgName = pkgNameById.get(tx.packaging_item_id) ?? tx.packaging_item_id;

    const { data: pvRows, error: pvErr } = await supabase
      .from("recipe_packaging_variations")
      .select("variation_id, packaging_variations!inner(id, name)")
      .eq("recipe_id", tx.recipe_id)
      .eq("packaging_variations.name", tx.variant_label);
    if (pvErr) throw new Error(pvErr.message);
    if (!pvRows || pvRows.length !== 1) {
      throw new Error(
        `Cannot resolve the packaging variation "${tx.variant_label}" for recipe + "${pkgName}" ` +
        `— ${pvRows?.length ?? 0} candidates. ` +
        `Resolve the mapping in Production → Link Styles to Square.`
      );
    }
    const variationId = pvRows[0].variation_id as string;

    const sku = await resolveProductSku(supabase, { kind: "packaged", variationId, recipeId: tx.recipe_id });
    if (!sku) {
      throw new Error(
        `No Square product link found for recipe + "${pkgName}" (format: ${tx.packaging_format || "none"}) — ` +
        `go to Production → Link Styles to Square and add this mapping before generating a Distribution or Wholesale invoice.`
      );
    }
    lineItems.push({
      id: crypto.randomUUID(),
      description: sku.itemName
        ? `${sku.itemName}${sku.variationName ? ` · ${sku.variationName}` : ""}${tx.packaging_format ? ` (${tx.packaging_format})` : ""}`
        : sku.squareVariationId,
      quantity: tx.quantity,
      unitPriceCents: priceByVariationId.get(sku.squareVariationId) ?? 0,
      squareCatalogVariationId: sku.squareVariationId,
    });
  }
  return lineItems;
}

export async function buildInvoicePreview(
  supabase: SupabaseClient,
  transactionIds: string[],
  billAsChannel?: string | null
): Promise<InvoicePreviewResult> {
  if (transactionIds.length === 0) {
    throw new Error("At least one export transaction must be selected");
  }

  // ── 1. Load transactions + validate same-customer, invoice_required ───────
  const { data: txs, error: txErr } = await supabase
    .from("export_transactions")
    .select("id, recipient_id, status, quantity, volume_bbl, packaging_item_id, packaging_format, units_per_package, channel, recipe_id, variant_label, packaging_loss_pct")
    .in("id", transactionIds);
  if (txErr) throw new Error(txErr.message);
  if (!txs || txs.length !== transactionIds.length) {
    throw new Error("One or more export transactions were not found");
  }

  const rows = txs as ExportTxRow[];
  const customerIds = new Set(rows.map((r) => r.recipient_id));
  if (customerIds.size !== 1 || rows[0].recipient_id == null) {
    throw new Error("All selected transactions must belong to the same customer");
  }
  if (rows.some((r) => r.status !== "invoice_required")) {
    throw new Error("All selected transactions must be in Invoice Required status");
  }
  const customerId = rows[0].recipient_id as string;

  // Resolve the effective billing channel: the stored channel unless an override
  // is supplied. Overrides may span mixed stored channels; without one, all rows
  // must share a channel.
  const { shippedChannel, channel } = resolveInvoiceChannel(
    rows.map((r) => r.channel),
    billAsChannel
  );

  // ── 2. Load the customer (square_customer_id, net terms) ─────────────────
  const { data: partner, error: partnerErr } = await supabase
    .from("contract_brewing_partners")
    .select("id, company_name, square_customer_id")
    .eq("id", customerId)
    .single();
  if (partnerErr || !partner) throw new Error("Customer not found");

  // ── 3. Load packaging items (for type='keg' detection + error messages) ───
  const { pkgTypeById, pkgNameById } = await loadPackagingMaps(supabase, rows);

  // ── 4. Load service mappings for this partner (with default fallback) ────
  const { data: mappings } = await supabase
    .from("invoice_item_mappings")
    .select("service_type, partner_id, packaging_item_id, packaging_format, square_catalog_item_id, square_catalog_variation_id, square_catalog_discount_id, display_name")
    .or(`partner_id.eq.${customerId},partner_id.is.null`);

  function findMapping(serviceType: string, packagingItemId: string | null, packagingFormat: string | null = null) {
    const rows2 = mappings ?? [];
    const partnerRow = rows2.find(
      (m) =>
        m.service_type === serviceType &&
        m.partner_id === customerId &&
        m.packaging_item_id === packagingItemId &&
        m.packaging_format === packagingFormat
    );
    if (partnerRow) return partnerRow;
    return rows2.find(
      (m) =>
        m.service_type === serviceType &&
        m.partner_id === null &&
        m.packaging_item_id === packagingItemId &&
        m.packaging_format === packagingFormat
    );
  }

  // ── 5. Resolve Square catalog prices for whatever variation IDs we need ──
  const catalogItems = await fetchCatalogItems();
  const priceByVariationId = buildStandalonePriceMap(catalogItems);

  const lineItems: InvoiceLineItemDraft[] = [];
  const warnings: string[] = [];
  const materialBreakdowns: Record<string, MaterialLineBreakdown> = {};
  let defaultDiscountCatalogId: string | null = null;

  if (channel === "contract_brewing") {
    // ── 5a. Packaging Fee lines ─────────────────────────────────────────────
    // Recipe (beer) names, so each Packaging Fee line names its recipe — an
    // invoice can span multiple recipes, one Packaging Fee line per transaction.
    const recipeNameById = await loadRecipeNames(supabase, rows);

    // Total keg count across all keg-type transactions — drives keg cleaning qty.
    const kegCleaningQty = sumKegCleaningQuantity(rows, pkgTypeById);

    // One fee line per recipe × packaging type × format — NOT per transaction.
    // See groupPackagingFeeRows: commitment splits are an allocation detail and
    // must not fan a single shipment out into multiple fee lines.
    for (const tx of groupPackagingFeeRows(rows, pkgTypeById)) {
      const containerName = pkgNameById.get(tx.packagingItemId) ?? "unknown container";
      const beerName = tx.recipeId ? recipeNameById.get(tx.recipeId) : null;
      const mapFormat = tx.mapFormat;

      if (mapFormat === "case") {
        const wholeCases = Math.floor(tx.quantity + 1e-9);
        const remainder = tx.quantity - wholeCases;
        const looseUnits = Math.round(remainder * tx.unitsPerPackage);

        if (wholeCases > 0) {
          const caseMapping = findMapping("packaging_fee", tx.packagingItemId, "case");
          if (!caseMapping?.square_catalog_variation_id) {
            throw new Error(
              `Packaging Fee (Case) is not configured for "${containerName}" — set it in Export Settings before generating this invoice.`
            );
          }
          lineItems.push({
            id: crypto.randomUUID(),
            description: packagingFeeDescription(caseMapping.display_name, beerName),
            quantity: wholeCases,
            unitPriceCents: priceByVariationId.get(caseMapping.square_catalog_variation_id) ?? 0,
            squareCatalogVariationId: caseMapping.square_catalog_variation_id,
          });
        }
        if (looseUnits > 0) {
          const looseMapping = findMapping("packaging_fee", tx.packagingItemId, "loose");
          if (!looseMapping?.square_catalog_variation_id) {
            throw new Error(
              `Packaging Fee (Loose Can) is not configured for "${containerName}" — set it in Export Settings before generating this invoice (needed for the partial-case remainder).`
            );
          }
          lineItems.push({
            id: crypto.randomUUID(),
            description: packagingFeeDescription(looseMapping.display_name, beerName),
            quantity: looseUnits,
            unitPriceCents: priceByVariationId.get(looseMapping.square_catalog_variation_id) ?? 0,
            squareCatalogVariationId: looseMapping.square_catalog_variation_id,
          });
        }
        continue;
      }

      const mapping = findMapping("packaging_fee", tx.packagingItemId, mapFormat);
      if (!mapping?.square_catalog_variation_id) {
        throw new Error(
          `Packaging Fee is not configured for "${containerName}" — set it in Export Settings before generating this invoice.`
        );
      }
      lineItems.push({
        id: crypto.randomUUID(),
        description: packagingFeeDescription(mapping.display_name, beerName),
        quantity: tx.quantity,
        unitPriceCents: priceByVariationId.get(mapping.square_catalog_variation_id) ?? 0,
        squareCatalogVariationId: mapping.square_catalog_variation_id,
      });
    }

    // ── 5b. Excise Tax — one line per receiving_party, rolled up ─────────────
    lineItems.push(...await buildExciseTaxLines(supabase, transactionIds, rows));

    // ── 5c. Keg Cleaning — one line, qty = total kegs across keg-type txns ────
    if (kegCleaningQty > 0) {
      const mapping = findMapping("keg_cleaning", null);
      if (mapping?.square_catalog_variation_id) {
        lineItems.push({
          id: crypto.randomUUID(),
          description: mapping.display_name,
          quantity: kegCleaningQty,
          unitPriceCents: priceByVariationId.get(mapping.square_catalog_variation_id) ?? 0,
          squareCatalogVariationId: mapping.square_catalog_variation_id,
        });
      }
    }

    // ── 5d. Forklift — one flat line, regardless of transaction count ─────────
    {
      const mapping = findMapping("forklift", null);
      if (mapping?.square_catalog_variation_id) {
        lineItems.push({
          id: crypto.randomUUID(),
          description: mapping.display_name,
          quantity: 1,
          unitPriceCents: priceByVariationId.get(mapping.square_catalog_variation_id) ?? 0,
          squareCatalogVariationId: mapping.square_catalog_variation_id,
        });
      }
    }

    // ── 5e. Packaging Materials — one line per recipe, cost of components used ──
    const materialVariationId = findMapping("packaging_material", null)?.square_catalog_variation_id ?? null;
    const materials = await buildPackagingMaterialLines(
      supabase, rows, pkgTypeById, pkgNameById, recipeNameById, materialVariationId,
    );
    lineItems.push(...materials.lines);
    warnings.push(...materials.warnings);
    Object.assign(materialBreakdowns, materials.breakdowns);

  } else if (channel === "distribution" || channel === "wholesale") {
    // ── Product lines (from recipe_square_links) ──────────────────────────────
    const productLines = await buildProductLines(supabase, rows, priceByVariationId, pkgNameById);

    // Apply channel-appropriate discount to all product lines (optional — no error if missing)
    const discountServiceType = channel === "distribution" ? "distribution_discount" : "wholesale_discount";
    const discountMapping = findMapping(discountServiceType, null);
    const discountCatalogId = discountMapping?.square_catalog_discount_id ?? null;
    defaultDiscountCatalogId = discountCatalogId;

    for (const line of productLines) {
      lineItems.push({ ...line, discountCatalogId });
    }

    // ── Excise Tax (distribution only, no excise for wholesale) ──────────────
    if (channel === "distribution") {
      lineItems.push(...await buildExciseTaxLines(supabase, transactionIds, rows));
    }

  } else {
    throw new Error(`Unsupported invoice channel: ${channel}`);
  }

  return {
    customerId,
    customerName: partner.company_name,
    squareCustomerId: partner.square_customer_id,
    lineItems,
    channel,
    shippedChannel,
    defaultDiscountCatalogId,
    warnings,
    materialBreakdowns,
  };
}
