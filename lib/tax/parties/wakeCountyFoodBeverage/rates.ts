/**
 * Wake County — Prepared Food & Beverage Tax — statutory rate + reference.
 *
 * Zero server imports so this stays importable by both the pure
 * ./fieldOwnership.ts module (client-safe) and the server ./calc.ts / ./template.ts.
 */
import type { ReferenceSpec } from "@/lib/tax/types";

/** Canonical tax_rates key for the Wake County prepared food & beverage rate. */
export const WAKE_FB_RATE_KEY = "wake_county_food_beverage_tax";

/** Statutory 1% rate — fallback used only when the tax_rates row is missing. */
export const WAKE_FB_RATE_FALLBACK = 0.01;

export const WAKE_FB_REFERENCE: ReferenceSpec = {
  tables: [
    {
      title: "Rate",
      columns: ["Rate", "Applies to"],
      rows: [["1.00%", "Applicable prepared food & beverage gross receipts"]],
    },
  ],
  notes: [
    "Filed monthly; due the 20th of the following month.",
    "1% of the sale price of prepared food and beverages sold at retail in Wake County (effective January 1, 1993), in addition to NC state sales tax.",
    "Applicable Gross Receipts = net sales of items carrying the Square Prepared Food & Beverage Tax line.",
    "The rate is read from the canonical tax_rates row (key wake_county_food_beverage_tax); the statutory 1% is used as a fallback only if that row is missing.",
  ],
};
