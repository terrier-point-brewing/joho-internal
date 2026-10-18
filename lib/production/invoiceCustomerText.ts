/**
 * Every string a partner reads on a generated Square invoice, in one place.
 *
 * House rule for titles and export lines: name the beer or the company and
 * nothing else. The one exception is the standalone deposit invoice's
 * description, which spells out how the figure was arrived at —
 * see depositInvoiceDescription in depositInvoiceNote.ts.
 */

export function exportInvoiceTitle(companyName: string): string {
  return `Export Invoice — ${companyName}`;
}

export function depositInvoiceTitle(beerName: string): string {
  return `Ingredient Deposit — ${beerName}`;
}
