/**
 * The small amount of shared vocabulary the two bank-feed-aware panels need.
 *
 * A bank feed is stored as a short code ("ramp", "plaid") because that is what
 * the importer writes into bank_ledger.source. A bookkeeper has never
 * heard of it, so nothing on screen shows the raw value — it is translated
 * here, once, and anything unrecognised is title-cased rather than hidden, so a
 * feed added later is still readable before anyone gets round to naming it.
 */

const FEED_NAMES: Record<string, string> = {
  ramp: "Ramp",
  // What the operator sees is the bank, not the plumbing that reads it. Plaid is
  // the service; Chase is the account whose transactions actually arrive.
  plaid: "Chase (via Plaid)",
};

export function feedName(source: string): string {
  return FEED_NAMES[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

/** "1 transaction" / "1,204 transactions", so no sentence has to say "transaction(s)". */
export function transactionCount(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "transaction" : "transactions"}`;
}

/** "March 2024 to June 2026", or null when nothing is dated. */
export function dateSpan(earliest: string | null, latest: string | null): string | null {
  if (!earliest || !latest) return null;
  const month = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const from = month(earliest);
  const to = month(latest);
  return from === to ? from : `${from} to ${to}`;
}
