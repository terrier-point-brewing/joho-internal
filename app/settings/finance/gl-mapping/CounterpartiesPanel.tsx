"use client";
/**
 * Counterparty rules: what a named payee or payer IS, and where its account
 * comes from.
 *
 * ── Two questions, asked in order ────────────────────────────────────────────
 * A counterparty needs two things settled, and the second only matters given the
 * first:
 *
 *   1. What is this money?      -> `flow_type` (or an exclusion, see below)
 *   2. Where does the account
 *      come from?               -> `routing`, then `chart_of_accounts_id`
 *
 * Six of the eight answers to (1) end the conversation — a settlement, a
 * transfer, an exclusion and "leave for review" all use no account — so (2) and
 * (3) are not rendered at all. Only an expense, an income or a balance-sheet
 * movement carries the operator onward.
 *
 * ── What this replaced, and why ──────────────────────────────────────────────
 * The screen used to show four controls: In the books, Routing, Flow, Chart of
 * Accounts. At least one was always dead on every row, and WHICH one depended on
 * the bank feed — a column the panel hides when there is only one feed:
 *
 *   * `routing` is read by resolveExpenseMapping, which loads counterparty rules
 *     with .eq("source","ramp"). On a Plaid counterparty nothing reads it.
 *   * `flow_type` is applied by resolveBankBackfill, which only ever FILLS an
 *     unclassified row. Ramp classifies every line at import, so on a Ramp
 *     counterparty nothing can apply it.
 *
 * So an operator was choosing between two overlapping vocabularies, one of which
 * silently did nothing, with no way to tell which. Routing was never a kind of
 * movement; it was always the answer to "which account", and it now sits in the
 * control that asks that.
 *
 * "In the books" went the same way. It had drifted to a single user whose lines
 * were already internal transfers with no account — the same reported outcome by
 * a second mechanism — so it is now `Out of the books`, one option among the
 * eight, still writing bank_ledger_gl_rules. One control, whichever table the
 * answer lands in; that split is an implementation fact and was never the
 * operator's problem.
 *
 * ── Two shapes of "somewhere else", and the difference is visible ────────────
 *   chosen   -- the operator picks it, because nothing upstream knows about this
 *               counterparty. Payroll split: nothing in payroll settings names
 *               Gusto, so somebody has to say so here.
 *   claimed  -- the row arrives already answered and read-only, because the fact
 *               was stated elsewhere. Square: GL 1040's method already names the
 *               bank account Square pays into. Offering a dropdown would ask for
 *               the same fact twice with nothing keeping the two agreed.
 *
 * A claim answers "which account", NOT "what kind of movement" — which is why a
 * claimed counterparty still gets step 1. Square's Chase payouts sat unclassified
 * for want of that distinction.
 *
 * ── Why a counterparty is identified by its bank feed as well as its name ────
 * The same name on two bank accounts is not necessarily the same relationship,
 * and a bookkeeper may well code them differently, so each is its own row with
 * its own account. The bank-feed column keeps the two apart on screen, and is
 * hidden while there is only one feed.
 */
import { useState, useMemo, type ReactNode } from "react";
import AccountSelect, { type CoARef } from "@/app/finance/AccountSelect";
import Badge from "@/app/components/ui/Badge";
import SaveHint from "@/app/components/ui/SaveHint";
import type { Tone } from "@/app/components/ui/tone";
import MappingFrame from "./MappingFrame";
import { useMappingData } from "./useMappingData";
import { useBankFeedRules } from "./useBankFeedRules";
import { feedName } from "./bankFeeds";
import { counterpartyRowState, type RowState } from "./counterpartyRow";
import { SELECTABLE_HANDLERS, getCounterpartyHandler } from "@/lib/finance/counterpartyHandlers";
import {
  OUT_OF_BOOKS,
  TREATMENT_GROUPS,
  treatmentsInGroup,
  getTreatment,
  flowNeedsAccount,
} from "@/lib/finance/flowTypes";

const RULES_URL = "/api/finance/expense-counterparty-mappings";

interface CoaJoin { account_name: string; account_number: string | null }

