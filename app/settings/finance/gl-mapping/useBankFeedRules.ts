"use client";
/**
 * The bank-feed and counterparty switches, shared by the two panels that show
 * them: Bank Feeds owns the feed-level ones, Counterparties owns the
 * counterparty-level ones, and both read the same endpoint so a feed switched
 * off in one place reads as off in the other without a page reload.
 */
import { useState, useEffect, useCallback } from "react";

const RULES_URL = "/api/finance/bank-ledger-rules";

export interface FeedRule {
  source: string;
  transaction_count: number;
  earliest: string | null;
  latest: string | null;
  /** Whether this feed's transactions reach the books right now. */
  included: boolean;
  /** True when somebody decided that, rather than it being how the transactions arrived. */
  decided: boolean;
}

export interface CounterpartyRule {
  source: string;
  counterparty_key: string;
  counterparty_label: string;
  transaction_count: number;
  included: boolean;
  decided: boolean;
}

export function useBankFeedRules() {
  const [feeds, setFeeds] = useState<FeedRule[]>([]);
  const [counterparties, setCounterparties] = useState<CounterpartyRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(RULES_URL);
      const body = await res.json();
      setFeeds(Array.isArray(body?.feeds) ? body.feeds : []);
      setCounterparties(Array.isArray(body?.counterparties) ? body.counterparties : []);
    } catch {
      setError("Could not load the bank feed settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { reload(); }, [reload]);

  /**
   * Record one decision. Returns false when it did not save, so the caller can
   * leave the switch where it was rather than showing a change that is not real.
   */
  const save = useCallback(async (body: {
    scope: "source" | "counterparty";
    source: string;
    counterparty_key?: string;
    counterparty_label?: string;
    included: boolean;
  }): Promise<boolean> => {
    const res = await fetch(RULES_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) setError("Could not save that change.");
    return res.ok;
  }, []);

  return { feeds, setFeeds, counterparties, setCounterparties, loading, error, setError, save, reload };
}
