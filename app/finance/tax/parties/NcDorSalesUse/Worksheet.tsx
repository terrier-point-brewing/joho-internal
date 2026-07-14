"use client";

/**
 * NC DOR Sales & Use (Form E-500) editable worksheet — Lines 1-21 plus the
 * page-2 county schedule. Computed fields (per `fieldOwnership.ts`) render
 * read-only-styled and always reflect the current `fields`; manual fields
 * render as `.inp-sm`-style money inputs. Every edit recomputes lines
 * 13/15/21 client-side via `recomputeClientTotals` (the exact server
 * formula) so the totals update instantly — the server remains the source
 * of truth on the next autosave/recompute.
 *
 * `readOnly` (set by `TaxWorksheetShell` once the parent task is
 * `completed`) forces every manual field to render display-only, the same
 * as an already-computed field, and makes `updateField` a no-op — a
 * submitted filing's figures can no longer be edited.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fmtCents } from "@/lib/utils/formatting";
import { NC_COUNTIES } from "@/lib/tax/parties/ncDorSalesUse/rates";
import { RATE_LINES } from "@/lib/tax/parties/ncDorSalesUse/calc";
import { recomputeClientTotals, centsToDollarString, dollarStringToCents } from "@/lib/tax/ncDorWorksheetMath";
import { buildRateMap, type TaxRate } from "@/lib/tax/rates";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import { isComputedField } from "./fieldOwnership";
import type { PartyWorksheetProps } from "../registry";

type Fields = Record<string, number | string | null>;

const RATE_LINE_LABEL: Record<number, string> = {
  4: "Gen. State Rate 4.75%",
  5: "3% State Rate",
  6: "Modular Homes",
  7: "Mfg. Homes",
  8: "2% Food Rate",
  9: "2% County Rate",
  10: "2.25% County Rate",
  11: ".5% Transit County Rate",
  12: ".25% Transit County Rate",
};

const RATE_LINE_RATE_DISPLAY: Record<number, string> = {
  4: "4.75%",
  5: "3%",
  6: "—",
  7: "—",
  8: "2%",
  9: "2%",
  10: "2.25%",
  11: "0.5%",
  12: "0.25%",
};

function num(v: number | string | null | undefined): number {
  return Number(v ?? 0);
}

export default function NcDorSalesUseWorksheet({
  fields,
  computedAt,
  onFieldsChange,
  readOnly = false,
}: PartyWorksheetProps) {
  // Keyed into every money input so a fresh recompute (which changes
  // computedAt) remounts them and resyncs their displayed text to the new
  // server value — a same-generation keystroke never remounts, so the
  // user's in-progress typing is never clobbered by its own recompute.
  const generation = computedAt ?? "initial";

  // Canonical rate map (tax_rates) — every recompute must read rate values
  // from here, never a code constant.
  const ratesQuery = useQuery({
    queryKey: queryKeys.tax.rates(),
    queryFn: () => fetchJson<TaxRate[]>("/api/tax/rates"),
  });
  const rateMap = buildRateMap(ratesQuery.data ?? []);

  function updateField(key: string, value: number | string | null) {
    if (readOnly) return;
    const next = { ...fields, [key]: value };
    if (!ratesQuery.data) {
      // Rates haven't loaded yet — never recompute with an empty rateMap
      // (would zero every derived tax). Apply the raw edit and fall back to
      // the already-persisted computed fields until the rates fetch resolves.
      onFieldsChange(next);
      return;
    }
    onFieldsChange(recomputeClientTotals(next, rateMap));
  }

  const countyRows = NC_COUNTIES.filter(
    (c) =>
      `county_${c.code}_2pct` in fields ||
      `county_${c.code}_225pct` in fields ||
      `county_${c.code}_transit` in fields,
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Lines 1-3 */}
      <section className="flex flex-col gap-2">
        <LineRow fieldKey="line1_gross_receipts" label="Line 1 — Gross Receipts" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <LineRow fieldKey="line2_sales_for_resale" label="Line 2 — Deductions: Sales for Resale" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <LineRow fieldKey="line3_exempt" label="Line 3 — Deductions: Exempt Sales" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
      </section>

      {/* Rate-line table — Lines 4-12 */}
      <section className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-xs text-faint uppercase tracking-wide border-b border-line">
              <th className="py-1.5 pr-2 font-medium">Line</th>
              <th className="py-1.5 px-2 font-medium text-right">Purchases for Use</th>
              <th className="py-1.5 px-2 font-medium text-right">Receipts</th>
              <th className="py-1.5 px-2 font-medium text-right">Rate</th>
              <th className="py-1.5 pl-2 font-medium text-right">Tax</th>
            </tr>
          </thead>
          <tbody>
            {RATE_LINES.map((n) => (
              <tr key={n} className="border-b border-line/60">
                <td className="py-1.5 pr-2 text-body">
                  {n}. {RATE_LINE_LABEL[n]}
                </td>
                <td className="py-1.5 px-2 text-right">
                  <MoneyCell fieldKey={`line${n}_purchases`} fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
                </td>
                <td className="py-1.5 px-2 text-right">
                  <MoneyCell fieldKey={`line${n}_receipts`} fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
                </td>
                <td className="py-1.5 px-2 text-right text-faint">{RATE_LINE_RATE_DISPLAY[n]}</td>
                <td className="py-1.5 pl-2 text-right">
                  <MoneyCell fieldKey={`line${n}_tax`} fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Lines 13-21 */}
      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <LineRow fieldKey="line13_total" label="Line 13 — Total Tax Due" fields={fields} generation={generation} onChangeField={updateField} emphasis readOnly={readOnly} />
        <LineRow fieldKey="line14_excess" label="Line 14 — Excess Collections" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <LineRow fieldKey="line15_total" label="Line 15 — Total (13 + 14)" fields={fields} generation={generation} onChangeField={updateField} emphasis readOnly={readOnly} />
        <LineRow fieldKey="line16_penalty" label="Line 16 — Penalty" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <LineRow fieldKey="line17_interest" label="Line 17 — Interest" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <LineRow fieldKey="line18_less_prepay" label="Line 18 — Less: Prepayment" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <LineRow fieldKey="line19_prepay_next" label="Line 19 — Prepayment for Next Period" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <LineRow fieldKey="line20_credit" label="Line 20 — Credit" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <div className="flex flex-col gap-1">
          <label className="text-xs text-faint" htmlFor="line20_credit_explanation">
            Line 20 explanation
          </label>
          {readOnly ? (
            <p id="line20_credit_explanation" className="text-sm text-body">
              {typeof fields.line20_credit_explanation === "string" && fields.line20_credit_explanation
                ? fields.line20_credit_explanation
                : "—"}
            </p>
          ) : (
            <input
              id="line20_credit_explanation"
              key={`line20_credit_explanation-${generation}`}
              type="text"
              className="inp-sm"
              defaultValue={typeof fields.line20_credit_explanation === "string" ? fields.line20_credit_explanation : ""}
              onChange={(e) => updateField("line20_credit_explanation", e.target.value)}
              placeholder="Explain any credit claimed on Line 20…"
            />
          )}
        </div>
        <LineRow fieldKey="line21_total_due" label="Line 21 — Total Due" fields={fields} generation={generation} onChangeField={updateField} emphasis readOnly={readOnly} />
      </section>

      {/* Page 2 — county schedule */}
      <section className="border-t border-line pt-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-faint mb-2">County Schedule</h4>
        {countyRows.length === 0 ? (
          <p className="text-sm text-faint">No counties computed yet — recompute to populate this schedule.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-xs text-faint uppercase tracking-wide border-b border-line">
                  <th className="py-1.5 pr-2 font-medium">County</th>
                  <th className="py-1.5 px-2 font-medium text-right">2% Tax</th>
                  <th className="py-1.5 px-2 font-medium text-right">2.25% Tax</th>
                  <th className="py-1.5 pl-2 font-medium text-right">Transit Tax</th>
                </tr>
              </thead>
              <tbody>
                {countyRows.map((c) => (
                  <tr key={c.code} className="border-b border-line/60">
                    <td className="py-1.5 pr-2 text-body">{c.name}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-body">{fmtCents(num(fields[`county_${c.code}_2pct`]))}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-body">{fmtCents(num(fields[`county_${c.code}_225pct`]))}</td>
                    <td className="py-1.5 pl-2 text-right tabular-nums text-body">{fmtCents(num(fields[`county_${c.code}_transit`]))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** A label + value/input row for a single worksheet line, read-only or editable per `isComputedField` (and always read-only when `readOnly` is set). */
function LineRow({
  fieldKey,
  label,
  fields,
  generation,
  emphasis,
  onChangeField,
  readOnly = false,
}: {
  fieldKey: string;
  label: string;
  fields: Fields;
  generation: string;
  emphasis?: boolean;
  onChangeField: (key: string, value: number | string | null) => void;
  readOnly?: boolean;
}) {
  const computed = isComputedField(fieldKey);
  return (
    <div className="flex items-center justify-between gap-4">
      <span className={`text-sm ${emphasis ? "font-semibold text-strong" : "text-body"}`}>{label}</span>
      {computed ? (
        <span className={`text-sm tabular-nums ${emphasis ? "font-semibold text-strong" : "text-body"}`}>
          {fmtCents(num(fields[fieldKey]))}
        </span>
      ) : (
        <div className="w-32">
          <MoneyCell fieldKey={fieldKey} fields={fields} generation={generation} onChangeField={onChangeField} readOnly={readOnly} />
        </div>
      )}
    </div>
  );
}

/** A single money cell: read-only formatted text for computed fields (or when `readOnly`), an editable money input otherwise. */
function MoneyCell({
  fieldKey,
  fields,
  generation,
  onChangeField,
  readOnly = false,
}: {
  fieldKey: string;
  fields: Fields;
  generation: string;
  onChangeField: (key: string, value: number | string | null) => void;
  readOnly?: boolean;
}) {
  const value = fields[fieldKey];
  if (isComputedField(fieldKey) || readOnly) {
    return <span className="tabular-nums text-body">{fmtCents(num(value))}</span>;
  }
  return (
    <MoneyInput
      key={`${fieldKey}-${generation}`}
      initialCents={value}
      onCommit={(cents) => onChangeField(fieldKey, cents)}
    />
  );
}

/**
 * Money `<input>` with its own local text state so a keystroke never gets
 * reformatted mid-edit by the recompute round-trip — only remounting (via
 * the caller's `key`) resyncs the displayed text to an externally-changed
 * value (e.g. after a server recompute).
 */
function MoneyInput({
  initialCents,
  onCommit,
}: {
  initialCents: number | string | null | undefined;
  onCommit: (cents: number) => void;
}) {
  const [text, setText] = useState(() => centsToDollarString(initialCents));
  return (
    <input
      type="number"
      step="0.01"
      inputMode="decimal"
      className="inp-sm text-right"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onCommit(dollarStringToCents(e.target.value));
      }}
    />
  );
}
