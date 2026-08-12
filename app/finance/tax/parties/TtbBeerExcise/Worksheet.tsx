"use client";

/**
 * TTB F 5130.Pilot-B editable worksheet — the removals summary (barrels) by
 * shipment channel, then the form itself in printed order: the excise tax
 * calculation (Lines 8-15), Schedule A's two adjustment tables (Lines 16-27),
 * brewery operations (Lines 28-44), the controlled-group and contract
 * questions (Lines 45-46), and the signature date (Line 50).
 *
 * Computed fields (per `fieldOwnership.ts`) render read-only and always reflect
 * the current `fields`; manual fields render as `.inp-sm` inputs. Every edit
 * recomputes the whole form client-side via `recomputeClientTtbTotals` (the
 * exact server formula) so totals update instantly — the server remains the
 * source of truth on the next autosave/recompute.
 *
 * Most of this form is read-only by design. Lines 28-44 in particular carry no
 * inputs at all: this brewery reports beer produced equal to beer removed and
 * nothing on hand at period end, so the entire operations half is derived. The
 * inputs that do exist are the ones the shipment feed genuinely cannot answer —
 * exports and transfers in bond, losses, Schedule A adjustments, and payment.
 *
 * Filer identity (brewery name, EIN, brewer's notice number, premises address,
 * contact) is NOT rendered here — it's shown once, above every party's
 * worksheet, by `TaxWorksheetShell`'s `IdentityHeader`.
 *
 * `readOnly` (set by `TaxWorksheetShell` once the parent task is `completed`)
 * forces every manual field to render display-only and makes `updateField` a
 * no-op — a submitted filing's figures can no longer be edited.
 */
import { useState } from "react";
import { fmtCents } from "@/lib/utils/formatting";
import { formatNumber } from "@/lib/format";
import {
  recomputeClientTtbTotals,
  barrelsToString,
  stringToBarrels,
  centsToDollarString,
  dollarStringToCents,
  rateMicrosToString,
  stringToRateMicros,
} from "@/lib/tax/ttbExciseWorksheetMath";
import { SCHEDULE_A_ROWS } from "@/lib/tax/parties/ttbBeerExcise/rates";
import { decreasingRowKeys, increasingRowKeys } from "@/lib/tax/parties/ttbBeerExcise/derive";
import { isComputedField } from "./fieldOwnership";
import type { PartyWorksheetProps } from "../registry";

type Fields = Record<string, number | string | null>;

function num(v: number | string | null | undefined): number {
  return Number(v ?? 0);
}

function str(v: number | string | null | undefined): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

const CHANNEL_ROWS: { fieldKey: string; label: string }[] = [
  { fieldKey: "bbl_distribution", label: "Distribution" },
  { fieldKey: "bbl_contract", label: "Contract brewing" },
  { fieldKey: "bbl_taproom", label: "Taproom" },
  { fieldKey: "bbl_wholesale", label: "Wholesale" },
];

