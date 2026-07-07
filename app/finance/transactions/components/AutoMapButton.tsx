"use client";
import { useState } from "react";

/**
 * Shared "Auto-map all" action + result readout. The caller supplies the run
 * (a POST that returns `{ mapped }`); this owns the busy/result UI so every
 * Transactions subtab reports auto-mapping identically.
 */
export default function AutoMapButton({ onRun }: { onRun: () => Promise<{ mapped: number }> }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ mapped: number } | null>(null);

  async function handle() {
    setRunning(true);
    setResult(null);
    const r = await onRun();
    setResult(r);
    setRunning(false);
  }

  return (
    <div className="flex items-center gap-2">
      <button onClick={handle} disabled={running} className="btn-sm whitespace-nowrap">
        {running ? "Mapping…" : "Auto-map all"}
      </button>
      {result && (
        <span className="text-xs text-secondary">
          {result.mapped > 0
            ? <span className="text-success">{result.mapped} mapped</span>
            : <span className="text-faint">Nothing to map</span>}
        </span>
      )}
    </div>
  );
}
