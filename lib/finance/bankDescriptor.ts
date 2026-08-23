/**
 * Who a bank line is with, read out of the bank's own descriptor.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * A counterparty rule is looked up by (feed, counterparty_key), and
 * counterpartyKeyOf() derives that key from `counterparty_name`. Plaid supplies
 * one for a minority of Chase lines -- 9 of 48 at the time this was written --
 * because its enrichment only recognises consumer-facing merchants. Everything
 * else arrives with a null name, which means no key, which means no rule can
 * ever match it however carefully somebody writes one. Those rows sit in the
 * grid permanently unclassified and get hand-coded every month.
 *
 * The information is right there in the descriptor. An ACH credit or debit
 * carries the originator's own company name in a named field:
 *
 *   ORIG CO NAME:Square Inc ORIG ID:9424300002 DESC DATE:260723
 *   CO ENTRY DESCR:SQ260723 SEC:PPD TRACE#:021000028611043 EED:260723
 *   IND ID: IND NAME:TERRIER POINT BREWING TRN: 2048611043TC
 *
 * ── Match the FIELD, never a substring ───────────────────────────────────────
 * The discipline here is the one squareSweeps.ts argues for at length: anchor to
 * a named field, never search the blob loose. `IND NAME` is the RECIPIENT, so a
 * loose search for a name finds our own business on every row; `TRACE#`, `TRN`
 * and `CO ENTRY DESCR` all embed per-transaction junk. Only `ORIG CO NAME` is
 * the other party, and only when read as a field.
 *
 * ── Why specific patterns run before Plaid's own enrichment ──────────────────
 * Order is load-bearing, not a preference.
 *
 * Ramp originates three completely different movements under one ACH company id
 * (9186939000) and three near-identical company names: funding the Ramp wallet
 * from Chase, settling the Ramp card statement, and reimbursing an employee.
 * Those are an internal transfer, a card settlement and an operating expense --
 * three different flows and three different accounts. Any enrichment that
 * collapses them to "Ramp" hands all three the rule written for whichever one
 * somebody configured first, and the resulting mis-coding is invisible: every
 * row looks confidently mapped.
 *
 * So the specific patterns, which encode a distinction no feed makes, are tried
 * first. Plaid's enrichment is tried next, because where it exists it is cleaner
 * prose than the raw field. The generic ORIG CO NAME capture is the last resort.
 *
 * ── What deliberately yields nothing ─────────────────────────────────────────
 * `CHECK # 1002` and a domestic wire name no counterparty a machine can read. A
 * check number is not a payee, and inventing "Check" as a counterparty would
 * invite a rule that codes every future cheque to one account. Those rows return
 * null and stay a human's job -- which is the correct outcome, not a gap.
 */

/** One descriptor shape whose counterparty a feed cannot be trusted to name. */
interface DescriptorPattern {
  /** Anchored to a named field or a full-line form, never a loose substring. */
  test: RegExp;
  /**
   * The counterparty this yields. A function when the descriptor carries the
   * distinguishing part (an account's last four), a constant otherwise.
   */
  name: string | ((m: RegExpMatchArray) => string);
}

/**
 * Tried in order, before any feed-supplied name. Each entry exists because the
 * feed's own answer would be wrong or absent, not merely uglier.
 */
