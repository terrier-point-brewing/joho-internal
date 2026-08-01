/**
 * The one CSV tokenizer the finance importers share.
 *
 * There were two before this: a quote-aware one private to qb-csv.ts, and a
 * `line.split(",")` in the chart-of-accounts upload screen. The second one
 * silently mis-parsed any export with a comma inside a quoted field -- every
 * column after it shifted one to the left, so an account's TYPE could be read
 * out of its description. QuickBooks quotes freely, so this was reachable with
 * an ordinary export.
 *
 * This scanner walks the whole text rather than splitting on newlines first,
 * which is what lets a quoted field contain a line break. Both importers now
 * get that; the old line-based version could not.
 *
 * Rules, matching RFC 4180 as far as the exporters actually use it:
 *   * `,` separates fields, except inside quotes.
 *   * `"` toggles quoting; `""` inside a quoted field is a literal quote.
 *   * CR, LF and CRLF all end a record, except inside quotes.
 *   * Cells are trimmed, and a record whose cells are all empty is dropped --
 *     both behaviours the previous parsers had, and trailing blank lines are
 *     the common case they exist for.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuote = false;

  const endCell = () => { row.push(cell.trim()); cell = ""; };
  const endRow = () => {
    endCell();
    if (row.some((c) => c !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuote) {
      if (ch === '"') {
        // A doubled quote is an escaped literal; a lone one closes the field.
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuote = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') { inQuote = true; }
    else if (ch === ",") { endCell(); }
    else if (ch === "\r") {
      // Consume the LF of a CRLF pair so it doesn't open an empty record.
      if (text[i + 1] === "\n") i++;
      endRow();
    }
    else if (ch === "\n") { endRow(); }
    else { cell += ch; }
  }

  // Whatever is buffered when the text runs out is the last record, unless the
  // file ended on a newline and left nothing behind.
  if (cell !== "" || row.length > 0) endRow();

  return rows;
}
