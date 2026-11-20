"use client";

// Downloads the bookkeeper workbook for the year the page is showing.
//
// A plain <a download> would do the download, but the workbook takes several
// seconds to assemble and a link gives no sign that anything is happening --
// and on failure it navigates the tab to a JSON error. Fetching it here keeps
// the page in place, shows progress, and reports a failure where the click was.

import { useState } from "react";

function filenameFrom(disposition: string | null, fallback: string): string {
  const match = disposition?.match(/filename="([^"]+)"/);
  return match?.[1] ?? fallback;
}

export default function ExportButton({ year }: { year: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/finance/export?year=${year}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Export failed (${res.status})`);
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filenameFrom(res.headers.get("Content-Disposition"), `bookkeeper-export-${year}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <span role="alert" className="text-xs text-danger">{error}</span>}
      <button
        onClick={() => void download()}
        disabled={busy}
        className="btn-secondary"
        title="Download statements, transaction detail and supporting schedules as one Excel workbook"
      >
        {busy ? "Preparing…" : "Export"}
      </button>
    </>
  );
}
