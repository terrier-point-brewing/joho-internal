/**
 * Every string a partner reads on a generated Square invoice, in one place.
 *
 * House rules: name the beer or the company and nothing else. Shares,
 * volumes, yields and exclusions stay in the ledger and the operator modals —
 * a number on an invoice reads as a promise, and the derivation changes with
 * shrinkage.
 */

export function exportInvoiceTitle(companyName: string): string {
  return `Export Invoice — ${companyName}`;
}

export function depositInvoiceTitle(beerName: string): string {
  return `Ingredient Deposit — ${beerName}`;
}

export function depositInvoiceDescription(beerName: string): string {
  return `Ingredient deposit for your ${beerName} batch.`;
}
