/**
 * Chart-of-accounts CSV import — turning a QuickBooks Online account-list
 * export into rows the /api/finance/chart-of-accounts POST accepts.
 *
 * Lifted out of the settings screen so it can be tested. It is pure text in,
 * rows out: no fetch, no React, no DOM. The screen keeps the file picker and
 * the diff preview, which is the part a person actually has to look at.
 *
 * Tokenizing is `parseCsvRows` (lib/finance/csv.ts) rather than a local split,
 * so a quoted description containing a comma no longer shifts every column
 * after it -- see that file for what the old parser got wrong.
 */
import { parseCsvRows } from "./csv";

export interface ParsedCoaRow {
  account_name: string;
  account_number: string | null;
  account_type: string;
  detail_type: string | null;
  description: string | null;
  is_active: boolean;
}

/**
 * Header aliases across QBO's export variants. First match wins, so a file
 * carrying both "Name" and "Account Name" binds to whichever comes first
 * rather than silently preferring one.
 */
const HEADER_MAP: Record<string, keyof ParsedCoaRow> = {
  "name":           "account_name",
  "account name":   "account_name",
  "account":        "account_name",
  "number":         "account_number",
  "account number": "account_number",
  "account no":     "account_number",
  "account no.":    "account_number",
  "type":           "account_type",
  "account type":   "account_type",
  "detail type":    "detail_type",
  "subtype":        "detail_type",
  "description":    "description",
  "active":         "is_active",
};

/** QBO writes this column as Yes/No; anything blank is treated as active. */
function parseActive(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === "" || v === "yes" || v === "true" || v === "1";
}

export function parseCoaCsv(text: string): { rows: ParsedCoaRow[]; warnings: string[] } {
  const records = parseCsvRows(text);
  if (records.length < 2) return { rows: [], warnings: ["CSV is empty or has no data rows."] };

  const [headerRow, ...bodyRows] = records;
  const colIndex: Partial<Record<keyof ParsedCoaRow, number>> = {};
  headerRow.forEach((h, i) => {
    const mapped = HEADER_MAP[h.trim().toLowerCase()];
    if (mapped && !(mapped in colIndex)) colIndex[mapped] = i;
  });

  const warnings: string[] = [];
  if (colIndex.account_name === undefined) warnings.push("Could not find an account name column.");
  if (colIndex.account_type === undefined) warnings.push("Could not find an account type column.");

  const rows: ParsedCoaRow[] = [];
  let skipped = 0;

  for (const cells of bodyRows) {
    const get = (k: keyof ParsedCoaRow) =>
      colIndex[k] !== undefined ? (cells[colIndex[k]!] ?? "") : "";

    const account_name = get("account_name");
    const account_type = get("account_type");
    // Name and type are the two the server cannot default. A row missing
    // either is not an account, so it is dropped -- but counted, because a
    // file that silently loses half its rows is the failure worth seeing.
    if (!account_name || !account_type) { skipped++; continue; }

    rows.push({
      account_name,
      account_number: get("account_number") || null,
      account_type,
      detail_type:    get("detail_type") || null,
      description:    get("description") || null,
      is_active:      parseActive(get("is_active")),
    });
  }

  if (skipped > 0) {
    warnings.push(
      `${skipped} row${skipped === 1 ? "" : "s"} skipped — no account name or no account type.`,
    );
  }

  return { rows, warnings };
}
