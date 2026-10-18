"use client";

/**
 * One chip that answers "has this conversion child's ingredient deposit been
 * paid?" — the base component (paid on the parent batch's deposit, unless
 * refunded) and the additions component (own invoice or back-charge) fold
 * into a single status; the per-component detail sits in the tooltip.
 * Rendered on contract allocations of conversion children wherever deposit
 * state is shown; the same classifiers drive the billing exclusions, so this
 * chip and the invoice can never disagree.
 */

import Badge from "@/app/components/ui/Badge";
import type { Tone } from "@/app/components/ui/tone";
import type { BatchAllocation } from "../types";

type Coverage = NonNullable<BatchAllocation["deposit_coverage"]>;

/** Minimal shape — both BatchAllocation and CommitmentAllocationSummary satisfy it. */
interface CoverageBearer {
  channel?: string;
  deposit_coverage?: Coverage | null;
}

function baseDetail(base: Coverage["base"]): string | null {
  const from = base.parent_batch_number ? ` (${base.parent_batch_number}${base.covered_by_invoice_number ? ` · #${base.covered_by_invoice_number}` : ""})` : "";
  switch (base.status) {
    case "not_conversion": return null;
    case "covered": return `Base: paid on parent${from}`;
    case "refunded_chargeable": return `Base: parent deposit refunded${base.parent_refund_cents ? ` ($${(base.parent_refund_cents / 100).toFixed(2)})` : ""} — chargeable here`;
    case "pending_parent": return `Base: parent deposit pending${from}`;
    case "uncovered": return `Base: not carried over from parent${base.parent_batch_number ? ` ${base.parent_batch_number}` : ""} — full bill charged here`;
  }
}

function additionsDetail(additions: Coverage["additions"]): string {
  const ref = additions.invoice_number ? ` #${additions.invoice_number}` : "";
  const how = additions.via === "backcharge" ? "on export invoice" : "on deposit invoice";
  switch (additions.status) {
    case "settled": return `Additions: paid ${how}${ref}`;
    case "pending_invoice": return `Additions: invoiced${ref}, unpaid`;
    case "collecting": return `Additions: $${((additions.collected_cents ?? 0) / 100).toFixed(2)} collected so far on export invoices`;
    case "written_off": return "Additions: written off";
    case "uncharged": return "Additions: not yet charged";
  }
}

function status(c: Coverage): { label: string; tone: Tone } {
  const basePaid = c.base.status === "covered";
  const baseOpen = c.base.status === "refunded_chargeable" || c.base.status === "uncovered" || c.base.status === "pending_parent";
  switch (c.additions.status) {
    case "settled": return basePaid ? { label: "Deposit paid", tone: "success" } : baseOpen ? { label: "Deposit due", tone: "accent" } : { label: "Deposit paid", tone: "success" };
    case "written_off": return basePaid ? { label: "Deposit waived", tone: "neutral" } : { label: "Deposit due", tone: "accent" };
    case "collecting": return { label: "Partly collected", tone: "accent" };
    case "pending_invoice": return { label: "Deposit due", tone: "accent" };
    case "uncharged": return { label: "Deposit due", tone: "danger" };
  }
}

export default function DepositCoverageLine({ allocation }: { allocation: CoverageBearer }) {
  const coverage = allocation.deposit_coverage;
  if (!coverage || (allocation.channel != null && allocation.channel !== "contract_brewing")) return null;
  const base = baseDetail(coverage.base);
  // Only conversion children get the chip — a brewed batch's deposit is one
  // number and the existing badges already tell its story.
  if (!base) return null;
  const s = status(coverage);
  return (
    <Badge tone={s.tone} className="shrink-0" >
      <span title={`${base} · ${additionsDetail(coverage.additions)}`}>{s.label}</span>
    </Badge>
  );
}
