/**
 * What a refund against an invoice is allowed to be, and what it comes to.
 *
 * This module is the single source of truth for refund legality and refund
 * math, consumed by BOTH the issue-refund route (enforcement) and the Credit
 * Invoice modal (affordances), so the UI can never offer a refund the API
 * would reject. Same contract as lib/production/shipmentEdit.ts.
 *
 * Pure — no I/O, no Supabase import — so every guard is unit-testable.
 *
 * Three things are easy to get wrong here:
 *
 *  1. NOT EVERY LINE IS PRICED PER UNIT. Square carries the excise line as
 *     quantity 1 with the entire dollar amount in unit_price_cents (see
 *     buildExciseTaxLines in lib/production/exportInvoicePreview.ts), and the
 *     same is true of Packaging Materials. Asking an operator for "how many
 *     excise" is meaningless. Those lines are DERIVED: recomputed from what was
 *     credited elsewhere, never typed in.
 *
 *  2. EXCISE SCALES WITH VOLUME, NOT WITH MONEY OR UNITS. It is charged per bbl
 *     (or per gallon). Crediting half the dollar value of an invoice does not
 *     halve the excise; crediting half the BEER does. So derived excise keys off
 *     a volume fraction, and the planner refuses to compute it when the caller
 *     has not supplied per-line volumes — see G5.
 *
 *  3. A PRICE CORRECTION MUST NOT MOVE THE EXCISE AT ALL. The volume did not
 *     change, so the tax owed to TTB/NC DOR did not change. Only goods_returned
 *     and never_delivered reverse it.
 */

/** Why a refund was issued. Drives which consequences fire. */
export type RefundReason =
  | "price_correction"
  | "goods_returned"
  | "never_delivered"
  | "deposit_reduction";

/** How a line's credit is computed. Mirrors refund_lines.basis. */
export type RefundLineBasis = "per_unit" | "derived" | "flat";

/**
 * Categories whose lines are computed from what else was credited, never chosen.
 * `pass_through_taxes` is excise; `materials_packaging` is the components-used
 * charge; `discount` is an invoice-level discount carried as its own negative
 * line, which has to shrink in step with the lines it was discounting or the
 * credit refunds more than the customer ever paid.
 */
const DERIVED_CATEGORIES = new Set(["pass_through_taxes", "materials_packaging", "discount"]);

// A line that carries volume is whatever `volumeBbl` was resolved onto, NOT a
// fixed category list. A contract-brewing invoice has no product lines at all —
// invoice 000042 is Packaging Fee, two excise lines, forklift and materials, and
// the per-case line that the excise scales off is the PACKAGING FEE. Keying
// volume off distribution_keg/distribution_can would have refused that refund.

/** The subset of an invoice_line_items row the planner needs. */
export interface RefundableLine {
  id: string;
  category: string | null;
  /** Units billed on the original invoice. 1 on derived and flat lines. */
  quantity: number;
  unitPriceCents: number;
  /** What the customer actually paid for this line, discounts applied. */
  totalCents: number;
  /**
   * Beer volume this line represents, in bbl. Required on beer lines whenever
   * a derived excise line is present — see G5. Null everywhere else.
   */
  volumeBbl?: number | null;
}

/** An operator's choice for one line. Derived lines are never selected. */
export interface RefundSelection {
  lineId: string;
  /** Units to credit on a per_unit line. Ignored on flat lines. */
  quantity?: number;
}

export interface RefundPlanInput {
  lines: RefundableLine[];
  selections: RefundSelection[];
  reason: RefundReason;
  /** Total the customer paid on this invoice, in cents. */
  paidCents: number;
  /** Sum of every prior refund against this invoice, in cents. */
  alreadyRefundedCents: number;
}

export interface PlannedRefundLine {
  lineId: string;
  basis: RefundLineBasis;
  /** Units credited. Null on derived and flat lines — see refund_lines.quantity. */
  quantity: number | null;
  amountCents: number;
}

