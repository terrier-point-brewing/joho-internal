"use client";
/**
 * Counterparty rules (uncoded bank-line senders/payees, e.g. Gusto, Erie) →
 * Chart of Accounts. Rows seed themselves the first time a bank line from that
 * counterparty is synced; this panel assigns each one an account, and decides
 * whether its transactions belong in the books at all.
 *
 * Routing decides WHO codes a counterparty: this screen, or something else —
 * see lib/finance/counterpartyHandlers.ts for the registry and
 * resolveExpenseMapping in lib/finance/expenses.ts for what the ledger does
 * with it. A counterparty handled elsewhere has no single account to pick, so
 * the picker is replaced rather than disabled.
 *
 * Two shapes of "elsewhere", and the difference is visible on screen:
 *
 *   chosen   -- the operator picks it from the dropdown, because nothing
 *               upstream knows about this counterparty. Payroll split: nothing
 *               in payroll settings names Gusto.
 *   claimed  -- the row arrives already answered and read-only, because the
 *               fact was stated elsewhere. Square: GL 1040's method already
 *               names the bank account Square pays into. Offering a dropdown
 *               here would ask for the same fact twice with nothing keeping the
 *               two agreed.
 *
 * ── Why a counterparty is identified by its bank feed as well as its name ────
 * The same name on two bank accounts is not necessarily the same relationship,
 * and a bookkeeper may well code them differently, so each is its own row with
 * its own account. The bank-feed column is what keeps the two apart on screen,
 * and it is hidden entirely while there is only one feed, so a business with one
 * bank account sees the screen it always saw.
 *
 * ── Why some counterparties can be left out of the books ─────────────────────
 * A transfer between two accounts the business already owns is neither income
 * nor expense. It genuinely moved the bank balance, so it is a real transaction,
 * but counting it as trading activity overstates both sides of the profit and
 * loss. Switching the counterparty off leaves the transactions imported and
 * visible, and takes them out of the reports.
 */