export default function TtbBeerExciseWorksheet({
  fields,
  computedAt,
  onFieldsChange,
  readOnly = false,
}: PartyWorksheetProps) {
  // Keyed into every manual input so a fresh recompute (which changes
  // computedAt) remounts them and resyncs their displayed text to the new
  // server value — a same-generation keystroke never remounts, so the user's
  // in-progress typing is never clobbered by its own recompute.
  const generation = computedAt ?? "initial";

  function updateField(key: string, value: number | string | null) {
    if (readOnly) return;
    onFieldsChange(recomputeClientTtbTotals({ ...fields, [key]: value }));
  }

  const rowProps = { fields, generation, onChangeField: updateField, readOnly };
  const isFinal = num(fields.flag_final_return) === 1;
  const inControlledGroup = num(fields.flag_controlled_group) === 1;

  return (
    <div className="flex flex-col gap-6">
      {/* Return header — Lines 1, 2a-2c, 3a-3e */}
      <section className="flex flex-col gap-2">
        <SectionHeading>Return Header</SectionHeading>
        <TextRow fieldKey="serial_number" label="1. Serial Number" {...rowProps} />
        <TextRow fieldKey="period_label" label="3b. Period Covers" {...rowProps} />
        <div className="flex items-center justify-between gap-4 border-b border-line/40 pb-1.5">
          <span className="text-sm text-body">3c. Excise Tax Period</span>
          <span className="text-sm tabular-nums text-body">
            {str(fields.period_start) || "—"} – {str(fields.period_end) || "—"}
          </span>
        </div>
        <TextRow fieldKey="submission_version" label="3d. Submission Version" {...rowProps} />
        <CheckRow fieldKey="flag_final_return" label="3e. Final tax return — discontinuation" {...rowProps} />
        {isFinal && (
          <div className="pl-4 ml-1 border-l-2 border-line/60 flex flex-col gap-2">
            <TextRow fieldKey="final_return_date" label="3e. Discontinuation date" placeholder="MM-DD-YYYY" {...rowProps} />
          </div>
        )}
      </section>

      {/* Payment — Lines 2a-2c */}
      <section className="flex flex-col gap-2">
        <SectionHeading>Payment</SectionHeading>
        <MoneyRow fieldKey="cents_amount_paid" label="2b. Amount Paid With This Submission" {...rowProps} />
        <TextRow fieldKey="prev_serial_number" label="2c. Serial Number of prior submission (amended returns)" {...rowProps} />
        <MoneyRow fieldKey="cents_previously_paid" label="2a. Amount Previously Paid" {...rowProps} />
        <TextRow fieldKey="payment_form" label="2c. Form of Payment" placeholder="EFT / check / money order" {...rowProps} />
      </section>

      {/* Removals summary — the shipment feed behind Line 8 */}
      <section>
        <SectionHeading>Removals This Period (barrels)</SectionHeading>
        <p className="text-xs text-faint mb-2">
          Every shipment channel is a taxable federal removal. Unlike NC Form B-C-710, wholesale is not excluded — the
          brewery owes the federal tax on removal regardless of who buys the beer.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-xs text-faint uppercase tracking-wide border-b border-line">
                <th className="py-1.5 pr-2 font-medium">Channel</th>
                <th className="py-1.5 pl-2 font-medium text-right">Barrels</th>
              </tr>
            </thead>
            <tbody>
              {CHANNEL_ROWS.map((c) => (
                <tr key={c.fieldKey} className="border-b border-line/60">
                  <td className="py-1.5 pr-2 text-body">{c.label}</td>
                  <td className="py-1.5 pl-2 text-right tabular-nums text-body">{formatNumber(num(fields[c.fieldKey]), 2)}</td>
                </tr>
              ))}
              <tr>
                <td className="py-1.5 pr-2 font-semibold text-strong">Total removals</td>
                <td className="py-1.5 pl-2 text-right tabular-nums font-semibold text-strong">
                  {formatNumber(num(fields.bbl_total_removals), 2)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Excise Tax Calculation — Lines 8-15 */}
      <section className="flex flex-col gap-2">
        <SectionHeading boxed>Excise Tax Calculation</SectionHeading>

        <TaxTierRow
          label="8. Beer produced and removed @ $3.50 per barrel"
          note="I (or another brewery in my controlled group) produced this beer and I am eligible for this rate."
          barrelKey="bbl_rate_reduced"
          centsKey="cents_tax_reduced"
          eligible={num(fields.flag_reduced_rate_eligible) === 1}
          fields={fields}
        />
        <TaxTierRow
          label="9. Beer produced and removed @ $16.00 per barrel"
          note="I (or another brewery in my controlled group) produced this beer and I am eligible for this rate."
          barrelKey="bbl_rate_16"
          centsKey="cents_tax_16"
          fields={fields}
        />
        <TaxTierRow label="10. Beer Removed @ $18.00 per barrel" barrelKey="bbl_rate_18" centsKey="cents_tax_18" fields={fields} />

        <div className="flex items-center justify-between gap-4 border-b border-line/40 pb-1.5">
          <span className="text-sm font-semibold text-strong">
            11. Total Taxable Beer Removed and Total Excise Tax Liability (lines 8 + 9 + 10)
          </span>
          <span className="flex items-center gap-6">
            <span className="text-sm tabular-nums font-semibold text-strong w-24 text-right">
              {formatNumber(num(fields.bbl_total_taxable), 2)}
            </span>
            <span className="text-sm tabular-nums font-semibold text-strong w-28 text-right">
              {fmtCents(num(fields.cents_total_tax))}
            </span>
          </span>
        </div>

        <MoneyRow fieldKey="cents_increasing_adjustments" label="12. Total Increasing Adjustments (line 23)" {...rowProps} />
        <MoneyRow fieldKey="cents_gross_due" label="13. Gross Amount Due (lines 11 + 12)" emphasis {...rowProps} />
        <MoneyRow fieldKey="cents_decreasing_adjustments" label="14. Total Decreasing Adjustments (line 27)" {...rowProps} />
        <MoneyRow fieldKey="cents_amount_due" label="15. Amount Due With This Return (line 13 minus line 14)" emphasis {...rowProps} />
      </section>

      {/* Schedule A — Lines 16-27 */}
      <section className="flex flex-col gap-4">
        <SectionHeading boxed>Schedule A — Increasing and Decreasing Adjustments</SectionHeading>

        <div>
          <h5 className="text-xs font-semibold uppercase tracking-wide text-faint mb-2">Increasing Adjustments (lines 16-19)</h5>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-xs text-faint uppercase tracking-wide border-b border-line">
                  <th className="py-1.5 pr-2 font-medium">(a) Type</th>
                  <th className="py-1.5 px-2 font-medium">(b) Supporting information</th>
                  <th className="py-1.5 px-2 font-medium">(c) Unit</th>
                  <th className="py-1.5 px-2 font-medium text-right">(d) Quantity</th>
                  <th className="py-1.5 px-2 font-medium text-right">(e) Rate</th>
                  <th className="py-1.5 pl-2 font-medium text-right">(f) Tax due</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: SCHEDULE_A_ROWS }, (_, i) => {
                  const keys = increasingRowKeys(i + 1);
                  return (
                    <tr key={keys.type} className="border-b border-line/60">
                      <td className="py-1.5 pr-2">
                        <CellText fieldKey={keys.type} {...rowProps} />
                      </td>
                      <td className="py-1.5 px-2">
                        <CellText fieldKey={keys.info} {...rowProps} />
                      </td>
                      <td className="py-1.5 px-2">
                        <CellText fieldKey={keys.unit} {...rowProps} />
                      </td>
                      <td className="py-1.5 px-2">
                        <CellBarrels fieldKey={keys.quantity} {...rowProps} />
                      </td>
                      <td className="py-1.5 px-2">
                        <CellRate fieldKey={keys.rateMicros} {...rowProps} />
                      </td>
                      <td className="py-1.5 pl-2 text-right tabular-nums text-body">{fmtCents(num(fields[keys.cents]))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <MoneyRow fieldKey="cents_increasing_tax_due" label="20. Total Increasing Tax Due" {...rowProps} />
        <MoneyRow fieldKey="cents_interest" label="21. Interest" {...rowProps} />
        <MoneyRow fieldKey="cents_penalties" label="22. Penalties" {...rowProps} />
        <MoneyRow fieldKey="cents_increasing_adjustments" label="23. Total Increasing Adjustments (lines 20 + 21 + 22)" emphasis {...rowProps} />

        <div>
          <h5 className="text-xs font-semibold uppercase tracking-wide text-faint mb-2">Decreasing Adjustments — Claims for Credit (lines 24-26)</h5>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-xs text-faint uppercase tracking-wide border-b border-line">
                  <th className="py-1.5 pr-2 font-medium">(a) Type</th>
                  <th className="py-1.5 px-2 font-medium">(b) Supporting information</th>
                  <th className="py-1.5 px-2 font-medium text-right">(c) Approved claim</th>
                  <th className="py-1.5 px-2 font-medium text-right">(d) Balance left on claim</th>
                  <th className="py-1.5 pl-2 font-medium text-right">(e) Adjustment this period</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: SCHEDULE_A_ROWS }, (_, i) => {
                  const keys = decreasingRowKeys(i + 1);
                  return (
                    <tr key={keys.type} className="border-b border-line/60">
                      <td className="py-1.5 pr-2">
                        <CellText fieldKey={keys.type} {...rowProps} />
                      </td>
                      <td className="py-1.5 px-2">
                        <CellText fieldKey={keys.info} {...rowProps} />
                      </td>
                      <td className="py-1.5 px-2">
                        <CellMoney fieldKey={keys.claimCents} {...rowProps} />
                      </td>
                      <td className="py-1.5 px-2">
                        <CellMoney fieldKey={keys.balanceCents} {...rowProps} />
                      </td>
                      <td className="py-1.5 pl-2">
                        <CellMoney fieldKey={keys.amountCents} {...rowProps} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <MoneyRow fieldKey="cents_decreasing_adjustments" label="27. Total Decreasing Tax Adjustments" emphasis {...rowProps} />
      </section>

      {/* Brewery Operations — Lines 28-44 */}
      <section className="flex flex-col gap-2">
        <SectionHeading boxed>Brewery Operations (barrels)</SectionHeading>
        <p className="text-xs text-faint">
          Derived, not entered. Beer produced is reported equal to beer removed, so line 44 closes at zero. Only the
          movements the shipment feed cannot see — exports, transfers in bond, losses — are editable.
        </p>

        <BblRow fieldKey="bbl_opening" label="28. Total Beer On Hand At Beginning of Period" {...rowProps} />

        <SubHeading>I. Additions to beer inventory</SubHeading>
        <BblRow fieldKey="bbl_produced" label="29. Total Beer Produced This Period" {...rowProps} />
        <BblRow fieldKey="bbl_received_in_bond" label="30. Beer Received in Bond" {...rowProps} />
        <BblRow fieldKey="bbl_returned_after_removal" label="31. Beer Returned to Brewery After Removal" {...rowProps} />
        <BblRow fieldKey="bbl_inventory_overage" label="32. Physical Inventory Disclosed an Overage" {...rowProps} />
        <BblRow fieldKey="bbl_total_available" label="33. On Hand at Beginning Plus Additions (28 + 29 + 30 + 31 + 32)" emphasis {...rowProps} />

        <SubHeading>II.A. Beer removed without payment of tax</SubHeading>
        <BblRow fieldKey="bbl_exports_without_tax" label="34. Exports Without Payment of Tax" {...rowProps} />
        <BblRow fieldKey="bbl_transfers_in_bond" label="35. Transfers In Bond" {...rowProps} />
        <BblRow fieldKey="bbl_other_removals_without_tax" label="36. Other Removals Without Payment of Tax" {...rowProps} />
        <BblRow fieldKey="bbl_removals_without_tax_total" label="37. Total Removals Without Payment of Tax (34 + 35 + 36)" emphasis {...rowProps} />

        <SubHeading>II.B. Other inventory subtractions</SubHeading>
        <BblRow fieldKey="bbl_consumed_or_destroyed" label="38. Beer Consumed or Destroyed on Brewery Premises" {...rowProps} />
        <BblRow fieldKey="bbl_losses" label="39. Losses, Including Breakage and Theft" {...rowProps} />
        <BblRow fieldKey="bbl_inventory_shortage" label="40. Physical Inventory Disclosed a Shortage" {...rowProps} />
        <CheckRow fieldKey="flag_shortages_taxpaid" label="40. I have taxpaid all unexplained shortages on Schedule A above." {...rowProps} />

        <SubHeading>III. Inventory reconciliation</SubHeading>
        <BblRow fieldKey="bbl_available_recon" label="41. On Hand at Beginning Plus Additions (same as line 33)" {...rowProps} />
        <BblRow fieldKey="bbl_pilot_a_removals" label="42a. Removed Taxpaid on TTB F 5130.Pilot-A (semimonthly only)" {...rowProps} />
        <BblRow fieldKey="bbl_taxpaid_removals_total" label="42b. Total Removed Taxpaid This Operational Period (11a + 42a)" emphasis {...rowProps} />
        <BblRow fieldKey="bbl_other_subtractions" label="43. Total Other Subtractions From Inventory (37 + 38 + 39 + 40)" {...rowProps} />
        <BblRow fieldKey="bbl_ending" label="44. Total Beer On Hand At End of Period (41 minus 42b and 43)" emphasis {...rowProps} />
      </section>

      {/* Controlled group and contract arrangements — Lines 45-46 */}
      <section className="flex flex-col gap-2">
        <SectionHeading boxed>IV. Controlled Group Membership and Contract Arrangements</SectionHeading>
        <CheckRow
          fieldKey="flag_controlled_group"
          label="45. Are you part of a Controlled Group that includes domestic and/or foreign breweries?"
          {...rowProps}
        />
        {inControlledGroup && (
          <div className="pl-4 ml-1 border-l-2 border-line/60 flex flex-col gap-2">
            <CheckRow fieldKey="flag_controlled_group_domestic" label="45a. Does the controlled group include domestic breweries?" {...rowProps} />
            <CheckRow fieldKey="flag_controlled_group_foreign" label="45b. Does the controlled group include foreign breweries?" {...rowProps} />
          </div>
        )}
        <CheckRow
          fieldKey="flag_contract_removals"
          label="46. Did you remove and pay tax on beer produced under contract for other entities?"
          {...rowProps}
        />
      </section>

      {/* Signature — Line 50 */}
      <section className="flex flex-col gap-1 border-t border-line pt-4">
        <label className="text-xs text-faint" htmlFor="signer_date">
          50. Date Signed
        </label>
        {readOnly ? (
          <p id="signer_date" className="text-sm text-body">
            {str(fields.signer_date) || "—"}
          </p>
        ) : (
          <input
            id="signer_date"
            key={`signer_date-${generation}`}
            type="text"
            className="inp-sm"
            defaultValue={str(fields.signer_date)}
            onChange={(e) => updateField("signer_date", e.target.value)}
            placeholder="MM-DD-YYYY"
          />
        )}
      </section>
    </div>
  );
}

function SectionHeading({ children, boxed }: { children: React.ReactNode; boxed?: boolean }) {
  if (boxed) {
    return (
      <div className="border border-line rounded px-3 py-2 mb-1">
        <h4 className="text-sm font-bold text-strong">{children}</h4>
      </div>
    );
  }
  return <h4 className="text-xs font-semibold uppercase tracking-wide text-faint mb-2">{children}</h4>;
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-semibold uppercase tracking-wide text-faint pt-2">{children}</p>;
}

interface RowProps {
  fieldKey: string;
  fields: Fields;
  generation: string;
  emphasis?: boolean;
  onChangeField: (key: string, value: number | string | null) => void;
  readOnly?: boolean;
}

/** Lines 8-10: barrels and tax due side by side, with the rate-eligibility attestation the form prints under lines 8 and 9. */
function TaxTierRow({
  label,
  note,
  barrelKey,
  centsKey,
  eligible,
  fields,
}: {
  label: string;
  note?: string;
  barrelKey: string;
  centsKey: string;
  eligible?: boolean;
  fields: Fields;
}) {
  return (
    <div className="border-b border-line/40 pb-1.5">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm text-body">{label}</span>
        <span className="flex items-center gap-6">
          <span className="text-sm tabular-nums text-body w-24 text-right">{formatNumber(num(fields[barrelKey]), 2)}</span>
          <span className="text-sm tabular-nums text-body w-28 text-right">{fmtCents(num(fields[centsKey]))}</span>
        </span>
      </div>
      {note && (
        <p className="text-xs text-faint mt-0.5">
          {eligible ? "☑" : "☐"} {note}
        </p>
      )}
    </div>
  );
}

/** A label + value/input row for a barrel line, read-only or editable per `isComputedField`. */
function BblRow({ fieldKey, label, fields, generation, emphasis, onChangeField, readOnly = false }: RowProps & { label: string }) {
  const computed = isComputedField(fieldKey);
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line/40 pb-1.5">
      <span className={`text-sm ${emphasis ? "font-semibold text-strong" : "text-body"}`}>{label}</span>
      {computed || readOnly ? (
        <span className={`text-sm tabular-nums ${emphasis ? "font-semibold text-strong" : "text-body"}`}>
          {formatNumber(num(fields[fieldKey]), 2)}
        </span>
      ) : (
        <div className="w-32">
          <BarrelInput
            key={`${fieldKey}-${generation}`}
            initialBarrels={fields[fieldKey]}
            onCommit={(bbl) => onChangeField(fieldKey, bbl)}
          />
        </div>
      )}
    </div>
  );
}

/** A label + value/input row for a money line, read-only or editable per `isComputedField`. */
function MoneyRow({ fieldKey, label, fields, generation, emphasis, onChangeField, readOnly = false }: RowProps & { label: string }) {
  const computed = isComputedField(fieldKey);
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line/40 pb-1.5">
      <span className={`text-sm ${emphasis ? "font-semibold text-strong" : "text-body"}`}>{label}</span>
      {computed || readOnly ? (
        <span className={`text-sm tabular-nums ${emphasis ? "font-semibold text-strong" : "text-body"}`}>
          {fmtCents(num(fields[fieldKey]))}
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

/** A label + value/input row for a free-text line. */
function TextRow({
  fieldKey,
  label,
  placeholder,
  fields,
  generation,
  onChangeField,
  readOnly = false,
}: RowProps & { label: string; placeholder?: string }) {
  const computed = isComputedField(fieldKey);
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line/40 pb-1.5">
      <span className="text-sm text-body">{label}</span>
      {computed || readOnly ? (
        <span className="text-sm text-body">{str(fields[fieldKey]) || "—"}</span>
      ) : (
        <div className="w-48">
          <input
            key={`${fieldKey}-${generation}`}
            type="text"
            className="inp-sm w-full"
            defaultValue={str(fields[fieldKey])}
            placeholder={placeholder}
            onChange={(e) => onChangeField(fieldKey, e.target.value)}
          />
        </div>
      )}
    </div>
  );
}

/** A yes/no line. Stored as 1/0 so it lives in the same numeric field space as every other worksheet value. */
function CheckRow({ fieldKey, label, fields, onChangeField, readOnly = false }: RowProps & { label: string }) {
  const computed = isComputedField(fieldKey);
  const checked = num(fields[fieldKey]) === 1;
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line/40 pb-1.5">
      <span className="text-sm text-body">{label}</span>
      {computed || readOnly ? (
        <span className="text-sm text-body">{checked ? "Yes" : "No"}</span>
      ) : (
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={checked}
          onChange={(e) => onChangeField(fieldKey, e.target.checked ? 1 : 0)}
        />
      )}
    </div>
  );
}

/** Schedule A grid cell — free text. */
function CellText({ fieldKey, fields, generation, onChangeField, readOnly = false }: RowProps) {
  if (readOnly || isComputedField(fieldKey)) {
    return <span className="text-sm text-body">{str(fields[fieldKey]) || "—"}</span>;
  }
  return (
    <input
      key={`${fieldKey}-${generation}`}
      type="text"
      className="inp-sm w-full"
      defaultValue={str(fields[fieldKey])}
      onChange={(e) => onChangeField(fieldKey, e.target.value)}
    />
  );
}

/** Schedule A grid cell — barrels (or any unit quantity). */
function CellBarrels({ fieldKey, fields, generation, onChangeField, readOnly = false }: RowProps) {
  if (readOnly || isComputedField(fieldKey)) {
    return <span className="block text-sm text-right tabular-nums text-body">{formatNumber(num(fields[fieldKey]), 2)}</span>;
  }
  return (
    <BarrelInput
      key={`${fieldKey}-${generation}`}
      initialBarrels={fields[fieldKey]}
      onCommit={(bbl) => onChangeField(fieldKey, bbl)}
    />
  );
}

/** Schedule A grid cell — money. */
function CellMoney({ fieldKey, fields, generation, onChangeField, readOnly = false }: RowProps) {
  if (readOnly || isComputedField(fieldKey)) {
    return <span className="block text-sm text-right tabular-nums text-body">{fmtCents(num(fields[fieldKey]))}</span>;
  }
  return (
    <MoneyInput
      key={`${fieldKey}-${generation}`}
      initialCents={fields[fieldKey]}
      onCommit={(cents) => onChangeField(fieldKey, cents)}
    />
  );
}

/** Schedule A grid cell — an applicable rate in dollars per unit, stored as micro-dollars. */
function CellRate({ fieldKey, fields, generation, onChangeField, readOnly = false }: RowProps) {
  if (readOnly || isComputedField(fieldKey)) {
    return <span className="block text-sm text-right tabular-nums text-body">{rateMicrosToString(fields[fieldKey])}</span>;
  }
  return (
    <RateInput
      key={`${fieldKey}-${generation}`}
      initialMicros={fields[fieldKey]}
      onCommit={(micros) => onChangeField(fieldKey, micros)}
    />
  );
}

/**
 * Money `<input>` with its own local text state so a keystroke never gets
 * reformatted mid-edit by the recompute round-trip — only remounting (via the
 * caller's `key`) resyncs the displayed text to an externally-changed value.
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
      className="inp-sm text-right w-full"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onCommit(dollarStringToCents(e.target.value));
      }}
    />
  );
}

/** Barrel `<input>` (2 decimal places), mirroring `MoneyInput`'s remount-to-resync behavior. */
function BarrelInput({
  initialBarrels,
  onCommit,
}: {
  initialBarrels: number | string | null | undefined;
  onCommit: (barrels: number) => void;
}) {
  const [text, setText] = useState(() => barrelsToString(initialBarrels));
  return (
    <input
      type="number"
      step="0.01"
      inputMode="decimal"
      className="inp-sm text-right w-full"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onCommit(stringToBarrels(e.target.value));
      }}
    />
  );
}

/** Per-unit rate `<input>` in dollars, committed as micro-dollars. */
function RateInput({
  initialMicros,
  onCommit,
}: {
  initialMicros: number | string | null | undefined;
  onCommit: (micros: number) => void;
}) {
  const [text, setText] = useState(() => rateMicrosToString(initialMicros));
  return (
    <input
      type="number"
      step="0.01"
      inputMode="decimal"
      className="inp-sm text-right w-full"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onCommit(stringToRateMicros(e.target.value));
      }}
    />
  );
}
