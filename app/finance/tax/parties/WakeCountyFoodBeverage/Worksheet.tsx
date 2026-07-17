"use client";

/**
 * Wake County — Prepared Food & Beverage Tax worksheet — a read-only three-row
 * summary. Every figure is server-computed (see the party's fieldOwnership), so
 * there are no editable inputs: the component only displays the current fields.
 *
 * Filer identity (contact person, Wake County account #, address) is NOT
 * rendered here — it's shown once, above every party's worksheet, by
 * TaxWorksheetShell's IdentityHeader (sourced from the shared Tax Profile). The
 * 4-digit PIN is a masked settings field, never displayed on the worksheet.
 *
 * Gross Receipts shows "—" when the optional general-sales-tax mapping is unset.
 */
import { fmtCents } from "@/lib/utils/formatting";
import type { PartyWorksheetProps } from "../registry";

function num(v: number | string | null | undefined): number {
  return Number(v ?? 0);
}

export default function WakeCountyFoodBeverageWorksheet({ fields }: PartyWorksheetProps) {
  const grossRaw = fields.wake_gross_receipts_cents;
  const gross = grossRaw == null ? null : num(grossRaw);
  const applicable = num(fields.wake_applicable_receipts_cents);
  const taxOwed = num(fields.wake_tax_owed_cents);
  const rate = num(fields.wake_rate);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <div className="border border-line rounded px-3 py-2 mb-1">
          <h4 className="text-sm font-bold text-strong">Wake County Prepared Food &amp; Beverage Tax</h4>
        </div>
        <Row label="Gross Receipts (Taproom Net Sales)" value={gross == null ? "—" : fmtCents(gross)} />
        <Row label="Applicable Gross Receipts (Food & Beverage-taxed items)" value={fmtCents(applicable)} />
        <Row label={`Tax Owed (${(rate * 100).toFixed(2)}%)`} value={fmtCents(taxOwed)} emphasis />
      </section>
    </div>
  );
}

function Row({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line/40 pb-1.5">
      <span className={`text-sm ${emphasis ? "font-semibold text-strong" : "text-body"}`}>{label}</span>
      <span className={`text-sm font-mono tabular-nums ${emphasis ? "font-semibold text-strong" : "text-body"}`}>
        {value}
      </span>
    </div>
  );
}
