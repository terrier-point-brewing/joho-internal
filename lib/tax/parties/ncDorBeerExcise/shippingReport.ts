/**
 * NC DOR Malt Beverage Shipping Report (Form B-C-715) — the per-invoice
 * schedule a resident brewery files WITH its B-C-710, listing the month's
 * sales to NC wholesalers (the gallons B-C-710 deducts on Line 4a).
 *
 * One line per invoice: invoice date, invoice number, the wholesaler's name
 * and address, and the gallons on it. The lines are stored on the B-C-710
 * worksheet as a JSON string under `SHIPPING_REPORT_FIELD` (worksheet fields
 * are flat scalars), so they're snapshotted with the rest of the filing and
 * frozen once the task is completed.
 *
 * Deliberately zero server imports — the worksheet UI parses the same field.
 */
import { GALLONS_PER_BBL } from "@/lib/constants/production";

/** Worksheet field key holding the JSON-encoded `ShippingReportLine[]`. */
export const SHIPPING_REPORT_FIELD = "bc715_lines";

export interface ShippingReportLine {
  invoiceDate: string; // YYYY-MM-DD
  invoiceNumber: string | null;
  name: string | null;
  address: string | null;
  gallons: number;
}

/** One wholesale shipment row, already flattened from its invoice/recipient joins. */
export interface ShippingReportRow {
  /** Groups rows onto one line: the invoice id, else the shipment id. */
  groupKey: string;
  shippedAt: string; // ISO timestamp — the date used when there's no invoice yet
  invoiceDate: string | null;
  invoiceNumber: string | null;
  name: string | null;
  address: string | null;
  volumeBbl: number;
}

/**
 * Collapse wholesale shipment rows into one line per invoice (per shipment
 * when not yet invoiced), ordered by date then invoice number.
 *
 * `totalGallons` is B-C-710's wholesale figure (Line 4a), which rounds the
 * month's barrels once. Each line rounds on its own, so the lines can land a
 * gallon or two off that total — the difference rides on the last line so the
 * B-C-715 total always ties to the deduction it supports.
 */
export function buildShippingReportLines(rows: ShippingReportRow[], totalGallons: number): ShippingReportLine[] {
  const groups = new Map<string, { line: Omit<ShippingReportLine, "gallons">; bbl: number }>();

  for (const row of rows) {
    const g = groups.get(row.groupKey);
    if (g) {
      g.bbl += row.volumeBbl;
      g.line.name ??= row.name;
      g.line.address ??= row.address;
      continue;
    }
    groups.set(row.groupKey, {
      line: {
        invoiceDate: row.invoiceDate ?? row.shippedAt.slice(0, 10),
        invoiceNumber: row.invoiceNumber,
        name: row.name,
        address: row.address,
      },
      bbl: row.volumeBbl,
    });
  }

  const lines = [...groups.values()]
    .map((g) => ({ ...g.line, gallons: Math.round(g.bbl * GALLONS_PER_BBL) }))
    .sort(
      (a, b) =>
        a.invoiceDate.localeCompare(b.invoiceDate) || (a.invoiceNumber ?? "").localeCompare(b.invoiceNumber ?? ""),
    );

  if (lines.length > 0) {
    const sum = lines.reduce((s, l) => s + l.gallons, 0);
    lines[lines.length - 1].gallons += totalGallons - sum;
  }
  return lines;
}

/** Read the lines back off a worksheet field. Missing/malformed → no lines. */
export function parseShippingReportLines(value: number | string | null | undefined): ShippingReportLine[] {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as ShippingReportLine[]) : [];
  } catch {
    return [];
  }
}
