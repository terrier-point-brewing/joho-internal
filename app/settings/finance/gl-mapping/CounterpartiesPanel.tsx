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
import { useState, useMemo } from "react";
import AccountSelect, { type CoARef } from "@/app/finance/AccountSelect";
import Badge from "@/app/components/ui/Badge";
import SaveHint from "@/app/components/ui/SaveHint";
import ToggleChip from "@/app/components/ui/ToggleChip";
import type { Tone } from "@/app/components/ui/tone";
import MappingFrame from "./MappingFrame";
import { useMappingData } from "./useMappingData";
import { useBankFeedRules } from "./useBankFeedRules";
import { feedName } from "./bankFeeds";
import {
  SELECTABLE_HANDLERS,
  getCounterpartyHandler,
  codesFromRuleAccount,
} from "@/lib/finance/counterpartyHandlers";

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

export default function CounterpartiesPanel() {
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
  const excludedCount = rows.filter(isExcluded).length;
  const handledCount = rows.filter((r) => !isExcluded(r) && isHandledElsewhere(r)).length;
  const needsMapping = rows.length - excludedCount - handledCount;
  const mapped = rows.filter((r) => r.chart_of_accounts_id && !isExcluded(r) && !isHandledElsewhere(r)).length;
  const asides = [
    excludedCount > 0 ? `${excludedCount} out of the books` : null,
    handledCount > 0 ? `${handledCount} handled elsewhere` : null,
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
      headers={[...(showFeed ? ["Bank feed"] : []), "Counterparty", "In the books", "Routing", "Chart of Accounts"]}
      footer={
        <>
          Mapping a counterparty here codes every uncoded bank-line expense from it (e.g. Gusto
          payroll, Erie insurance). Rows are seeded automatically the first time that counterparty
          appears in a sync. Switching one out of the books leaves its transactions imported and
          visible but keeps them off every report — use that for transfers between accounts the
          business already owns, which are neither income nor expense. A counterparty marked
          &ldquo;set elsewhere&rdquo; is already accounted for by a balance sheet calculation, so there is
          nothing to map here — follow its Manage link to see where it is set up.
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