export type RefundPlan =
  | { ok: false; error: string }
  | {
      ok: true;
      reason: RefundReason;
      lines: PlannedRefundLine[];
      totalCents: number;
      /** True when credited beer goes back into cold storage. */
      recreditsInventory: boolean;
      /** True when the TTB/NC DOR excise record must reverse too. */
      reversesExcise: boolean;
      /**
       * Share of the invoice's billed units this credit represents, 0–1. The
       * consequence writer scales the return shipment by it — 8 of 30 cases is
       * a 0.2667 return against every export transaction on the invoice.
       */
      unitFraction: number;
    };

function reject(error: string): RefundPlan {
  return { ok: false, error };
}

/**
 * The basis a line is credited on. Derived is decided by category, because a
 * derived line is indistinguishable from a flat one by quantity alone — excise
 * and a forklift fee both arrive as quantity 1.
 */
export function lineBasis(line: RefundableLine): RefundLineBasis {
  if (line.category && DERIVED_CATEGORIES.has(line.category)) return "derived";
  return line.quantity > 1 ? "per_unit" : "flat";
}

/**
 * Which consequences a reason fires. Exported so the modal can warn before the
 * operator commits, using the same table the server acts on.
 *
 * A price correction touches money only: the goods were delivered, they stay
 * delivered, and the volume that drove the excise never changed.
 */
export function consequencesFor(reason: RefundReason): {
  recreditsInventory: boolean;
  reversesExcise: boolean;
} {
  const reverses = reason === "goods_returned" || reason === "never_delivered";
  return { recreditsInventory: reverses, reversesExcise: reverses };
}

/**
 * Plan a refund. Returns either a rejection with a message fit to show an
 * operator, or the exact set of credit lines and the total to send to Square.
 */
export function planRefund(input: RefundPlanInput): RefundPlan {
  const { lines, selections, reason, paidCents, alreadyRefundedCents } = input;

  // A deposit reduction has no invoice lines to pick from — it is proportional
  // math against the deposit actually paid, and it comes in through a different
  // entry point. Reaching here with one means a caller wired it wrong.
  if (reason === "deposit_reduction") {
    return reject("Deposit reductions are planned from the allocation, not from invoice lines.");
  }

  if (selections.length === 0) {
    return reject("Select at least one line to credit.");
  }

  const byId = new Map(lines.map((l) => [l.id, l]));
  const chosen: PlannedRefundLine[] = [];

  for (const sel of selections) {
    const line = byId.get(sel.lineId);
    if (!line) return reject("A selected line is not on this invoice.");

    const basis = lineBasis(line);

    // G2 — a derived line may not be credited on its own. "Refund the excise,
    // keep the beer" leaves the excise ledger and the invoice disagreeing with
    // no volume change to explain the gap. The only way to credit excise is to
    // credit the beer that generated it.
    if (basis === "derived") {
      return reject(
        "Excise, packaging materials and discounts can't be credited directly — they recalculate from the beer lines you credit.",
      );
    }

    if (basis === "flat") {
      chosen.push({ lineId: line.id, basis, quantity: null, amountCents: line.totalCents });
      continue;
    }

    const qty = sel.quantity ?? 0;
    if (!Number.isFinite(qty) || qty <= 0) {
      return reject("Credited quantity must be greater than zero.");
    }
    if (qty > line.quantity) {
      return reject(`Can't credit ${qty} of a line that was only billed ${line.quantity}.`);
    }

    // G3 — priced off what was actually PAID (totalCents, discounts applied),
    // never a fresh price lookup and never the list unit price. Same discipline
    // as the allocation adjust route's warning against re-running
    // calculateIngredientDeposit() at today's ingredient costs.
    const amountCents = Math.round(line.totalCents * (qty / line.quantity));
    chosen.push({ lineId: line.id, basis, quantity: qty, amountCents });
  }

  // Duplicate selections would double-credit a line and violate the
  // (refund_id, invoice_line_item_id) unique index at write time. Catch it here
  // with a message an operator can act on rather than a constraint error.
  if (new Set(chosen.map((c) => c.lineId)).size !== chosen.length) {
    return reject("The same line was selected twice.");
  }

  const derivedLines = lines.filter((l) => lineBasis(l) === "derived");
  const derived = planDerivedLines(lines, chosen, derivedLines, reason);
  if ("error" in derived) return reject(derived.error);

  const all = [...chosen, ...derived.lines];
  const totalCents = all.reduce((sum, l) => sum + l.amountCents, 0);

  // G1 — never refund more than is left to refund. Checked on the total, after
  // derived lines are folded in, because those can only ever add to it.
  const refundable = paidCents - alreadyRefundedCents;
  if (totalCents > refundable) {
    return reject(
      `This credit comes to ${totalCents} cents but only ${refundable} cents remain refundable on this invoice.`,
    );
  }
  if (totalCents <= 0) {
    return reject("This credit comes to nothing.");
  }

  return {
    ok: true,
    reason,
    lines: all,
    totalCents,
    unitFraction: creditedUnitFraction(lines, chosen),
    ...consequencesFor(reason),
  };
}

