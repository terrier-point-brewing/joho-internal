/**
 * QuickBooks invoice PDF parser (server-side, Node.js only).
 *
 * Uses pdf-parse to extract raw text, then applies targeted regexes and a
 * simple state machine to pull out invoice header fields and line items.
 *
 * Supports standard QB Online invoice templates. The parser is best-effort:
 * every field is nullable; callers should present parsed data for user review
 * before committing to the ledger.
 */

// Dynamic import avoids the pdf-parse test-file side-effect in Next.js
// (pdf-parse tries to read test files when first required at module level).
async function pdfParse(buffer: Buffer): Promise<{ text: string }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fn = require("pdf-parse") as (b: Buffer) => Promise<{ text: string }>;
  return fn(buffer);
}

import { normalizeStatus } from "@/lib/finance/classify";
import type { InvoiceImportPayload } from "@/types/finance";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip currency symbols/commas and parse to number (dollars). */
function parseMoney(s: string): number {
  const neg = s.includes("(") || s.trim().startsWith("-");
  const n   = parseFloat(s.replace(/[$,()]/g, "").trim());
  return isNaN(n) ? 0 : neg ? -Math.abs(n) : n;
}

/** Parse common QB date formats → YYYY-MM-DD or null. */
function parseDate(s: string): string | null {
  // MM/DD/YYYY or M/D/YYYY
  const slash = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slash) {
    const [, m, d, y] = slash;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // YYYY-MM-DD
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  // "January 15, 2024" / "Jan 15, 2024"
  const month: Record<string, string> = {
    january:"01",february:"02",march:"03",april:"04",may:"05",june:"06",
    july:"07",august:"08",september:"09",october:"10",november:"11",december:"12",
    jan:"01",feb:"02",mar:"03",apr:"04",jun:"06",jul:"07",aug:"08",
    sep:"09",oct:"10",nov:"11",dec:"12",
  };
  const long = s.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (long) {
    const [, mn, d, y] = long;
    const m = month[mn.toLowerCase()];
    if (m) return `${y}-${m}-${d.padStart(2, "0")}`;
  }
  return null;
}

// ── Line-item detection ───────────────────────────────────────────────────────
// QB Online exports line items in varied formats. We look for lines that:
//   - Have a trailing dollar amount (possibly preceded by qty and rate columns)
//   - Are not header/footer rows (DESCRIPTION, Subtotal, Total, Balance due, etc.)

const SKIP_PATTERNS = [
  /^(description|activity|qty|quantity|rate|amount|unit\s*price|service\s*date)/i,
  /^(subtotal|sub-total|discount|tax|total|balance\s*due|amount\s*due|payment)/i,
  /^(thank\s*you|terms|memo|message|note|po\s*number)/i,
  /^\s*$/,
];

function isSkipLine(line: string): boolean {
  return SKIP_PATTERNS.some((re) => re.test(line.trim()));
}

/**
 * Try to parse a text line as a line item.
 * Expected forms (QB Online):
 *   "Ingredient Deposit  1  500.00  500.00"
 *   "Packaging Fee  10  150.00  1,500.00"
 *   "Keg Cleaning Service  1  75.00  75.00"
 *   "Barrel Excise Tax  1  19.13  19.13"
 * Falls back to description-only if no amounts found.
 */
