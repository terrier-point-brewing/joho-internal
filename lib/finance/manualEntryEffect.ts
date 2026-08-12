/**
 * What a manual entry will actually DO to the account it is about to be saved
 * against — answered before it is saved.
 *
 * ── Why this needs saying at all ─────────────────────────────────────────────
 * The two kinds are not interchangeable, and until now picking the wrong one
 * failed silently. An entry against an account whose calculation does not read
 * that kind was accepted by the API, stored, listed in the ledger with its
 * label and its author, and then ignored by the balance sheet. Nothing errored.
 * The operator's only clue was a number that did not move, weeks later.
 *
 * GL 2410 Gift Card Liabilities and GL 3300 Retained Earnings were in exactly
 * that state for months. Both now read corrections, but the general problem
 * remains: a bank account wants a stated balance and ignores a transaction; a
 * tax liability wants a transaction and ignores a stated balance. Neither is a
 * fallback for the other, so the screen has to say which is which.
 *
 * Pure, and takes what a method DECLARES rather than an account id, so the
 * whole thing is testable without a database and cannot disagree with what the
 * engine does when the entry lands.
 */
import type { ManualEntryKind } from "./manualEntries";

export interface ManualEntryEffectInput {
  entryKind: ManualEntryKind;
  /**
   * The kinds this account's configured method reads, from
   * manualEntryKindsFor. Null when the account has no active source at all --
   * which is a THIRD answer, not a "no": nothing reads either kind yet, and the
   * entry is stored against a day when something will.
   */
  accepted: ManualEntryKind[] | null;
  /** For the advice sentence: what the other kind is called on screen. */
  accountLabel?: string;
}

export type ManualEntryEffect =
  | { level: "ok" }
  | { level: "warn"; message: string }
  | { level: "info"; message: string };

const KIND_NOUN: Record<ManualEntryKind, string> = {
  flow: "transaction",
  balance: "balance",
};

/**
 * Advice for the kind/account pair currently chosen in the form.
 *
 * "warn" is reserved for the case that actually loses work -- the entry will
 * save and do nothing -- and names the kind that would have worked, because
 * being told you are wrong without being told what is right is how somebody
 * ends up entering it both ways.
 */
export function manualEntryEffect(input: ManualEntryEffectInput): ManualEntryEffect {
  const { entryKind, accepted } = input;

  if (accepted === null) {
    return {
      level: "info",
      message:
        "This account has no calculation set up yet, so nothing reads this entry into the balance sheet. It will be saved and will start counting once the account is given a calculation under Settings, Finance, Balance Sheet Accounts.",
    };
  }

  if (accepted.includes(entryKind)) return { level: "ok" };

  const alternative = accepted[0];
  if (!alternative) {
    return {
      level: "warn",
      message:
        "This account's balance comes entirely from a source that neither kind of entry can change. Saving this will record it in the ledger, but the balance sheet will not move.",
    };
  }

  return {
    level: "warn",
    message:
      alternative === "balance"
        ? `This account's balance is reported by the service it is linked to, so a ${KIND_NOUN[entryKind]} entry will not change it. Switch to Balance to state this month's figure instead — it replaces the reported one for that month only.`
        : `This account adds up what is recorded against it, so a ${KIND_NOUN[entryKind]} entry will not change it. Switch to Transaction to record the correction as a movement — it will carry forward on its own, so it only needs entering once.`,
  };
}
