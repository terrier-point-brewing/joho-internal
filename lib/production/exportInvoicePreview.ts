import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { buildStandalonePriceMap } from "@/lib/square/catalog";
import { GALLONS_PER_BBL } from "@/lib/constants/production";
import { resolveProductSku } from "@/lib/square/skuMappings";
import { dollarsToCents } from "@/lib/money";
import { computeMaterialCost, type MaterialComponent, type MaterialTxnInput } from "./packagingMaterials";

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
    container:packaging_items!packaging_variations_container_id_fkey(name, unit_cost, can_count, type),
    lid:packaging_items!packaging_variations_lid_id_fkey(name, unit_cost),
    label:packaging_items!packaging_variations_label_id_fkey(name, unit_cost),
    paktech:packaging_items!packaging_variations_paktech_id_fkey(name, unit_cost, can_count),
    tray:packaging_items!packaging_variations_tray_id_fkey(name, unit_cost, can_count)
  )
`;

interface SlotItem { name: string; unit_cost: number | null; can_count?: number | null }

export async function buildPackagingMaterialLines(
  supabase: SupabaseClient,
  rows: ExportTxRow[],
  pkgTypeById: Map<string, string>,
  pkgNameById: Map<string, string>,
  recipeNameById: Map<string, string>,
  materialVariationId: string | null,
): Promise<{ lines: InvoiceLineItemDraft[]; warnings: string[] }> {
  const warnings: string[] = [];
  const byRecipe = new Map<string, MaterialTxnInput[]>();

  for (const tx of rows) {
    if (pkgTypeById.get(tx.packaging_item_id) === "keg") continue; // cans only
    const containerName = pkgNameById.get(tx.packaging_item_id) ?? tx.packaging_item_id;
    const beerName = tx.recipe_id ? recipeNameById.get(tx.recipe_id) ?? null : null;
    const format = tx.packaging_format ?? "loose";

    if (!tx.recipe_id) {
      warnings.push(`Couldn't resolve packaging materials for "${containerName}" (${format}) — no recipe on the shipment, no materials charged.`);
      continue;
    }

    const { data: pvRows, error } = await supabase
      .from("recipe_packaging_variations")
      .select(MATERIAL_SLOT_SELECT)
      .eq("recipe_id", tx.recipe_id)
      .eq("packaging_variations.container_id", tx.packaging_item_id)
      .eq("packaging_variations.format", format);
    if (error || !pvRows || pvRows.length !== 1) {
      warnings.push(`Couldn't resolve packaging materials for ${beerName ?? containerName} (${containerName}, ${format}) — no materials charged. Check Link Styles to Square.`);
      continue;
    }

    const pv = (pvRows[0] as { packaging_variations: Record<string, SlotItem | null> }).packaging_variations;
    const roleBySlot: Array<[string, MaterialComponent["role"]]> = [
      ["container", "container"], ["lid", "lid"], ["label", "label"], ["paktech", "paktech"], ["tray", "tray"],
    ];
    const components: MaterialComponent[] = [];
    for (const [slot, role] of roleBySlot) {
      const item = pv[slot];
      if (!item) continue; // slot not populated on this variation
      components.push({ role, name: item.name, unitCostDollars: item.unit_cost, canCount: item.can_count ?? null });
    }

    const input: MaterialTxnInput = { format, packages: tx.quantity, unitsPerPackage: tx.units_per_package || 1, components };
    const list = byRecipe.get(tx.recipe_id) ?? [];
    list.push(input);
    byRecipe.set(tx.recipe_id, list);
  }

  const lines: InvoiceLineItemDraft[] = [];
  const missingAll = new Set<string>();
  for (const [recipeId, txns] of byRecipe) {
    const { totalCents, missingCostNames } = computeMaterialCost(txns);
    missingCostNames.forEach((n) => missingAll.add(n));
    if (totalCents <= 0) continue; // no meaningful $0 line
    const beerName = recipeNameById.get(recipeId) ?? null;
    lines.push({
      id: crypto.randomUUID(),
      description: beerName ? `Packaging Materials — ${beerName}` : "Packaging Materials",
      quantity: 1,
      unitPriceCents: totalCents,
      squareCatalogVariationId: materialVariationId,
    });
  }
  if (missingAll.size > 0) {
    warnings.push(`No unit cost set for ${[...missingAll].join(", ")} — those components billed at $0. Set costs under Packaging Items.`);
  }

  return { lines, warnings };
}