const SPECIFIC: DescriptorPattern[] = [
  {
    // Chase -> Ramp wallet. The money has not left the business.
    test: /RAMP\s+WALLET\s+DEPOSIT/i,
    name: "Ramp Wallet",
  },
  {
    // Paying off the Ramp card statement. The charges are already expenses.
    test: /ORIG\s*CO\s*NAME\s*:\s*RAMP\s+STATEMENT\b/i,
    name: "Ramp Card Statement",
  },
  {
    // `ORIG CO NAME:RMPR W Liao` — a Ramp reimbursement, one company name per
    // employee. Collapsed to one counterparty on purpose: a new hire must not
    // create a new unmapped counterparty that silently needs its own rule.
    test: /ORIG\s*CO\s*NAME\s*:\s*RMPR\s+\S/i,
    name: "Ramp Reimbursement",
  },
  {
    // Penny pairs a provider sends to prove it can reach the account. They net
    // to zero and are never business activity.
    // No trailing \b: Chase runs the next field name straight onto this one
    // ("CO ENTRY DESCR:ACCTVERIFYSEC:CCD"), so a closing word boundary never
    // matches. Anchoring to CO ENTRY DESCR instead would miss the real-time
    // transfer form, which carries it under TEXT-RmtInf- instead.
    test: /\bACCTVERIFY/i,
    name: "Account Verification",
  },
  {
    // `Online Transfer from CHK ...9652` / `to SAV ...1915`. Keyed by the last
    // four so two of the business's own accounts stay distinguishable — someone
    // may well want the savings sweep coded differently from the operating one.
    test: /^Online Transfer (?:from|to) (?:CHK|SAV|MMA)\s*\.*\s*(\d{4})\b/i,
    name: (m) => `Chase ····${m[1]}`,
  },
  {
    test: /^Zelle payment (?:from|to)\b/i,
    name: "Zelle",
  },
];

/**
 * The generic ACH originator field. Run only after a feed's own enrichment,
 * because where the feed has a name it is the tidier of the two.
 *
 * Bounded by the next named field rather than by whitespace: a company name may
 * contain spaces ("DELUXE BUS SYS.", "INTUIT 31134643"). `ORIG ID` is the field
 * that always follows in Chase's format; `DESC DATE` and `CO ENTRY DESCR` are
 * accepted as terminators too, because banks vary in which fields they pass
 * through and a name running to the end of the blob would swallow the trace
 * number.
 */
const ORIG_CO_NAME = /ORIG\s*CO\s*NAME\s*:\s*(.+?)\s+(?:ORIG\s*ID|DESC\s*DATE|CO\s*ENTRY\s*DESCR|SEC)\s*:/i;

/**
 * Trailing digits some originators append to their own name to identify a
 * product or a sub-account -- "INTUIT 31134643", "INTUIT 27275143" are the same
 * counterparty. Stripped so they resolve to one rule rather than one per
 * invoice. A name that is ONLY digits keeps them; there would be nothing left.
 */
function stripOriginatorSuffix(name: string): string {
  const stripped = name.replace(/\s+\d{4,}$/, "").trim();
  return stripped.length > 0 ? stripped : name.trim();
}

/**
 * A counterparty from a descriptor, or null when the descriptor genuinely names
 * none. Applied BEFORE a feed's own enrichment.
 */
export function specificCounterpartyFromDescriptor(description: string | null | undefined): string | null {
  if (!description) return null;
  for (const pattern of SPECIFIC) {
    const m = description.match(pattern.test);
    if (m) return typeof pattern.name === "function" ? pattern.name(m) : pattern.name;
  }
  return null;
}

/**
 * The ACH originator's company name, or null. Applied AFTER a feed's own
 * enrichment, as the last resort before giving up.
 */
export function originatorCounterpartyFromDescriptor(description: string | null | undefined): string | null {
  if (!description) return null;
  const m = description.match(ORIG_CO_NAME);
  if (!m) return null;
  const name = stripOriginatorSuffix(m[1]);
  return name.length > 0 ? name : null;
}

/**
 * The whole chain, for a row that has already been imported: specific patterns,
 * then whatever the feed stored, then the originator field.
 *
 * `existing` comes first among the fallbacks rather than winning outright,
 * because the specific patterns encode distinctions the feed does not make --
 * see the note at the top about Ramp's three movements.
 */
export function counterpartyFromDescriptor(
  description: string | null | undefined,
  existing?: string | null,
): string | null {
  return specificCounterpartyFromDescriptor(description)
    ?? (existing?.trim() || null)
    ?? originatorCounterpartyFromDescriptor(description);
}