/** Set by the server when something else already accounts for this counterparty. */
interface Claim {
  handler: string;
  badge: string;
  manageHref: string;
}

interface RuleRow {
  /** Null for a counterparty seen only in the bank ledger — no rule has been saved for it yet. */
  id: string | null;
  source: string;
  counterparty_key: string;
  counterparty_label: string;
  chart_of_accounts_id: string | null;
  auto_matched: boolean;
  chart_of_accounts: CoaJoin | null;
  routing: string;
  /** What kind of movement this counterparty's bank lines are. Null = no opinion. */
  flow_type: string | null;
  claim: Claim | null;
}

/**
 * What actually governs this row: a claim if there is one, else what was
 * stored. A claim wins outright — the stored value is a decision somebody took
 * before the calculation existed, and honouring it would be honouring an
 * out-of-date answer.
 */
function effectiveHandler(rule: RuleRow): { key: string; badge: string; manageHref: string } | null {
  if (rule.claim) return { key: rule.claim.handler, ...rule.claim };
  const handler = getCounterpartyHandler(rule.routing);
  if (!handler || handler.glEffect === "account") return null;
  return { key: handler.key, badge: handler.badge, manageHref: handler.manageHref };
}

/** (bank feed, counterparty) is the identity — see the note at the top of this file. */
function rowKey(r: { source: string; counterparty_key: string }): string {
  return `${r.source} ${r.counterparty_key}`;
}

