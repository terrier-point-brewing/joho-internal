import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { buildStandalonePriceMap } from "@/lib/square/catalog";
import { GALLONS_PER_BBL } from "@/lib/constants/production";

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
  dueDays: number;
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

const DEFAULT_DUE_DAYS = 30;

async function buildExciseTaxLines(
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
    .from("excise_tax_rates")
    .select("id, receiving_party, unit, square_catalog_variation_id")
    .in("id", rateIds);
  const rateById = new Map((rates ?? []).map((r) => [r.id, r]));
  const volumeByTx = new Map(rows.map((r) => [r.id, r.volume_bbl]));

  const byParty = new Map<string, { amountCents: number; units: number; unit: "bbl" | "gallon"; variationId: string | null }>();
  for (const t of taxRows) {
    const rate = t.excise_tax_rate_id ? rateById.get(t.excise_tax_rate_id) : undefined;
    const party = rate?.receiving_party ?? "Unknown";
    const volumeBbl = volumeByTx.get(t.export_transaction_id) ?? 0;
    const unit = (rate?.unit ?? "bbl") as "bbl" | "gallon";
    const units = unit === "bbl" ? volumeBbl : volumeBbl * GALLONS_PER_BBL;
    const entry = byParty.get(party) ?? { amountCents: 0, units: 0, unit, variationId: rate?.square_catalog_variation_id ?? null };
    entry.amountCents += Math.round(t.amount_usd * 100);
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

async function buildProductLines(
  supabase: SupabaseClient,
  rows: ExportTxRow[],
  priceByVariationId: Map<string, number>,
  pkgNameById: Map<string, string>
): Promise<InvoiceLineItemDraft[]> {
  const recipeIds = [...new Set(rows.map((r) => r.recipe_id).filter((id): id is string => !!id))];
  const packagingItemIds = [...new Set(rows.map((r) => r.packaging_item_id))];

  const { data: links } = await supabase
    .from("recipe_square_links")
    .select("recipe_id, packaging_item_id, packaging_format, square_variation_id, item_name, variation_name")
    .in("recipe_id", recipeIds)
    .in("packaging_item_id", packagingItemIds);

  const linkMap = new Map(
    (links ?? []).map((l) => [
      `${l.recipe_id}|${l.packaging_item_id}|${l.packaging_format ?? ""}`,
      l,
    ])
  );

  const lineItems: InvoiceLineItemDraft[] = [];
  for (const tx of rows) {
    if (!tx.recipe_id) {
      throw new Error(
        `Transaction ${tx.id} has no recipe — cannot build product line items for this channel`
      );
    }
    const fmt = tx.packaging_format ?? "";
    const key = `${tx.recipe_id}|${tx.packaging_item_id}|${fmt}`;
    const link = linkMap.get(key);
    if (!link?.square_variation_id) {
      const pkgName = pkgNameById.get(tx.packaging_item_id) ?? tx.packaging_item_id;
      throw new Error(
        `No Square product link found for recipe + "${pkgName}" (format: ${fmt || "none"}) — ` +
        `go to Production → Link Styles to Square and add this mapping before generating a Distribution or Wholesale invoice.`
      );
    }
    lineItems.push({
      id: crypto.randomUUID(),
      description: link.item_name
        ? `${link.item_name}${link.variation_name ? ` · ${link.variation_name}` : ""}${fmt ? ` (${fmt})` : ""}`
        : link.square_variation_id,
      quantity: tx.quantity,
      unitPriceCents: priceByVariationId.get(link.square_variation_id) ?? 0,
      squareCatalogVariationId: link.square_variation_id,
    });
  }
  return lineItems;
}

export async function buildInvoicePreview(
  supabase: SupabaseClient,
  transactionIds: string[]
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

  // Validate all transactions share the same channel
  const channels = new Set(rows.map((r) => r.channel));
  if (channels.size !== 1) {
    throw new Error("All selected transactions must share the same channel — mixed-channel invoices are not supported");
  }
  const channel = rows[0].channel as string;

  // ── 2. Load the customer (square_customer_id, net terms) ─────────────────
  const { data: partner, error: partnerErr } = await supabase
    .from("contract_brewing_partners")
    .select("id, company_name, square_customer_id, export_net_terms_days")
    .eq("id", customerId)
    .single();
  if (partnerErr || !partner) throw new Error("Customer not found");

  let dueDays = partner.export_net_terms_days as number | null;
  if (dueDays == null) {
    const { data: setting } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "export_invoice_due_days")
      .single();
    dueDays = (setting?.value as number) ?? DEFAULT_DUE_DAYS;
  }

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

  if (channel === "contract_brewing") {
    // ── 5a. Packaging Fee lines ─────────────────────────────────────────────
    const kegFeeTransactionIds = new Set<string>();
    for (const tx of rows) {
      const isKeg = pkgTypeById.get(tx.packaging_item_id) === "keg";
      const containerName = pkgNameById.get(tx.packaging_item_id) ?? "unknown container";
      if (isKeg) kegFeeTransactionIds.add(tx.id);

      // Cans carry a case/loose format dimension on the mapping; kegs don't.
      const mapFormat = isKeg ? null : tx.packaging_format ?? "loose";
      const discountCatalogId = isKeg ? findMapping("bulk_discount", null)?.square_catalog_discount_id ?? null : null;

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
            description: caseMapping.display_name,
            quantity: wholeCases,
            unitPriceCents: priceByVariationId.get(caseMapping.square_catalog_variation_id) ?? 0,
            squareCatalogVariationId: caseMapping.square_catalog_variation_id,
            discountCatalogId,
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
            description: looseMapping.display_name,
            quantity: looseUnits,
            unitPriceCents: priceByVariationId.get(looseMapping.square_catalog_variation_id) ?? 0,
            squareCatalogVariationId: looseMapping.square_catalog_variation_id,
            discountCatalogId,
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
        description: mapping.display_name,
        quantity: tx.quantity,
        unitPriceCents: priceByVariationId.get(mapping.square_catalog_variation_id) ?? 0,
        squareCatalogVariationId: mapping.square_catalog_variation_id,
        discountCatalogId,
      });
    }

    // ── 5b. Excise Tax — one line per receiving_party, rolled up ─────────────
    lineItems.push(...await buildExciseTaxLines(supabase, transactionIds, rows));

    // ── 5c. Keg Cleaning — one line, qty = count of keg-type fee transactions ─
    if (kegFeeTransactionIds.size > 0) {
      const mapping = findMapping("keg_cleaning", null);
      if (mapping?.square_catalog_variation_id) {
        lineItems.push({
          id: crypto.randomUUID(),
          description: mapping.display_name,
          quantity: kegFeeTransactionIds.size,
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
    dueDays,
  };
}
