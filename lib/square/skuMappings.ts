/**
 * Unified Square SKU resolver. The ONLY module features should call to answer
 * "what Square SKU represents this physical thing?". It hides which underlying
 * table is consulted:
 *   - product SKUs  → recipe_square_links (variation-grain for keg/can,
 *                     recipe-grain for draft)
 *   - service/fee   → invoice_item_mappings (coarse: service + partner +
 *                     container + format; beer-agnostic by design)
 *   - catalog meta  → square_catalog_variations (the mirror: names, GL account,
 *                     inventory-unit semantics)
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SkuDbClient = { from: (table: string) => any };

export interface ProductSku {
  squareVariationId: string;
  squareItemId: string | null;
  catalogVariationId: string | null;
  itemName: string | null;
  variationName: string | null;
}

export interface ServiceSku {
  squareVariationId: string | null;
  squareItemId: string | null;
  squareDiscountId: string | null;
  displayName: string | null;
}

export interface CatalogMeta {
  catalogVariationId: string;
  squareVariationId: string;
  itemName: string | null;
  variationName: string | null;
  inventoryUnit: "fl_oz" | "each" | null;
  volumeFlOzPerUnit: number | null;
  chartOfAccountsId: string | null;
}

export interface ServiceMappingRow {
  service_type: string;
  partner_id: string | null;
  packaging_item_id: string | null;
  packaging_format: string | null;
  square_catalog_item_id: string | null;
  square_catalog_variation_id: string | null;
  square_catalog_discount_id: string | null;
  display_name: string | null;
}

/**
 * Pure selection: among service mappings already loaded for a partner+default,
 * pick the row matching (service, container, format), preferring the
 * partner-specific row over the partner_id-NULL default.
 */
export function selectServiceMapping(
  rows: ServiceMappingRow[],
  c: { serviceType: string; partnerId: string | null; packagingItemId: string | null; packagingFormat: string | null }
): ServiceMappingRow | null {
  const matches = (m: ServiceMappingRow, partner: string | null) =>
    m.service_type === c.serviceType &&
    m.partner_id === partner &&
    m.packaging_item_id === c.packagingItemId &&
    m.packaging_format === c.packagingFormat;

  if (c.partnerId) {
    const partnerRow = rows.find((m) => matches(m, c.partnerId));
    if (partnerRow) return partnerRow;
  }
  return rows.find((m) => matches(m, null)) ?? null;
}

export async function resolveProductSku(
  db: SkuDbClient,
  args: { kind: "draft"; recipeId: string } | { kind: "packaged"; variationId: string }
): Promise<ProductSku | null> {
  let q = db
    .from("recipe_square_links")
    .select("square_variation_id, square_item_id, catalog_variation_id, item_name, variation_name");

  q = args.kind === "draft"
    ? q.eq("recipe_id", args.recipeId).eq("packaging", "draft")
    : q.eq("variation_id", args.variationId);

  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    squareVariationId: data.square_variation_id,
    squareItemId: data.square_item_id ?? null,
    catalogVariationId: data.catalog_variation_id ?? null,
    itemName: data.item_name ?? null,
    variationName: data.variation_name ?? null,
  };
}

export async function resolveServiceSku(
  db: SkuDbClient,
  args: { serviceType: string; partnerId: string | null; packagingItemId?: string | null; packagingFormat?: string | null }
): Promise<ServiceSku | null> {
  const { data, error } = await db
    .from("invoice_item_mappings")
    .select("service_type, partner_id, packaging_item_id, packaging_format, square_catalog_item_id, square_catalog_variation_id, square_catalog_discount_id, display_name")
    .eq("service_type", args.serviceType)
    .or(`partner_id.eq.${args.partnerId ?? "00000000-0000-0000-0000-000000000000"},partner_id.is.null`);
  if (error) throw new Error(error.message);

  const row = selectServiceMapping((data ?? []) as ServiceMappingRow[], {
    serviceType: args.serviceType,
    partnerId: args.partnerId,
    packagingItemId: args.packagingItemId ?? null,
    packagingFormat: args.packagingFormat ?? null,
  });
  if (!row) return null;
  return {
    squareVariationId: row.square_catalog_variation_id,
    squareItemId: row.square_catalog_item_id,
    squareDiscountId: row.square_catalog_discount_id,
    displayName: row.display_name,
  };
}

export async function resolveCatalog(
  db: SkuDbClient,
  squareVariationId: string
): Promise<CatalogMeta | null> {
  const { data, error } = await db
    .from("square_catalog_variations")
    .select("id, square_variation_id, variation_name, inventory_unit, volume_fl_oz_per_unit, chart_of_accounts_id, square_catalog_items(item_name)")
    .eq("square_variation_id", squareVariationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    catalogVariationId: data.id,
    squareVariationId: data.square_variation_id,
    itemName: data.square_catalog_items?.item_name ?? null,
    variationName: data.variation_name ?? null,
    inventoryUnit: data.inventory_unit ?? null,
    volumeFlOzPerUnit: data.volume_fl_oz_per_unit ?? null,
    chartOfAccountsId: data.chart_of_accounts_id ?? null,
  };
}