export default function CounterpartiesPanel({ selector }: { selector?: ReactNode }) {
  const { accounts, rows, setRows, loading, error, setError } =
    useMappingData<RuleRow>(RULES_URL, "Failed to load counterparty accounts.");
  const feedRules = useBankFeedRules();
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const feedIncluded = useMemo(
    () => new Map(feedRules.feeds.map((f) => [f.source, f.included])),
    [feedRules.feeds],
  );
  const counterpartyIncluded = useMemo(
    () => new Map(feedRules.counterparties.map((c) => [rowKey(c), c.included])),
    [feedRules.counterparties],
  );

  // One bank account is the normal case and does not need a column telling the
  // operator which one they are looking at.
  const showFeed = new Set(rows.map((r) => r.source)).size > 1;

  async function patch(rule: RuleRow, body: Record<string, unknown>): Promise<boolean> {
    setSavingKey(rowKey(rule));
    const res = await fetch(RULES_URL, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: rule.source,
        counterparty_key: rule.counterparty_key,
        counterparty_label: rule.counterparty_label,
        ...body,
      }),
    });
    setSavingKey(null);
    if (!res.ok) {
      // The server's own sentence, when it has one. A refusal here is not a
      // failure — it is "something else already accounts for this, go and
      // change it there" — and flattening that to "could not save" would leave
      // the operator retrying a click that will never work.
      const body = await res.json().catch(() => null) as { error?: string } | null;
      setError(body?.error ?? "Could not save that change.");
      return false;
    }
    // The rule row may have just been created, so adopt whatever id came back.
    const saved = await res.json().catch(() => null) as { id?: string } | null;
    if (saved?.id) setRows((rs) => rs.map((r) => (rowKey(r) === rowKey(rule) ? { ...r, id: saved.id ?? null } : r)));
    return true;
  }

  async function handleSetRule(rule: RuleRow, coaId: string | null) {
    if (!(await patch(rule, { chart_of_accounts_id: coaId }))) return;
    const coa = accounts.find((a) => a.id === coaId);
    const join: CoaJoin | null = coa
      ? { account_name: coa.account_name, account_number: coa.account_number }
      : null;
    setRows((rs) => rs.map((r) => (rowKey(r) === rowKey(rule)
      ? { ...r, chart_of_accounts_id: coaId, auto_matched: false, chart_of_accounts: join }
      : r)));
  }

  async function handleSetRouting(rule: RuleRow, routing: string) {
    if (!(await patch(rule, { routing }))) return;
    setRows((rs) => rs.map((r) => (rowKey(r) === rowKey(rule) ? { ...r, routing } : r)));
  }

  /**
   * Step 1: what is this money?
   *
   * One control, two destinations. Every answer but one is a `flow_type` on the
   * counterparty rule; `out_of_books` is a `bank_ledger_gl_rules` exclusion. The
   * screen should not make an operator care which table holds which — that split
   * is an implementation fact, and surfacing it as two separate controls is what
   * made this panel hard to read.
   *
   * Switching AWAY from `out_of_books` re-includes the counterparty, so the
   * answer is never half-applied.
   */
  async function handleSetTreatment(rule: RuleRow, value: string) {
    const wasExcluded = counterpartyIncluded.get(rowKey(rule)) === false;

    if (value === OUT_OF_BOOKS) {
      // The flow is cleared with it: a hidden counterparty has no classification
      // to keep, and leaving one behind would resurface if it were ever included
      // again — as an answer nobody remembers giving.
      if (rule.flow_type !== null && !(await patch(rule, { flow_type: null }))) return;
      setRows((rs) => rs.map((r) => (rowKey(r) === rowKey(rule) ? { ...r, flow_type: null } : r)));
      await setIncluded(rule, false);
      return;
    }

    const flow_type = value === "" ? null : value;
    if (!(await patch(rule, { flow_type }))) return;
    const keepsAccount = flow_type === null || flowNeedsAccount(flow_type);
    setRows((rs) => rs.map((r) => (rowKey(r) === rowKey(rule)
      ? {
          ...r,
          flow_type,
          chart_of_accounts_id: keepsAccount ? r.chart_of_accounts_id : null,
          chart_of_accounts: keepsAccount ? r.chart_of_accounts : null,
        }
      : r)));
    if (wasExcluded) await setIncluded(rule, true);
  }

  async function setIncluded(rule: RuleRow, included: boolean) {
    const ok = await feedRules.save({
      scope: "counterparty",
      source: rule.source,
      counterparty_key: rule.counterparty_key,
      counterparty_label: rule.counterparty_label,
      included,
    });
    if (!ok) return;
    feedRules.setCounterparties((cs) => {
      const key = rowKey(rule);
      return cs.some((c) => rowKey(c) === key)
        ? cs.map((c) => (rowKey(c) === key ? { ...c, included, decided: true } : c))
        : [...cs, {
            source: rule.source,
            counterparty_key: rule.counterparty_key,
            counterparty_label: rule.counterparty_label,
            transaction_count: 0,
            included,
            decided: true,
          }];
    });
  }

  // ── The summary line ────────────────────────────────────────────────────────
  //
  // The denominator is "counterparties that will actually use an account", which
  // is exactly the rows where step 3 renders. Anything else counted would report
  // a shortfall no amount of work can close — a screen that can never say "done"
  // is one an operator learns to ignore.
  //
  // Bucketed by the SAME function the rows render from, so the count and the
  // controls cannot disagree. They were separate before, and the drift was
  // invisible: nothing fails when a summary says "3 of 7" over a table with four
  // pickers.
  const inclusion = useMemo(
    () => ({ feeds: feedIncluded, counterparties: counterpartyIncluded }),
    [feedIncluded, counterpartyIncluded],
  );
  const stateOf = (r: RuleRow) =>
    counterpartyRowState({ ...r, handledElsewhere: effectiveHandler(r) !== null }, inclusion);

  const buckets = rows.map(stateOf).map((s) => s.bucket);
  const count = (b: RowState["bucket"]) => buckets.filter((x) => x === b).length;
  const outOfBooks = count("feed-off") + count("excluded");
  const handledCount = count("handled-elsewhere");
  const noAccountCount = count("no-account-needed");
  const awaitingCount = count("awaiting-decision");

  const asked = rows.filter((r) => stateOf(r).bucket === "needs-account");
  const needsMapping = asked.length;
  const mapped = asked.filter((r) => r.chart_of_accounts_id).length;
  const asides = [
    outOfBooks > 0 ? `${outOfBooks} out of the books` : null,
    handledCount > 0 ? `${handledCount} handled elsewhere` : null,
    noAccountCount > 0 ? `${noAccountCount} need no account` : null,
    awaitingCount > 0 ? `${awaitingCount} awaiting a decision` : null,
  ].filter(Boolean);
  // Danger draws the eye when something still needs a decision; success confirms
  // there's nothing left to do; neutral covers "no data yet" / "nothing left to
  // map". A claimed counterparty is already out of needsMapping, so a screen
  // whose only gaps are claims reads as done rather than as work outstanding.
  const summaryTone: Tone = rows.length === 0 || needsMapping === 0
    ? "neutral"
    : mapped === needsMapping ? "success" : "danger";

  return (
    <MappingFrame
      selector={selector}
      loading={loading}
      error={error}
      hasAccounts={accounts.length > 0}
      rowCount={rows.length}
      summary={rows.length === 0
        ? "Counterparties appear here after syncing bank-account lines on the Transactions → Bank Ledger tab."
        : needsMapping === 0
        ? `No counterparties left to map${asides.length > 0 ? ` (${asides.join(", ")})` : ""}`
        : `${mapped} of ${needsMapping} counterparties mapped to the chart of accounts`
          + (asides.length > 0 ? ` (${asides.join(", ")})` : "")}
      summaryTone={summaryTone}
      emptyRows={{
        title: "No counterparties yet.",
        hint: "Sync a bank account on the Transactions → Bank Ledger tab to import them.",
      }}
      headers={[...(showFeed ? ["Bank feed"] : []), "Counterparty", "What is it?", "Account comes from", "Account"]}
      footer={
        <>
          Each counterparty is settled by two questions, and the second only appears when the
          first makes it matter.
          {" "}
          <strong>What is it?</strong> Six of the answers end there — a settlement, a transfer,
          an exclusion or &ldquo;leave for review&rdquo; all use no account, so the remaining
          columns disappear. Only an expense, an income or a balance sheet movement carries on.
          Leave it on &ldquo;leave for review&rdquo; when the answer genuinely differs line by
          line.
          {" "}
          <strong>Account comes from</strong> is the second question: pick the account here, or
          say that something else owns it. A counterparty marked <em>set elsewhere</em> is
          already accounted for by a balance sheet calculation — follow its Manage link to see
          where. That answers which account, not what the money is, so those rows still need
          the first question.
          {" "}
          A feed marked <em>classified on sync</em> tells us what each of its lines is at import
          time, so the first question is already answered and only the account remains.
          {" "}
          Rows are seeded automatically the first time a counterparty appears in a sync.
        </>
      }
    >
      {rows.map((rule) => {
        const key = rowKey(rule);
        const handled = effectiveHandler(rule);
        const { feedOff, selfClassifying, treatment, asksAccountSource } = stateOf(rule);
        const treatmentDef = getTreatment(treatment);
        // Why the account questions are absent, said rather than left blank.
        const whyNoAccount = feedOff
          ? "This whole bank feed is switched off."
          : treatmentDef?.effect ?? "Say what this money is first — an account is only used by some answers.";
        const whyNoAccountShort = feedOff ? "feed is off" : treatmentDef ? "no account needed" : "answer step 1 first";
        return (
          <tr key={key} className="border-t border-line/40 hover:bg-surface-mid/20">
            {showFeed && <td className="px-4 py-2 text-secondary whitespace-nowrap">{feedName(rule.source)}</td>}
            <td className="px-4 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-body truncate">{rule.counterparty_label}</span>
                {rule.auto_matched && rule.chart_of_accounts_id && (
                  <span className="text-2xs text-info shrink-0" title="Auto-matched from the counterparty name">
                    auto
                  </span>
                )}
              </div>
            </td>
            {/* ── Step 1 · what is this money? ──────────────────────────────
                One question, one control. It absorbed the old "In the books"
                toggle (now the `Out of the books` option) because that toggle
                was saying, in a second vocabulary, what six of these options
                already say. */}
            <td className="px-4 py-2">
              {feedOff ? (
                <span className="text-2xs text-faint" title="This whole bank feed is switched off, so nothing about this counterparty is counted. Turn the feed on under Bank Feeds.">
                  feed is off
                </span>
              ) : selfClassifying ? (
                // Not a disabled dropdown, and not a blank cell. This feed's
                // importer classifies every line as it arrives, so a rule here
                // could never fire. A control that records a decision and then
                // does nothing with it is the worst of the three; an empty cell
                // would read as a gap somebody forgot to fill.
                <span className="text-2xs text-faint" title={`${feedName(rule.source)} says what each movement is, so its lines are classified as they import. A rule here would have nothing left to classify.`}>
                  classified on sync
                </span>
              ) : (
                // Deliberately NOT gated on a claim. A claim answers "which
                // ACCOUNT codes this" — a different question from "what kind of
                // movement is it". Square proved it: GL 1040's sweep calculation
                // owns its account, which left its Chase payouts with no way to
                // be marked as the already-recorded deposits they are.
                <div className="flex flex-col gap-1 min-w-[210px]">
                  <select className="inp-sm w-full" value={treatment} onChange={(e) => handleSetTreatment(rule, e.target.value)}>
                    {/* Empty is a real answer, not an empty state: "the answer
                        genuinely differs line by line, so keep asking me". */}
                    <option value="">— leave for review —</option>
                    {TREATMENT_GROUPS.map((group) => (
                      <optgroup key={group} label={group}>
                        {treatmentsInGroup(group).map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {treatmentDef && <p className="text-2xs text-faint leading-snug">{treatmentDef.effect}</p>}
                </div>
              )}
            </td>

            {/* ── Step 2 · where does the account come from? ────────────────
                Only asked once step 1 has said the money uses an account — and
                always for a self-classifying feed, whose `expenses` rows are
                operating expenses by construction. This is the old "Routing"
                column, relabelled to the question it was always answering. */}
            <td className="px-4 py-2">
              {!asksAccountSource ? (
                <span className="text-2xs text-faint" title={whyNoAccount}>
                  {whyNoAccountShort}
                </span>
              ) : rule.claim ? (
                // No dropdown at all, not a disabled one: the choice was already
                // made on another screen and this is a report of it.
                <span className="text-2xs text-faint" title={`Set up under ${rule.claim.badge.replace(/^Handled by /, "")}`}>
                  set elsewhere
                </span>
              ) : (
                <select
                  className="inp-sm"
                  value={getCounterpartyHandler(rule.routing) ? rule.routing : ""}
                  onChange={(e) => handleSetRouting(rule, e.target.value)}
                >
                  {/* A stored value this build does not know: shown rather than
                      silently re-reading as the default, which would look like
                      the counterparty had been quietly re-routed. */}
                  {!getCounterpartyHandler(rule.routing) && <option value="">{rule.routing} (unknown)</option>}
                  {SELECTABLE_HANDLERS.map((h) => (
                    <option key={h.key} value={h.key}>{h.label}</option>
                  ))}
                </select>
              )}
            </td>

            {/* ── Step 3 · which account? ───────────────────────────────────
                Only when step 2 says the account is chosen here. */}
            <td className="px-4 py-2">
              {handled ? (
                // Shown whether or not an account is being asked for. A claim is
                // information as much as a control: "GL 1040's sweep calculation
                // accounts for this" is worth saying even once the flow has
                // settled that no account of its own is used.
                <div className="flex items-center gap-2">
                  <Badge tone="accent">{handled.badge}</Badge>
                  {handled.manageHref && (
                    <a href={handled.manageHref} className="text-2xs text-accent hover:underline shrink-0">
                      Manage →
                    </a>
                  )}
                </div>
              ) : !asksAccountSource ? (
                <span className="text-2xs text-faint">—</span>
              ) : (
                <div className="flex items-center gap-2">
                  <AccountSelect
                    value={rule.chart_of_accounts_id}
                    onChange={(id) => handleSetRule(rule, id)}
                    accounts={accounts as CoARef[]}
                    placeholder="— map this counterparty —"
                    shortLabel
                    className="w-full max-w-[360px]"
                  />
                  <SaveHint saving={savingKey === key} />
                </div>
              )}
            </td>
          </tr>
        );
      })}
    </MappingFrame>
  );
}
