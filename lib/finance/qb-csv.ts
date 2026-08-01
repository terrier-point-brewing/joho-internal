/**
 * QuickBooks invoice CSV parser.
 *
 * QB Online exports invoices as a flat CSV where each row is one line item,
 * and multiple rows share the same invoice number. This parser:
 *   1. Parses raw CSV text into row objects keyed by the user-provided column map.
 *   2. Groups rows by invoice number.
 *   3. Assembles InvoiceImportPayload objects ready to POST.
 *
 * Designed to be run client-side (no Node dependencies).
 */

import { normalizeStatus } from "@/lib/finance/classify";
import { parseCsvRows } from "@/lib/finance/csv";
import type { InvoiceImportPayload } from "@/types/finance";

// ── Header/body split ─────────────────────────────────────────────────────────

// Tokenizing moved to lib/finance/csv.ts, shared with the chart-of-accounts
// import. Behaviour here is unchanged except that a quoted field may now span
// a line break -- the old line-at-a-time loop could not see past a newline.
function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const result = parseCsvRows(text);
  if (result.length === 0) return { headers: [], rows: [] };
  return { headers: result[0], rows: result.slice(1) };
}

// ── Column auto-detection ─────────────────────────────────────────────────────

export interface ColumnMap {
  invoice_number: string;
  invoice_date:   string;
  due_date:       string;
  customer_name:  string;
  description:    string;
  quantity:       string;
  unit_price:     string;
  amount:         string;
  status:         string;
}

type ColumnMapKey = keyof ColumnMap;

const COLUMN_HINTS: Record<ColumnMapKey, string[]> = {
  invoice_number: ["num", "invoice no", "invoice number", "invoice #", "txn number"],
  invoice_date:   ["date", "invoice date", "txn date", "transaction date"],
  due_date:       ["due date", "due"],
  customer_name:  ["customer", "name", "client", "bill to"],
  description:    ["product/service", "product", "service", "item", "memo", "description", "memo/description"],
  quantity:       ["qty", "quantity"],
  unit_price:     ["rate", "unit price", "price", "unit cost"],
  amount:         ["amount", "total", "line total"],
  status:         ["status", "invoice status", "balance status"],
};

export function autoDetectColumns(headers: string[]): ColumnMap {
  const lower = headers.map((h) => h.toLowerCase().trim());
  const result: Partial<ColumnMap> = {};

  for (const [field, hints] of Object.entries(COLUMN_HINTS) as [ColumnMapKey, string[]][]) {
    const match = lower.findIndex((h) => hints.some((hint) => h.includes(hint)));
    result[field] = match >= 0 ? headers[match] : "";
  }

  return result as ColumnMap;
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

function parseMoney(s: string): number {
  // Strip $, commas, parentheses (QB uses parens for negatives)
  const neg = s.trim().startsWith("(") || s.trim().startsWith("-");
  const n = parseFloat(s.replace(/[$,()]/g, "").trim());
  return isNaN(n) ? 0 : neg ? -Math.abs(n) : n;
}

function parseDate(s: string): string | null {
  if (!s) return null;
  // Common QB formats: M/D/YYYY, MM/DD/YYYY, YYYY-MM-DD
  const parts = s.split(/[/\-]/);
  if (parts.length !== 3) return null;

  let y: number, m: number, d: number;
  if (parts[0].length === 4) {
    [y, m, d] = parts.map(Number);
  } else {
    [m, d, y] = parts.map(Number);
  }

  if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface ParseResult {
  invoices: InvoiceImportPayload[];
  skipped:  number;   // rows without an invoice number
  warnings: string[];
}

export function buildImportPayloads(
  csvText: string,
  colMap: ColumnMap,
): ParseResult {
  const { headers, rows } = parseCSV(csvText);
  if (!headers.length) return { invoices: [], skipped: 0, warnings: ["CSV is empty"] };

  // Index into the header array
  function idx(col: string): number {
    return headers.findIndex((h) => h === col);
  }
  function get(row: string[], col: string): string {
    const i = idx(col);
    return i >= 0 ? (row[i] ?? "").trim() : "";
  }

  // Group rows by invoice number
  const groups = new Map<string, { header: string[]; lines: string[][] }>();

  let skipped = 0;
  for (const row of rows) {
    const invNum = get(row, colMap.invoice_number).trim();
    if (!invNum) { skipped++; continue; }

    if (!groups.has(invNum)) {
      groups.set(invNum, { header: row, lines: [] });
    }
    groups.get(invNum)!.lines.push(row);
  }

  const invoices: InvoiceImportPayload[] = [];
  const warnings: string[] = [];

  for (const [invNum, { header, lines }] of groups) {
    const customerName = get(header, colMap.customer_name) || "Unknown";
    const invoiceDate  = parseDate(get(header, colMap.invoice_date));
    const dueDate      = parseDate(get(header, colMap.due_date));
    const status       = normalizeStatus(get(header, colMap.status));

    let totalCents = 0;
    const lineItems: InvoiceImportPayload["line_items"] = [];

    lines.forEach((row, i) => {
      const description    = get(row, colMap.description) || "(no description)";
      const quantity       = parseFloat(get(row, colMap.quantity)) || 1;
      const unitPriceDollars = parseMoney(get(row, colMap.unit_price));
      const amountDollars  = parseMoney(get(row, colMap.amount));

      const totalLineCents    = Math.round(amountDollars * 100);
      const unitPriceCents    = Math.round(unitPriceDollars * 100);

      totalCents += totalLineCents;

      // Preserve the raw row as a string map for auditability
      const rawData: Record<string, string> = {};
      headers.forEach((h, hi) => { rawData[h] = row[hi] ?? ""; });

      lineItems.push({
        sort_order:       i,
        description,
        quantity,
        unit_price_cents: unitPriceCents,
        total_cents:      totalLineCents,
        raw_data:         rawData,
      });
    });

    if (lineItems.length === 0) {
      warnings.push(`Invoice ${invNum} has no line items — skipped`);
      continue;
    }

    // Raw snapshot of the first row for the invoice header
    const rawInvoice: Record<string, string> = {};
    headers.forEach((h, hi) => { rawInvoice[h] = header[hi] ?? ""; });

    invoices.push({
      source:         "quickbooks",
      external_id:    invNum,
      invoice_number: invNum,
      invoice_date:   invoiceDate,
      due_date:       dueDate,
      customer_name:  customerName,
      status,
      subtotal_cents: totalCents,
      tax_cents:      0,
      total_cents:    totalCents,
      notes:          null,
      raw_data:       rawInvoice,
      line_items:     lineItems,
    });
  }

  return { invoices, skipped, warnings };
}
