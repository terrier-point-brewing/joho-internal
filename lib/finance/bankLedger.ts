/**
 * Bank-account ledger: classify each Ramp bank line into a flow_type that decides
 * (a) which table it lands in and (b) how statements treat it. This is the anti-
 * drift core — settlements (Vendor Payment, card payment) are excluded so the
 * underlying bill/card records aren't double-counted, and only direct external
 * debits become expenses. Anything unrecognized is `unclassified` for review.
 */
import { normalizeCounterparty, type RampBankLine } from "@/lib/ramp";

export type FlowType =
  | "operating_expense"
  | "interest_income"
  | "internal_transfer"
  | "bill_settlement"
  | "card_settlement"
  | "deposit"
  | "unclassified";

export interface BankClassification {
  flow_type:         FlowType;
  affects_pl:        boolean;
  is_expense:        boolean;   // true ⇒ routes to `expenses`; else `ramp_bank_ledger`
  direction:         "inflow" | "outflow";
  counterparty_name: string;
  counterparty_key:  string;
}

/** True when a name looks like a Ramp card account (card-balance payment target). */
function isRampCard(name: string): boolean {
  return /ramp/i.test(name);
}

export function classifyBankLine(line: RampBankLine, ownAccounts: Set<string>): BankClassification {
  const desc    = line.description.trim();
  const destKey = normalizeCounterparty(line.destination_account_name);
  const srcKey  = normalizeCounterparty(line.source_account_name);
  const destOwn = destKey !== "" && ownAccounts.has(destKey);

  const make = (flow_type: FlowType, affects_pl: boolean, direction: "inflow" | "outflow", partyName: string): BankClassification => ({
    flow_type,
    affects_pl,
    is_expense: flow_type === "operating_expense",
    direction,
    counterparty_name: partyName,
    counterparty_key:  normalizeCounterparty(partyName),
  });

  if (desc === "Interest") return make("interest_income", true, "inflow", line.source_account_name ?? "Interest");
  if (desc === "Deposit")  return make("deposit", false, "inflow", line.source_account_name ?? "");
  if (desc === "Vendor Payment") return make("bill_settlement", false, "outflow", line.destination_account_name ?? "");

  if (desc === "Withdrawal") {
    const dest = line.destination_account_name ?? "";
    if (destKey === "") return make("unclassified", false, "outflow", "");
    if (destOwn) return make("internal_transfer", false, "outflow", dest);
    if (isRampCard(dest)) return make("card_settlement", false, "outflow", dest);
    return make("operating_expense", true, "outflow", dest);
  }

  // Unknown description — surface for manual review, never auto-book.
  return make("unclassified", false, srcKey && !ownAccounts.has(srcKey) ? "inflow" : "outflow", line.destination_account_name ?? line.source_account_name ?? "");
}
