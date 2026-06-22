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
}

const DEFAULT_DUE_DAYS = 30;

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
    .select("id, recipient_id, status, quantity, volume_bbl, packaging_item_id")
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

  // ── 3. Load packaging items (for type='keg' detection) ────────────────────
  const packagingItemIds = [...new Set(rows.map((r) => r.packaging_item_id))];
  const { data: pkgItems } = await supabase
    .from("packaging_items")
    .select("id, type")
    .in("id", packagingItemIds);
  const pkgTypeById = new Map((pkgItems ?? []).map((p) => [p.id, p.type as string]));

  // ── 4. Load service mappings for this partner (with default fallback) ────
  const { data: mappings } = await supabase
    .from("export_service_mappings")
    .select("service_type, partner_id, packaging_item_id, square_catalog_item_id, square_catalog_variation_id, square_catalog_discount_id, display_name")
    .or(`partner_id.eq.${customerId},partner_id.is.null`);

  function findMapping(serviceType: string, packagingItemId: string | null) {
    const rows2 = mappings ?? [];
    const partnerRow = rows2.find(
      (m) => m.service_type === serviceType && m.partner_id === customerId && m.packaging_item_id === packagingItemId
    );
    if (partnerRow) return partnerRow;
    return rows2.find(
      (m) => m.service_type === serviceType && m.partner_id === null && m.packaging_item_id === packagingItemId
    );
  }

  // ── 5. Resolve Square catalog prices for whatever variation IDs we need ──
  const catalogItems = await fetchCatalogItems();
  const priceByVariationId = buildStandalonePriceMap(catalogItems);

  const lineItems: InvoiceLineItemDraft[] = [];

  // ── 5a. Packaging Fee — one line per transaction ──────────────────────────
  const kegFeeTransactionIds = new Set<string>();
  for (const tx of rows) {
    const mapping = findMapping("packaging_fee", tx.packaging_item_id);
    if (!mapping?.square_catalog_variation_id) continue;
    const unitPriceCents = priceByVariationId.get(mapping.square_catalog_variation_id) ?? 0;
    const isKeg = pkgTypeById.get(tx.packaging_item_id) === "keg";
    if (isKeg) kegFeeTransactionIds.add(tx.id);
    lineItems.push({
      id: crypto.randomUUID(),
      description: mapping.display_name,
      quantity: tx.quantity,
      unitPriceCents,
      squareCatalogVariationId: mapping.square_catalog_variation_id,
      discountCatalogId: isKeg ? findMapping("bulk_discount", null)?.square_catalog_discount_id ?? null : null,
    });
  }

  // ── 5b. Excise Tax — one line per receiving_party, rolled up ──────────────
  const { data: taxRows } = await supabase
    .from("export_transaction_taxes")
    .select("export_transaction_id, amount_usd, excise_tax_rate_id")
    .in("export_transaction_id", transactionIds);

  if (taxRows && taxRows.length > 0) {
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

    for (const [party, entry] of byParty) {
      lineItems.push({
        id: crypto.randomUUID(),
        description: `Excise Tax — ${party} (${entry.units.toFixed(2)} ${entry.unit}${entry.units !== 1 ? "s" : ""})`,
        quantity: 1,
        unitPriceCents: entry.amountCents,
        squareCatalogVariationId: entry.variationId,
      });
    }
  }

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

  // ── 5d. Forklift — one flat line, regardless of transaction count ────────
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

  return {
    customerId,
    customerName: partner.company_name,
    squareCustomerId: partner.square_customer_id,
    lineItems,
    dueDays,
  };
}
