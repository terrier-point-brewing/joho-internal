"use client";

/**
 * Wake County — Beer & Wine License Renewal worksheet — a read-only fee
 * schedule. Every figure is server-computed from the schedule's selected
 * license types (see the party's fieldOwnership), so there are no editable
 * inputs: the component only displays the current fields.
 *
 * Licenses the brewery does NOT hold render "—" and contribute nothing to the
 * total; change the selection by editing the schedule, then recompute.
 *
 * Filer identity (contact name, email, phone, Wake County account #, FEIN) is
 * NOT rendered here — it's shown once, above every party's worksheet, by
 * TaxWorksheetShell's IdentityHeader. The 4-digit PIN is a masked settings
 * field, never displayed on the worksheet.
 */
import { fmtCents } from "@/lib/utils/formatting";
import { BEER_WINE_LICENSE_TYPES, licenseFeeFieldKey } from "@/lib/tax/parties/wakeCountyBeerWine/rates";
import type { PartyWorksheetProps } from "../registry";

export default function WakeCountyBeerWineWorksheet({ fields }: PartyWorksheetProps) {
  const total = Number(fields.wake_bw_total_fee_cents ?? 0);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <div className="border border-line rounded px-3 py-2 mb-1">
          <h4 className="text-sm font-bold text-strong">Wake County Beer &amp; Wine License Renewal</h4>
        </div>
        {BEER_WINE_LICENSE_TYPES.map((type) => {
          const fee = fields[licenseFeeFieldKey(type.value)];
          return (
            <Row key={type.value} label={type.label} value={fee == null ? "—" : fmtCents(Number(fee))} />
          );
        })}
        <Row label="Total Renewal Fee" value={fmtCents(total)} emphasis />
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
