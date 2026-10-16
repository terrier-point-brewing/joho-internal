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

/**
 * What the form can offer beside the sentence: flip to the kind that works, or
 * go to where the account's calculation is set up. The UI renders the chip; the
 * sentence stays one line.
 */
export type ManualEntryEffectAction =
  | { kind: "switch"; to: ManualEntryKind }
  | { kind: "settings" };

export type ManualEntryEffect =
  | { level: "ok" }
  | { level: "warn"; message: string; action?: ManualEntryEffectAction }
  | { level: "info"; message: string; action?: ManualEntryEffectAction };

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
      message: "No calculation reads this account yet — the entry saves now and counts once one is set up.",
      action: { kind: "settings" },
    };
  }

  if (accepted.includes(entryKind)) return { level: "ok" };

  const alternative = accepted[0];
  if (!alternative) {
    return {
      level: "warn",
      message: "This account's source ignores both kinds of entry — it will be recorded, but the balance sheet will not move.",
    };
  }

  return {
    level: "warn",
    message:
      alternative === "balance"
        ? `A ${KIND_NOUN[entryKind]} will not change this feed-reported account. Switch to Balance to override that month only.`
        : `A ${KIND_NOUN[entryKind]} will not change this summed account. Switch to Transaction — it will carry forward, so enter it once.`,
    action: { kind: "switch", to: alternative },
  };
}