/**
 * Share of the invoice's billed units this credit covers.
 *
 * Only per_unit lines count. A flat line — the $5 forklift fee — is one "unit"
 * of nothing; letting it into the denominator would have made 8 of 30 cases
 * read as 8/31 and quietly under-credited the materials charge on prod invoice
 * 000042.
 */
function creditedUnitFraction(lines: RefundableLine[], chosen: PlannedRefundLine[]): number {
  const totalUnits = lines
    .filter((l) => lineBasis(l) === "per_unit")
    .reduce((s, l) => s + l.quantity, 0);
  if (totalUnits <= 0) return 0;
  const creditedUnits = chosen
    .filter((c) => c.basis === "per_unit")
    .reduce((s, c) => s + (c.quantity ?? 0), 0);
  return creditedUnits / totalUnits;
}

/**
 * Recompute the derived lines from what was credited.
 *
 * Two different fractions, deliberately:
 *   * excise scales by VOLUME — it is charged per bbl, so half the dollars is
 *     not half the tax;
 *   * materials and the invoice discount scale by UNITS, because both were
 *     computed per packaged unit in the first place.
 */
function planDerivedLines(
  lines: RefundableLine[],
  chosen: PlannedRefundLine[],
  derivedLines: RefundableLine[],
  reason: RefundReason,
): { lines: PlannedRefundLine[] } | { error: string } {
  if (derivedLines.length === 0) return { lines: [] };

  const creditedQtyById = new Map(chosen.map((c) => [c.lineId, c.quantity ?? 0]));

  const volumeLines = lines.filter((l) => l.volumeBbl != null);

  const unitFraction = creditedUnitFraction(lines, chosen);

  const out: PlannedRefundLine[] = [];

  for (const line of derivedLines) {
    const isExcise = line.category === "pass_through_taxes";

    if (isExcise) {
      // A price correction leaves the volume — and therefore the tax owed —
      // untouched. Crediting it here would refund the customer a tax the
      // brewery still owes the state.
      if (!consequencesFor(reason).reversesExcise) continue;

      // G5 — excise can only be credited against a known volume change. Without
      // per-line volumes there is no honest fraction to apply, so refuse rather
      // than fall back to a units or dollars proxy that would quietly misstate
      // an excise filing.
      const totalVolume = volumeLines.reduce((s, l) => s + (l.volumeBbl ?? 0), 0);
      if (volumeLines.length === 0 || totalVolume <= 0) {
        return {
          error:
            "Can't credit excise without the shipped volume behind the invoice's lines — reversing it off a unit count would misstate the excise filing.",
        };
      }

      const creditedVolume = volumeLines.reduce((s, l) => {
        const qty = creditedQtyById.get(l.id) ?? 0;
        return s + (l.volumeBbl ?? 0) * (l.quantity > 0 ? qty / l.quantity : 0);
      }, 0);
      if (creditedVolume <= 0) continue;

      out.push({
        lineId: line.id,
        basis: "derived",
        quantity: null,
        amountCents: Math.round(line.totalCents * (creditedVolume / totalVolume)),
      });
      continue;
    }

    if (unitFraction <= 0) continue;
    out.push({
      lineId: line.id,
      basis: "derived",
      quantity: null,
      amountCents: Math.round(line.totalCents * unitFraction),
    });
  }

  return { lines: out.filter((l) => l.amountCents !== 0) };
}