import { useState, useMemo, type ReactNode } from "react";
import AccountSelect, { type CoARef } from "@/app/finance/AccountSelect";
import Badge from "@/app/components/ui/Badge";
import SaveHint from "@/app/components/ui/SaveHint";
import ToggleChip from "@/app/components/ui/ToggleChip";
import type { Tone } from "@/app/components/ui/tone";
import MappingFrame from "./MappingFrame";
import { useMappingData } from "./useMappingData";
import { useBankFeedRules } from "./useBankFeedRules";
import { feedName, feedClassifiesOwnLines } from "./bankFeeds";
import {
  SELECTABLE_HANDLERS,
  getCounterpartyHandler,
  codesFromRuleAccount,
} from "@/lib/finance/counterpartyHandlers";
import {
  FLOW_GROUPS,
  flowTypesInGroup,
  getFlowType,
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
   * Set (or clear) what kind of movement this counterparty's lines are.
   *
   * The server drops the rule's account when the new flow cannot hold one, so
   * the local row is updated to match rather than left showing an account the
   * rule no longer has — a disagreement that would only surface on reload.
   */
  async function handleSetFlow(rule: RuleRow, flowType: string) {
    const flow_type = flowType === "" ? null : flowType;
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
  }

  async function handleSetIncluded(rule: RuleRow, included: boolean) {
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

  // A counterparty switched out of the books (or whose whole feed is off)
  // will never need a CoA account — that switch already lives in
  // bank_ledger_gl_rules via useBankFeedRules — so it drops out of the
  // denominator instead of reading as a permanently unmapped counterparty.
  function isExcluded(r: RuleRow): boolean {
    if (feedIncluded.get(r.source) === false) return true;
    return (counterpartyIncluded.get(rowKey(r)) ?? true) === false;
  }
  // A counterparty something else codes has no account to pick either, so it
  // leaves the denominator for the same reason an excluded one does. Without
  // this the screen reports a shortfall that no amount of work can close, and
  // every balance-sheet calculation added would make the shortfall look worse.
  function isHandledElsewhere(r: RuleRow): boolean {
    return effectiveHandler(r) !== null;
  }
  // A counterparty whose flow is a settlement or a transfer has no account to
  // pick — the flow answered that. It leaves the denominator for the same reason
  // an excluded or claimed one does: counting it would report a shortfall that
  // no amount of work can close.
  function needsNoAccount(r: RuleRow): boolean {
    return r.flow_type !== null && !flowNeedsAccount(r.flow_type);
  }
  const excludedCount = rows.filter(isExcluded).length;
  const handledCount = rows.filter((r) => !isExcluded(r) && isHandledElsewhere(r)).length;
  const classifiedCount = rows.filter((r) => !isExcluded(r) && !isHandledElsewhere(r) && needsNoAccount(r)).length;
  const needsMapping = rows.length - excludedCount - handledCount - classifiedCount;
  const mapped = rows.filter((r) => r.chart_of_accounts_id && !isExcluded(r) && !isHandledElsewhere(r) && !needsNoAccount(r)).length;
  const asides = [
    excludedCount > 0 ? `${excludedCount} out of the books` : null,
    handledCount > 0 ? `${handledCount} handled elsewhere` : null,
    classifiedCount > 0 ? `${classifiedCount} need no account` : null,
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
      headers={[...(showFeed ? ["Bank feed"] : []), "Counterparty", "In the books", "Routing", "Flow", "Chart of Accounts"]}
      footer={
        <>
          Mapping a counterparty here codes every uncoded bank-line expense from it (e.g. Gusto
          payroll, Erie insurance). Rows are seeded automatically the first time that counterparty
          appears in a sync.
          {" "}
          <strong>Flow</strong> and <strong>Chart of Accounts</strong> answer different questions.
          Flow says what KIND of movement the bank lines are, so they classify themselves instead
          of waiting for someone to decide the same thing every month; leave it on &ldquo;leave for
          review&rdquo; when the answer genuinely differs line by line. Only an expense or an income
          flow needs an account, so the Chart of Accounts column disappears for the others — and a
          counterparty whose account is <em>set elsewhere</em> still needs a flow, because being
          handled by a payroll split or a balance sheet calculation says nothing about whether the
          money counts.
          {" "}
          A feed marked <em>classified on sync</em> tells us what each movement is at import time,
          so there is nothing left for a rule to classify.
          {" "}
          Switching a counterparty out of the books leaves its transactions imported and visible but
          keeps them off every report — use that for transfers between accounts the business already
          owns, which are neither income nor expense.
        </>
      }
    >
      {rows.map((rule) => {
        const key = rowKey(rule);
        // The feed switch wins: a counterparty cannot be in the books when the
        // whole bank account it belongs to is out of them.
        const feedOff = feedIncluded.get(rule.source) === false;
        const included = counterpartyIncluded.get(key) ?? true;
        const handled = effectiveHandler(rule);
        const excluded = isExcluded(rule);
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
            <td className="px-4 py-2">
              {feedOff ? (
                <span className="text-2xs text-faint" title="This bank feed does not count towards the books">
                  feed is off
                </span>
              ) : (
                <ToggleChip active={included} onClick={() => handleSetIncluded(rule, !included)}>
                  {included ? "Yes" : "No"}
                </ToggleChip>
              )}
            </td>
            <td className="px-4 py-2">
              {excluded ? (
                <span className="text-2xs text-faint" title="This counterparty is out of the books, so nothing needs to be routed">
                  excluded
                </span>
              ) : rule.claim ? (
                // No dropdown at all, not a disabled one. A disabled control
                // still reads as "a choice you are not allowed to make", when
                // the truth is that the choice was already made on another
                // screen and this is a report of it.
                <span className="text-2xs text-faint" title={`Set up under ${rule.claim.badge.replace(/^Handled by /, "")}`}>
                  set elsewhere
                </span>
              ) : (
                <select
                  className="inp-sm"
                  value={codesFromRuleAccount(rule.routing) || getCounterpartyHandler(rule.routing) ? rule.routing : ""}
                  onChange={(e) => handleSetRouting(rule, e.target.value)}
                >
                  {/* A stored value this build does not know: shown rather than
                      silently re-reading as "Single account", which would look
                      like the counterparty had been quietly re-routed. */}
                  {!getCounterpartyHandler(rule.routing) && <option value="">{rule.routing} (unknown)</option>}
                  {SELECTABLE_HANDLERS.map((h) => (
                    <option key={h.key} value={h.key}>{h.label}</option>
                  ))}
                </select>
              )}
            </td>
            <td className="px-4 py-2">
              {excluded ? (
                <span className="text-2xs text-faint" title="This counterparty is out of the books, so its lines are never counted">
                  excluded
                </span>
              ) : feedClassifiesOwnLines(rule.source) ? (
                // Not a disabled dropdown, and not a blank cell either. This
                // feed's importer classifies every line as it arrives, so a rule
                // here can never fire — see feedClassifiesOwnLines. A control
                // that records a decision and then does nothing with it is the
                // worst of the three, and an empty cell would read as a gap
                // somebody forgot to fill.
                <span className="text-2xs text-faint" title={`${feedName(rule.source)} says what each movement is, so its lines are classified as they import. A rule here would have nothing left to classify.`}>
                  classified on sync
                </span>
              ) : (
                // Deliberately NOT gated on `handled`. Routing and claims answer
                // "which ACCOUNT codes this counterparty" — a different question
                // from "what kind of movement is it". Square is the case that
                // proved it: GL 1040's sweep calculation owns its account, which
                // left its four Chase payouts with no way to be marked as
                // already-recorded deposits, and they sat unclassified for it.
                <div className="flex flex-col gap-1 min-w-[200px]">
                  <select
                    className="inp-sm w-full"
                    value={rule.flow_type ?? ""}
                    onChange={(e) => handleSetFlow(rule, e.target.value)}
                  >
                    {/* Null is a real answer, not an empty state: "the flow
                        genuinely differs line by line, so keep asking me". */}
                    <option value="">— leave for review —</option>
                    {FLOW_GROUPS.filter((g) => g !== "Needs review").map((group) => (
                      <optgroup key={group} label={group}>
                        {flowTypesInGroup(group).map((f) => (
                          <option key={f.key} value={f.key}>{f.label}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {rule.flow_type && (
                    <p className="text-2xs text-faint leading-snug">{getFlowType(rule.flow_type)?.effect}</p>
                  )}
                </div>
              )}
            </td>
            <td className="px-4 py-2">
              {excluded ? (
                <span className="text-2xs text-faint" title="This counterparty is out of the books">
                  excluded
                </span>
              ) : handled ? (
                <div className="flex items-center gap-2">
                  <Badge tone="accent">{handled.badge}</Badge>
                  {handled.manageHref && (
                    <a href={handled.manageHref} className="text-2xs text-accent hover:underline shrink-0">
                      Manage →
                    </a>
                  )}
                </div>
              ) : rule.flow_type && !flowNeedsAccount(rule.flow_type) ? (
                // The flow settles or transfers rather than earns or spends, so
                // there is no account for it to code to. A disabled picker would
                // read as a choice being withheld; the truth is that the flow
                // already answered the question.
                <span className="text-2xs text-faint" title={getFlowType(rule.flow_type)?.effect}>
                  no account needed
                </span>
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
