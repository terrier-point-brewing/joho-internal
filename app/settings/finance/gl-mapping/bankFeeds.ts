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

/**
 * Feeds whose importer decides a line's flow type for itself, at sync.
 *
 * Ramp's API says what a movement IS -- "Interest", "Deposit", "Vendor Payment",
 * "Withdrawal" -- so lib/finance/bankLedger.ts classifies every line as it
 * arrives and none is ever left `unclassified`. Plaid says nothing about intent,
 * so its Chase rows land unclassified and wait for a person or a rule.
 *
 * This matters on screen because a counterparty rule is FILL-NULLS-ONLY: it can
 * only classify a line that is still unclassified. On a self-classifying feed
 * there are none, so a Flow dropdown there is a control that cannot do anything
 * -- and a dropdown you can change with no effect is worse than no dropdown,
 * because it reads as a decision being recorded.
 *
 * Listed rather than derived: whether an importer classifies is a fact about
 * that importer's code, and there is nothing on a row to infer it from. A feed
 * added later is assumed NOT to classify, which is the safe default -- it offers
 * a control that works rather than hiding one that would have.
 */
const SELF_CLASSIFYING_FEEDS = new Set(["ramp"]);

export function feedClassifiesOwnLines(source: string): boolean {
  return SELF_CLASSIFYING_FEEDS.has(source);
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
