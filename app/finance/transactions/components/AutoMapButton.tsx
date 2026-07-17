"use client";
import { useState, type ReactNode } from "react";

/**
 * Shared auto-map action + result readout. The caller supplies the run and,
 * optionally, a label/busy-label and a custom result formatter; this owns the
 * busy/result UI so every Transactions auto-map button (source-account mapping,
 * payroll split matching, …) reports identically. Defaults render the
 * `{ mapped }` shape the source-account auto-map returns.
 */
export default function AutoMapButton<T = { mapped: number }>({
  onRun,
  label = "Auto-map all",
  busyLabel = "Mapping…",
  renderResult,
}: {
  onRun: () => Promise<T>;
  label?: string;
  busyLabel?: string;
  renderResult?: (r: T) => ReactNode;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<T | null>(null);

  async function handle() {
    setRunning(true);
    setResult(null);
    const r = await onRun();
    setResult(r);
    setRunning(false);
  }

  const defaultRender = (r: T) => {
    const mapped = (r as { mapped?: number }).mapped ?? 0;
    return mapped > 0
      ? <span className="text-success">{mapped} mapped</span>
      : <span className="text-faint">Nothing to map</span>;
  };

  return (
    <div className="flex items-center gap-2">
      <button onClick={handle} disabled={running} className="btn-secondary whitespace-nowrap">
        {running ? busyLabel : label}
      </button>
      {result && (
        <span className="text-xs text-secondary">
          {(renderResult ?? defaultRender)(result)}
        </span>
      )}
    </div>
  );
}
