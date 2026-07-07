"use client";
import { useState, useEffect } from "react";

/** Whole days elapsed since an ISO timestamp. */
export function daysSince(isoStr: string): number {
  return Math.floor((Date.now() - new Date(isoStr).getTime()) / 86_400_000);
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface SyncPanelProps<T> {
  year: number;
  /** localStorage key holding the last-sync ISO timestamp (e.g. "tpb-pos-last-sync"). */
  storageKey: string;
  /**
   * Build the POST endpoint for a run. `month` is 1-12 when the month picker
   * is shown, or 0 for a full-year sync / when the picker is hidden.
   */
  buildEndpoint: (opts: { year: number; month: number }) => string;
  /** Trailing button copy, e.g. "from Square" or "Ramp" → "Sync … from Square". */
  label: string;
  showMonthPicker?: boolean;
  onSynced: () => void;
  /** Render the source-specific result summary (orders synced, invoices updated, …). */
  renderResult?: (json: T) => React.ReactNode;
}

/**
 * Shared sync control for the Transactions subtabs: the "Last sync: Nd ago"
 * badge, an optional month picker, the sync button, and error/result readout.
 * Replaces the near-duplicate SyncPanel / InvoiceSyncPanel implementations.
 */
export default function SyncPanel<T>({
  year,
  storageKey,
  buildEndpoint,
  label,
  showMonthPicker = false,
  onSynced,
  renderResult,
}: SyncPanelProps<T>) {
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(storageKey);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setLastSync(stored);
  }, [storageKey]);

  async function handleSync() {
    setSyncing(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(buildEndpoint({ year, month: showMonthPicker ? month : 0 }), { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Sync failed");
        return;
      }
      setResult(json as T);
      const now = new Date().toISOString();
      localStorage.setItem(storageKey, now);
      setLastSync(now);
      onSynced();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSyncing(false);
    }
  }

  const scope = showMonthPicker ? (month === 0 ? "full year" : MONTH_LABELS[month - 1]) : "";
  const days = lastSync != null ? daysSince(lastSync) : null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {days != null && (
        <span className={`text-xs ${days >= 7 ? "text-accent" : "text-muted"}`}>
          Last sync: {days === 0 ? "today" : `${days}d ago`}
        </span>
      )}
      {showMonthPicker && (
        <select
          value={month}
          onChange={(e) => { setMonth(Number(e.target.value)); setResult(null); }}
          className="inp-sm w-auto">
          {MONTH_LABELS.map((lbl, i) => <option key={i + 1} value={i + 1}>{lbl}</option>)}
          <option value={0}>Full year</option>
        </select>
      )}
      <button onClick={handleSync} disabled={syncing} className="btn-sm whitespace-nowrap">
        {syncing
          ? `Syncing${scope ? " " + scope : ""}…`
          : `Sync ${scope ? scope + " " : ""}${label}`}
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
      {result && renderResult && <span className="text-xs text-secondary">{renderResult(result)}</span>}
    </div>
  );
}
