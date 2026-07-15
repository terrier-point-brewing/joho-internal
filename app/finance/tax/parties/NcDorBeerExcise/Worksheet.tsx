"use client";

/**
 * NC DOR Beer Excise (Form B-C-710) editable worksheet — the Export Summary
 * (gallons) channel breakdown, followed by Part 1's Lines 1-11 computation.
 * Computed fields (per `fieldOwnership.ts`) render read-only and always
 * reflect the current `fields`; manual fields render as `.inp-sm` inputs
 * (whole-gallon or money). Every edit recomputes the full waterfall
 * client-side via `recomputeClientBeerTotals` (the exact server formula) so
 * the totals update instantly — the server remains the source of truth on
 * the next autosave/recompute.
 *
 * Filer identity (legal name, FEIN, ABC permit, address, etc.) is NOT
 * rendered here — it's shown once, above every party's worksheet, by
 * `TaxWorksheetShell`'s `IdentityHeader` (sourced from `tax_entity_profile`
 * / `tax_registrations` via Finance > Settings > Tax Profile).
 *
 * There is no "return filed timely" / "amended" / "no transactions this
 * period" checkbox: timely filing (and therefore the Line 7 discount) is
 * derived automatically server-side from the filing period's due date (see
 * `lib/tax/parties/ncDorBeerExcise/calc.ts`'s `isFiledTimely`), and the
 * other two flags were never read by any calculation.
 *
 * `readOnly` (set by `TaxWorksheetShell` once the parent task is
 * `completed`) forces every manual field to render display-only, the same
 * as an already-computed field, and makes `updateField` a no-op — a
 * submitted filing's figures can no longer be edited.
 */
import { useState } from "react";
import { fmtCents } from "@/lib/utils/formatting";
import { formatNumber } from "@/lib/format";
import {
  recomputeClientBeerTotals,
  gallonsToString,
  stringToGallons,
  centsToDollarString,
  dollarStringToCents,
  floorCentsToWholeDollar,
} from "@/lib/tax/beerExciseWorksheetMath";
import { isComputedField } from "./fieldOwnership";
import type { PartyWorksheetProps } from "../registry";

type Fields = Record<string, number | string | null>;

function num(v: number | string | null | undefined): number {
  return Number(v ?? 0);
}

const CHANNEL_ROWS: { fieldKey: string; label: string }[] = [
  { fieldKey: "gal_distribution", label: "Distribution" },
  { fieldKey: "gal_contract", label: "Contract brewing" },
  { fieldKey: "gal_taproom", label: "Taproom" },
  { fieldKey: "gal_wholesale", label: "Wholesale (deduction)" },
];

