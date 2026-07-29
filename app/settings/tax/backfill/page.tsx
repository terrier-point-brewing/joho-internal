"use client";

// Line-item tax backfill (GET /api/tax/backfill-line-item-taxes?start=&end=).
//
// The odd one out, in two ways the UI has to be honest about:
//
//   1. It has NO dry-run mode. The route writes on the only call it supports,
//      so there is nothing to preview and `preview` is null. The shell then
//      drops the preview button and shows the standing caution instead of
//      pretending a gate exists.
//   2. It is delete-then-insert per order, driven by a LIVE Square re-fetch.
//      Idempotent when Square returns the same data — but if Square returns an
//      order without its taxes, the existing rows are deleted and not replaced.
//      Since PR #286 the sales-tax liability is derived from that same table,
//      so a bad run silently understates what we owe. Hence the explicit
//      warning and the required, deliberate date range.

import { useState } from "react";
import BackfillShell from "../../BackfillShell";
import { LedgerTable, Th } from "@/app/finance/transactions/components/LedgerTable";

interface LineItemTaxResult {
  orders: number;
  taxRows: number;
  errors?: string[];
}

async function run(start: string, end: string): Promise<LineItemTaxResult> {
  const res = await fetch(
    `/api/tax/backfill-line-item-taxes?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
  );
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as LineItemTaxResult;
}

export default function TaxBackfillPage() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  return (
    <BackfillShell<LineItemTaxResult>
      title="Line item tax backfill"
      what={
        <>
          Re-fetches every already-synced POS order in a date range from Square and rebuilds its
          per-line tax rows. For orders synced before <code>pos_line_item_taxes</code> existed, or to
          re-derive rows after a mapping fix.
        </>
      }
      impacts={
        <>
          Replaces <code>pos_line_item_taxes</code> for the chosen range. The sales-tax liability on
          the balance sheet and the NC DOR / Wake County taxable base are both derived from this
          table, so both move with it.
        </>
      }
      danger={
        <>
          <span className="font-medium">This backfill cannot be previewed.</span> It has no dry-run
          mode — the only call it supports writes. It also deletes each order&rsquo;s existing tax
          rows before inserting rows rebuilt from a live Square fetch, so if Square returns an order
          without its taxes, those rows are removed and not replaced. Use the narrowest date range
          that covers what you need.
        </>
      }
      preview={null}
      apply={() => run(start, end)}
      disabled={!start || !end}
      controls={
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Start date</span>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="inp-sm" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">End date</span>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="inp-sm" />
          </label>
          {(!start || !end) && (
            <span className="text-xs text-muted pb-2">Both dates are required.</span>
          )}
        </div>
      }
    >
      {(r) => (
        <>
          <LedgerTable
            head={
              <>
                <Th label="Orders processed" align="right" />
                <Th label="Tax rows written" align="right" />
              </>
            }
          >
            <tr>
              <td className="px-4 py-2 text-right text-body tabular-nums">{r.orders}</td>
              <td className="px-4 py-2 text-right text-body tabular-nums">{r.taxRows}</td>
            </tr>
          </LedgerTable>
          {r.errors && r.errors.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-danger">{r.errors.length} error(s):</p>
              <ul className="list-disc ml-4 text-xs text-muted">
                {r.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {r.orders === 0 && (
            <p className="text-xs text-muted mt-2">
              No POS orders found in that range — nothing was changed.
            </p>
          )}
        </>
      )}
    </BackfillShell>
  );
}
