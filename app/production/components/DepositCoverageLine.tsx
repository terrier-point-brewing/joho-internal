"use client";

/**
 * One line that answers "who has paid for this conversion child's
 * ingredients?" — the base component (paid on the parent batch's deposit,
 * unless refunded) and the additions component (own invoice or back-charge).
 * Rendered on contract allocations of conversion children wherever deposit
 * state is shown; the same classifiers drive the billing exclusions, so this
 * line and the invoice can never disagree.
 */

import type { BatchAllocation } from "../types";

type Coverage = NonNullable<BatchAllocation["deposit_coverage"]>;

/** Minimal shape — both BatchAllocation and CommitmentAllocationSummary satisfy it. */
interface CoverageBearer {
  channel?: string;
  deposit_coverage?: Coverage | null;
}

function baseCopy(base: Coverage["base"]): { text: string; cls: string } | null {
  const from = base.parent_batch_number ? ` (${base.parent_batch_number}${base.covered_by_invoice_number ? ` · #${base.covered_by_invoice_number}` : ""})` : "";
  switch (base.status) {
    case "not_conversion":
      return null;
    case "covered":
      return { text: `Base ✓ paid on parent${from}`, cls: "text-emerald-500" };
    case "refunded_chargeable":
      return {
        text: `Base ⚠ parent deposit refunded${base.parent_refund_cents ? ` ($${(base.parent_refund_cents / 100).toFixed(2)})` : ""} — base is chargeable here`,
        cls: "text-[var(--cat-amber-fg)]",
      };
    case "pending_parent":
      return { text: `Base — parent deposit pending${from}`, cls: "text-muted" };
    case "uncovered":
      return { text: "Base ⚠ no parent deposit found — full bill stands", cls: "text-[var(--cat-amber-fg)]" };
  }
}

function additionsCopy(additions: Coverage["additions"]): { text: string; cls: string } {
  const ref = additions.invoice_number ? ` #${additions.invoice_number}` : "";
  const how = additions.via === "backcharge" ? "on export invoice" : "deposit invoice";
  switch (additions.status) {
    case "settled":
      return { text: `Additions ✓ paid ${how}${ref}`, cls: "text-emerald-500" };
    case "pending_invoice":
      return { text: `Additions — invoiced${ref}, unpaid`, cls: "text-muted" };
    case "collecting":
      return {
        text: `Additions — $${((additions.collected_cents ?? 0) / 100).toFixed(2)} collected on export invoices, more due on the next shipment`,
        cls: "text-muted",
      };
    case "written_off":
      return { text: "Additions — written off", cls: "text-muted" };
    case "uncharged":
      return { text: "Additions ⚠ uncharged", cls: "text-[var(--cat-amber-fg)]" };
  }
}

export default function DepositCoverageLine({ allocation }: { allocation: CoverageBearer }) {
  const coverage = allocation.deposit_coverage;
  if (!coverage || (allocation.channel != null && allocation.channel !== "contract_brewing")) return null;
  const base = baseCopy(coverage.base);
  const additions = base ? additionsCopy(coverage.additions) : null;
  // Only conversion children get the decomposed line — a brewed batch's
  // deposit is one number and the existing badges already tell its story.
  if (!base || !additions) return null;
  return (
    <p className="text-[11px] leading-4">
      <span className={base.cls}>{base.text}</span>
      <span className="text-faint"> · </span>
      <span className={additions.cls}>{additions.text}</span>
    </p>
  );
}