export default function NcDorBeerExciseWorksheet({
  fields,
  computedAt,
  onFieldsChange,
  readOnly = false,
}: PartyWorksheetProps) {
  // Keyed into every manual input so a fresh recompute (which changes
  // computedAt) remounts them and resyncs their displayed text to the new
  // server value — a same-generation keystroke never remounts, so the
  // user's in-progress typing is never clobbered by its own recompute.
  const generation = computedAt ?? "initial";

  function updateField(key: string, value: number | string | null) {
    if (readOnly) return;
    onFieldsChange(recomputeClientBeerTotals({ ...fields, [key]: value }));
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Export Summary (gallons) — per-channel breakdown feeding Line 2 */}
      <section>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-faint mb-2">Export Summary (gallons)</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-xs text-faint uppercase tracking-wide border-b border-line">
                <th className="py-1.5 pr-2 font-medium">Channel</th>
                <th className="py-1.5 pl-2 font-medium text-right">Gallons</th>
              </tr>
            </thead>
            <tbody>
              {CHANNEL_ROWS.map((c) => (
                <tr key={c.fieldKey} className="border-b border-line/60">
                  <td className="py-1.5 pr-2 text-body">{c.label}</td>
                  <td className="py-1.5 pl-2 text-right tabular-nums text-body">
                    {formatNumber(num(fields[c.fieldKey]), 0)}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="py-1.5 pr-2 font-semibold text-strong">Total</td>
                <td className="py-1.5 pl-2 text-right tabular-nums font-semibold text-strong">
                  {formatNumber(num(fields.gal_produced_for_sale), 0)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Part 1 — Computation of Beer Excise Tax (Form B-C-710, Lines 1-11) */}
      <section className="flex flex-col gap-2">
        <div className="border border-line rounded px-3 py-2 mb-1">
          <h4 className="text-sm font-bold text-strong">Part 1. Computation of Beer Excise Tax</h4>
        </div>

        <GallonRow fieldKey="gal_beginning_inventory" label="1. Beginning Inventory (gal)" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <GallonRow fieldKey="gal_produced_for_sale" label="2. Total Gallons Received (From Export Summary, Total)" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <GallonRow fieldKey="gal_total_available" label="3. Total Gallons Available" fields={fields} generation={generation} onChangeField={updateField} emphasis readOnly={readOnly} />

        <div className="pl-4 ml-1 border-l-2 border-line/60 flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-faint">4. Allowable Deductions / Adjustments</p>
          <GallonRow fieldKey="gal_allowable_deductions" label="4a. Allowable Deductions — Wholesale (gal)" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
          <GallonRow fieldKey="gal_deduction_other" label="4a. Allowable Deductions — Other (gal)" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
          <GallonRow fieldKey="gal_adjustments_part3" label="4b. Adjustments to Taxable Transactions (gal)" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
          <GallonRow fieldKey="gal_military_part4" label="4c. Military Sales (gal)" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
          <GallonRow fieldKey="gal_ending_inventory" label="4d. Ending Inventory (gal)" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        </div>

        <GallonRow fieldKey="gal_taxable" label="5. Total Taxable Gallons" fields={fields} generation={generation} onChangeField={updateField} emphasis readOnly={readOnly} />
        <LineRow fieldKey="cents_excise_due" label="6. Total Excise Tax Due" fields={fields} generation={generation} onChangeField={updateField} emphasis readOnly={readOnly} />
        <LineRow fieldKey="cents_discount" label="7. Discount (2% — applied automatically when filed by the due date)" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <LineRow fieldKey="cents_net_tax_due" label="8. Net Tax Due" fields={fields} generation={generation} onChangeField={updateField} emphasis readOnly={readOnly} />
        <LineRow fieldKey="cents_penalty" label="9. Penalty" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <LineRow fieldKey="cents_interest" label="10. Interest" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <LineRow fieldKey="cents_total_payment_due" label="11. Total Payment Due" fields={fields} generation={generation} onChangeField={updateField} emphasis readOnly={readOnly} />
      </section>

      {/* Signature */}
      <section className="flex flex-col gap-1 border-t border-line pt-4">
        <label className="text-xs text-faint" htmlFor="signer_date">
          Date Signed
        </label>
        {readOnly ? (
          <p id="signer_date" className="text-sm text-body">
            {typeof fields.signer_date === "string" && fields.signer_date ? fields.signer_date : "—"}
          </p>
        ) : (
          <input
            id="signer_date"
            key={`signer_date-${generation}`}
            type="text"
            className="inp-sm"
            defaultValue={typeof fields.signer_date === "string" ? fields.signer_date : ""}
            onChange={(e) => updateField("signer_date", e.target.value)}
            placeholder="MM-DD-YYYY"
          />
        )}
      </section>
    </div>
  );
}

/** A label + value/input row for a single money worksheet line, read-only or editable per `isComputedField` (and always read-only when `readOnly` is set). Read-only display floors to the whole dollar per Form B-C-710 (no cents reported). */
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
    <div className="flex items-center justify-between gap-4 border-b border-line/40 pb-1.5">
      <span className={`text-sm ${emphasis ? "font-semibold text-strong" : "text-body"}`}>{label}</span>
      {computed || readOnly ? (
        <span className={`text-sm tabular-nums ${emphasis ? "font-semibold text-strong" : "text-body"}`}>
          {fmtCents(floorCentsToWholeDollar(fields[fieldKey]))}
        </span>
      ) : (
        <div className="w-32">
          <MoneyInput
            key={`${fieldKey}-${generation}`}
            initialCents={fields[fieldKey]}
            onCommit={(cents) => onChangeField(fieldKey, cents)}
          />
        </div>
      )}
    </div>
  );
}

/** A label + value/input row for a single whole-gallon worksheet line, read-only or editable per `isComputedField` (and always read-only when `readOnly` is set). Read-only display is comma-grouped (e.g. `1,234`). */
function GallonRow({
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
    <div className="flex items-center justify-between gap-4 border-b border-line/40 pb-1.5">
      <span className={`text-sm ${emphasis ? "font-semibold text-strong" : "text-body"}`}>{label}</span>
      {computed || readOnly ? (
        <span className={`text-sm tabular-nums ${emphasis ? "font-semibold text-strong" : "text-body"}`}>
          {formatNumber(num(fields[fieldKey]), 0)}
        </span>
      ) : (
        <div className="w-32">
          <GallonInput
            key={`${fieldKey}-${generation}`}
            initialGallons={fields[fieldKey]}
            onCommit={(gallons) => onChangeField(fieldKey, gallons)}
          />
        </div>
      )}
    </div>
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

/**
 * Whole-gallon `<input>` with its own local text state, mirroring
 * `MoneyInput`'s remount-to-resync behavior via the caller's `key`.
 */
function GallonInput({
  initialGallons,
  onCommit,
}: {
  initialGallons: number | string | null | undefined;
  onCommit: (gallons: number) => void;
}) {
  const [text, setText] = useState(() => gallonsToString(initialGallons));
  return (
    <input
      type="number"
      step="1"
      inputMode="numeric"
      className="inp-sm text-right"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onCommit(stringToGallons(e.target.value));
      }}
    />
  );
}