async function buildProductLines(
  supabase: SupabaseClient,
  rows: ExportTxRow[],
  priceByVariationId: Map<string, number>,
  pkgNameById: Map<string, string>
): Promise<InvoiceLineItemDraft[]> {
  // export_transactions does NOT store variation_id (confirmed against the live
  // schema), so resolve the packaging_variation each transaction shipped
  // (recipe ∩ container ∩ format) first, then the product SKU at variation
  // grain via the unified resolver.
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
      .select("variation_id, packaging_variations!inner(id, container_id, format)")
      .eq("recipe_id", tx.recipe_id)
      .eq("packaging_variations.container_id", tx.packaging_item_id)
      .eq("packaging_variations.format", tx.packaging_format ?? "loose");
    if (pvErr) throw new Error(pvErr.message);
    if (!pvRows || pvRows.length !== 1) {
      throw new Error(
        `Cannot uniquely resolve the packaging variation for recipe + "${pkgName}" ` +
        `(format: ${tx.packaging_format || "none"}) — ${pvRows?.length ?? 0} candidates. ` +
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
    .select("id, recipient_id, status, quantity, volume_bbl, packaging_item_id, packaging_format, units_per_package, channel, recipe_id")
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
  const packagingItemIds = [...new Set(rows.map((r) => r.packaging_item_id))];
  const { data: pkgItems } = await supabase
    .from("packaging_items")
    .select("id, type, name")
    .in("id", packagingItemIds);
  const pkgTypeById = new Map((pkgItems ?? []).map((p) => [p.id, p.type as string]));
  const pkgNameById = new Map((pkgItems ?? []).map((p) => [p.id, p.name as string]));

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
  let defaultDiscountCatalogId: string | null = null;

  if (channel === "contract_brewing") {
    // ── 5a. Packaging Fee lines ─────────────────────────────────────────────
    // Recipe (beer) names, so each Packaging Fee line names its recipe — an
    // invoice can span multiple recipes, one Packaging Fee line per transaction.
    const recipeIds = [...new Set(rows.map((r) => r.recipe_id).filter((id): id is string => !!id))];
    const recipeNameById = new Map<string, string>();
    if (recipeIds.length > 0) {
      const { data: recipeRows } = await supabase
        .from("recipes")
        .select("id, beer_name")
        .in("id", recipeIds);
      for (const r of recipeRows ?? []) recipeNameById.set(r.id as string, r.beer_name as string);
    }

    // Total keg count across all keg-type transactions — drives keg cleaning qty.
    const kegCleaningQty = sumKegCleaningQuantity(rows, pkgTypeById);
    for (const tx of rows) {
      const isKeg = pkgTypeById.get(tx.packaging_item_id) === "keg";
      const containerName = pkgNameById.get(tx.packaging_item_id) ?? "unknown container";
      const beerName = tx.recipe_id ? recipeNameById.get(tx.recipe_id) : null;

      // Cans carry a case/loose format dimension on the mapping; kegs don't.
      const mapFormat = isKeg ? null : tx.packaging_format ?? "loose";

      if (mapFormat === "case") {
        const wholeCases = Math.floor(tx.quantity + 1e-9);
        const remainder = tx.quantity - wholeCases;
        const looseUnits = Math.round(remainder * (tx.units_per_package || 1));

        if (wholeCases > 0) {
          const caseMapping = findMapping("packaging_fee", tx.packaging_item_id, "case");
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
          const looseMapping = findMapping("packaging_fee", tx.packaging_item_id, "loose");
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

      const mapping = findMapping("packaging_fee", tx.packaging_item_id, mapFormat);
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
  };
}
