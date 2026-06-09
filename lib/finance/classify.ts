/**
 * Shared line-item classification logic for QB imports and Square sync.
 * Maps item names to the InvoiceLineCategory enum used by the ledger.
 */

import type { InvoiceLineCategory, InvoiceStatus } from "@/types/finance";

export function classifyLineItem(name: string): InvoiceLineCategory {
  const n = name.toLowerCase();
  if (n.includes("ingredient deposit") || n.includes("packaging material")) return "materials_packaging";
  if (n.includes("packaging fee"))   return "packaging_fees";
  if (
    n.includes("keg cleaning")       ||
    n.includes("forklift")           ||
    n.includes("keg transformation") ||
    n.includes("co2 refill")
  ) return "other_services";
  if (n.includes("barrel excise tax")) return "pass_through_taxes";
  return "other";
}

export function normalizeStatus(raw: string): InvoiceStatus {
  const s = raw.toLowerCase().trim();
  if (s === "draft")                               return "draft";
  if (s.includes("paid") || s.includes("closed")) return "paid";
  if (s.includes("void"))                         return "voided";
  if (s.includes("partial"))                      return "partial";
  if (s.includes("open") || s.includes("unpaid")) return "open";
  return "unknown";
}
