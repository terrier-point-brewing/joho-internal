"use client";
/**
 * Load the chart of accounts and one panel's mapping rows together.
 *
 * Every flat panel here did this by hand with the same four useStates and the
 * same Promise.all. Both requests are needed before anything can render — the
 * rows are meaningless without the accounts to map them to — so they stay a
 * single loading state rather than two.
 */
import { useState, useEffect, useCallback } from "react";
import type { CoARef } from "@/app/finance/AccountSelect";

const COA_URL = "/api/finance/chart-of-accounts";

export function useMappingData<Row>(rowsUrl: string, failureMessage: string) {
  const [accounts, setAccounts] = useState<CoARef[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [coaRes, rowRes] = await Promise.all([fetch(COA_URL), fetch(rowsUrl)]);
      const [coa, rl] = await Promise.all([coaRes.json(), rowRes.json()]);
      setAccounts(Array.isArray(coa) ? coa : []);
      setRows(Array.isArray(rl) ? rl : []);
    } catch {
      setError(failureMessage);
    } finally {
      setLoading(false);
    }
  }, [rowsUrl, failureMessage]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { reload(); }, [reload]);

  return { accounts, rows, setRows, loading, error, setError, reload };
}