function parseLineItem(line: string): { description: string; quantity: number; unitPrice: number; amount: number } | null {
  const trimmed = line.trim();
  if (!trimmed || isSkipLine(trimmed)) return null;

  // Match: description  [qty  rate]  amount
  // Amount must be present; qty + rate are optional.
  const full = trimmed.match(
    /^(.+?)\s{2,}(\d[\d,]*(?:\.\d{1,2})?)\s+(\d[\d,]*(?:\.\d{1,2})?)\s+(\d[\d,]*(?:\.\d{1,2})?)$/
  );
  if (full) {
    return {
      description: full[1].trim(),
      quantity:    parseFloat(full[2].replace(",", "")),
      unitPrice:   parseMoney(full[3]),
      amount:      parseMoney(full[4]),
    };
  }

  // Two-column: description  amount
  const short = trimmed.match(/^(.+?)\s{2,}(\$?[\d,]+(?:\.\d{1,2})?)$/);
  if (short) {
    const amount = parseMoney(short[2]);
    if (amount > 0) {
      return { description: short[1].trim(), quantity: 1, unitPrice: amount, amount };
    }
  }

  return null;
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface PDFParseResult {
  /** Parsed invoice ready to POST, or null if parsing failed completely. */
  payload:  InvoiceImportPayload | null;
  /** Raw extracted text for debugging / manual fallback. */
  rawText:  string;
  warnings: string[];
}

export async function parseQBInvoicePDF(buffer: Buffer, filename: string): Promise<PDFParseResult> {
  const warnings: string[] = [];
  let rawText = "";

  try {
    const parsed = await pdfParse(buffer);
    rawText = parsed.text;
  } catch (e) {
    return {
      payload:  null,
      rawText:  "",
      warnings: [`Could not read PDF "${filename}": ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  const lines = rawText.split("\n").map((l) => l.trimEnd());

  // ── Invoice number ──────────────────────────────────────────────────────────
  let invoiceNumber: string | null = null;
  for (const line of lines) {
    const m = line.match(/invoice\s*(?:#|no\.?|number[:\s]*)\s*([A-Za-z0-9\-]+)/i);
    if (m) { invoiceNumber = m[1].trim(); break; }
  }
  if (!invoiceNumber) warnings.push("Could not detect invoice number — using filename");

  // Fall back to filename without extension
  const fallbackNum = filename.replace(/\.pdf$/i, "").replace(/[_\s]+/g, "-");
  invoiceNumber = invoiceNumber ?? fallbackNum;

  // ── Dates ───────────────────────────────────────────────────────────────────
  let invoiceDate: string | null = null;
  let dueDate:     string | null = null;

  for (const line of lines) {
    const lower = line.toLowerCase();
    // "Invoice date  01/15/2024" or "Invoice Date: January 15, 2024"
    if (!invoiceDate && (lower.includes("invoice date") || lower.includes("invoice date"))) {
      const dates = line.match(/(\d{1,2}\/\d{1,2}\/\d{4}|\w+ \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2})/g);
      if (dates) invoiceDate = parseDate(dates[0]);
    }
    // "Due date  02/14/2024" or "Payment due  ..."
    if (!dueDate && (lower.includes("due date") || lower.includes("payment due"))) {
      const dates = line.match(/(\d{1,2}\/\d{1,2}\/\d{4}|\w+ \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2})/g);
      if (dates) dueDate = parseDate(dates[0]);
    }
  }
  if (!invoiceDate) warnings.push("Could not detect invoice date");

  // ── Customer / Bill To ──────────────────────────────────────────────────────
  let customerName: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (/bill\s*to/i.test(lines[i])) {
      // Take the next non-empty line as the customer name
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const candidate = lines[j].trim();
        if (candidate && !/^(address|email|phone|\d)/i.test(candidate)) {
          customerName = candidate;
          break;
        }
      }
      break;
    }
  }
  if (!customerName) warnings.push("Could not detect customer name");

  // ── Status ─────────────────────────────────────────────────────────────────
  let status = "unknown";
  for (const line of lines) {
    const m = line.match(/\bstatus[:\s]+([A-Za-z]+)/i);
    if (m) { status = normalizeStatus(m[1]); break; }
    // QB puts "PAID" / "DRAFT" / "OVERDUE" in bold header text
    if (/^\s*(paid|draft|overdue|unpaid|closed)\s*$/i.test(line)) {
      status = normalizeStatus(line.trim());
      break;
    }
  }

  // ── Total ──────────────────────────────────────────────────────────────────
  let totalDollars = 0;
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes("balance due") || lower.includes("amount due") || lower.includes("total due")) {
      const m = line.match(/\$?([\d,]+(?:\.\d{2})?)/g);
      if (m) { totalDollars = parseMoney(m[m.length - 1]); break; }
    }
  }
  // Fallback: last line matching "Total  $X"
  if (!totalDollars) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/\btotal\b/i.test(lines[i])) {
        const m = lines[i].match(/\$?([\d,]+\.\d{2})/);
        if (m) { totalDollars = parseMoney(m[1]); break; }
      }
    }
  }

  // ── Line items ─────────────────────────────────────────────────────────────
  // Heuristic: look for the table region between the column headers and the
  // first subtotal/total line.
  let inTable    = false;
  let pastHeader = false;

  const lineItems: InvoiceImportPayload["line_items"] = [];

  for (const line of lines) {
    const lower = line.toLowerCase().trim();

    // Detect table header row
    if (!pastHeader && /description|activity/i.test(lower) && /amount/i.test(lower)) {
      inTable    = true;
      pastHeader = true;
      continue;
    }

    // Detect end of table
    if (inTable && /^(subtotal|sub-total|discount|tax\s*\(|total\b)/i.test(lower)) {
      inTable = false;
    }

    if (inTable && line.trim()) {
      const item = parseLineItem(line);
      if (item) {
        lineItems.push({
          sort_order:       lineItems.length,
          description:      item.description,
          quantity:         item.quantity,
          unit_price_cents: Math.round(item.unitPrice * 100),
          total_cents:      Math.round(item.amount   * 100),
          raw_data:         { source_line: line.trim() },
        });
      }
    }
  }

  if (lineItems.length === 0) {
    warnings.push("No line items detected — the PDF layout may not be supported");
  }

  // Derive total from line items if not found in PDF
  const derivedTotal = lineItems.reduce((s, li) => s + li.total_cents, 0);
  const totalCents   = totalDollars > 0 ? Math.round(totalDollars * 100) : derivedTotal;

  const payload: InvoiceImportPayload = {
    source:         "quickbooks",
    external_id:    invoiceNumber,
    invoice_number: invoiceNumber,
    invoice_date:   invoiceDate,
    due_date:       dueDate,
    customer_name:  customerName ?? "Unknown",
    status:         normalizeStatus(status),
    total_cents:    totalCents,
    subtotal_cents: totalCents,
    tax_cents:      0,
    notes:          null,
    raw_data:       { source_file: filename },
    line_items:     lineItems,
  };

  return { payload, rawText, warnings };
}
