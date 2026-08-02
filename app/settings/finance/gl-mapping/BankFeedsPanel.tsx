"use client";
/**
 * One switch per bank feed: does this account's money movement count as part of
 * the books?
 *
 * The question only became a question when a second bank arrived. Ramp's
 * transactions have always counted, and still do. A newly connected bank turns
 * up with years of history behind it, and letting that history straight into the
 * books would rewrite months that have already been closed and reported — so a
 * new feed arrives switched off, and this panel is where somebody turns it on
 * having seen how much history they are turning on.
 *
 * The transaction count and date span are shown next to the switch for exactly
 * that reason. "Include Chase" is a very different act when it means eleven
 * transactions from last week than when it means two years and four thousand.
 */
import { useState } from "react";
import ToggleChip from "@/app/components/ui/ToggleChip";
import Badge from "@/app/components/ui/Badge";
import MappingFrame from "./MappingFrame";
import { useBankFeedRules, type FeedRule } from "./useBankFeedRules";
import { feedName, transactionCount, dateSpan } from "./bankFeeds";

export default function BankFeedsPanel() {
  const { feeds, setFeeds, loading, error, save } = useBankFeedRules();
  const [savingSource, setSavingSource] = useState<string | null>(null);

  async function handleToggle(feed: FeedRule, included: boolean) {
    setSavingSource(feed.source);
    const ok = await save({ scope: "source", source: feed.source, included });
    setSavingSource(null);
    if (!ok) return;
    setFeeds((fs) => fs.map((f) => (f.source === feed.source ? { ...f, included, decided: true } : f)));
  }

  const included = feeds.filter((f) => f.included).length;

  return (
    <MappingFrame
      loading={loading}
      error={error ?? null}
      // A feed switch is a yes/no about a bank account, so unlike every other
      // panel here it is not blocked on a chart of accounts existing.
      hasAccounts
      rowCount={feeds.length}
      summary={feeds.length > 0
        ? `${included} of ${feeds.length} bank feeds count towards the books`
        : "Bank feeds appear here once a bank account has been connected and synced."}
      emptyRows={{
        title: "No bank feeds yet.",
        hint: "Connect a bank account and sync it, and it will appear here.",
      }}
      headers={["Bank feed", "What has been imported", "Counts towards the books"]}
      footer={
        <>
          Switching a feed on makes all of its imported transactions part of the profit and loss, the
          cash-flow statement and the balance sheet, including transactions dated in months that have
          already been closed. Switching one off leaves its transactions imported and visible, but
          out of every report. Nothing changes until you use one of these switches.
        </>
      }
    >
      {feeds.map((feed) => {
        const span = dateSpan(feed.earliest, feed.latest);
        return (
          <tr key={feed.source} className="border-t border-line/40 hover:bg-surface-mid/20">
            <td className="px-4 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-body truncate">{feedName(feed.source)}</span>
                {!feed.decided && (
                  <span className="text-2xs text-faint shrink-0" title="Nobody has changed this — it is how the transactions were imported">
                    not set
                  </span>
                )}
              </div>
            </td>
            <td className="px-4 py-2 text-secondary">
              {transactionCount(feed.transaction_count)}
              {span && <span className="text-faint">, {span}</span>}
            </td>
            <td className="px-4 py-2">
              <div className="flex items-center gap-2">
                <ToggleChip
                  active={feed.included}
                  onClick={() => handleToggle(feed, !feed.included)}
                >
                  {feed.included ? "Yes" : "No"}
                </ToggleChip>
                {savingSource === feed.source && <span className="text-2xs text-faint">saving…</span>}
                {feed.included && feed.transaction_count > 0 && (
                  <Badge tone="neutral">Reported in the statements</Badge>
                )}
              </div>
            </td>
          </tr>
        );
      })}
    </MappingFrame>
  );
}
