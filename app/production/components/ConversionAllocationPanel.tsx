"use client";

/**
 * The reconciliation half of a conversion: who the beer belongs to, decided
 * explicitly on BOTH batches before the liquid moves.
 *
 * Converting X% of a batch means X% of every allocation's beer is leaving.
 * This panel makes the operator define where that entitlement goes — the
 * source rows are editable, the child rows are pre-seeded with the source's
 * mix (the default that keeps every party whole and costs nothing), and the
 * per-party tie line shows before/after. Any edit that touches a deposit
 * invoice surfaces its exact consequence before submit: an unpaid invoice is
 * revised, a paid one whose entitlement leaves the partner triggers a partial
 * refund AT SUBMIT, and a paid one whose commitment follows to the child
 * transfers its coverage with no money moving.
 */

import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "../hooks/queries";
import { fmtUsd } from "@/lib/utils/formatting";
import type { BatchAllocation } from "../types";
import {
  classifySourceEdit,
  invoiceState,
  partnerTie,
  seedChildAllocations,
  validatePlan,
  type ChildAllocationDraft,
  type PlanValidation,
  type SourceAllocationInput,
} from "@/lib/production/conversionAllocationPlan";

export interface ConversionAllocationPlanState {
  sourceAllocations: SourceAllocationInput[];
  /** allocation id → edited percentage (only ids the operator changed). */
  edits: Record<string, number>;
  drafts: ChildAllocationDraft[];
  validation: PlanValidation;
}

function toInput(a: BatchAllocation): SourceAllocationInput {
  return {
    id: a.id,
    channel: a.channel,
    partner_id: a.partner_id,
    partner_name: a.contract_brewing_partners?.company_name ?? null,
    contract_request_id: a.contract_request_id,
    percentage: Number(a.percentage),
    invoice_generated_at: a.invoice_generated_at,
    invoice_sent_at: a.invoice_sent_at,
    invoice_paid_at: a.invoice_paid_at,
    deposit_amount_paid_cents: a.deposit_amount_paid_cents,
    square_payment_id: a.square_payment_id,
    written_off_at: (a as unknown as { written_off_at?: string | null }).written_off_at ?? null,
  };
}

const INVOICE_BADGE: Record<string, { label: string; cls: string }> = {
  none:      { label: "no invoice", cls: "text-faint" },
  generated: { label: "draft invoice", cls: "text-secondary" },
  sent:      { label: "invoice sent", cls: "text-secondary" },
  paid:      { label: "PAID 🔒", cls: "text-[var(--cat-amber-fg)] font-medium" },
};

export default function ConversionAllocationPanel({
  sourceBatchId,
  sourceBeerName,
  sourceVolumeBbl,
  convertVolumeBbl,
  targetLabel,
  onPlanChange,
}: {
  sourceBatchId: string;
  sourceBeerName: string;
  sourceVolumeBbl: number;
  convertVolumeBbl: number;
  /** What the child is called in copy — recipe or batch name. */
  targetLabel: string;
  onPlanChange: (plan: ConversionAllocationPlanState | null) => void;
}) {
  const { data: allocations, isLoading, isError } = useQuery({
    queryKey: queryKeys.production.allocationsByBatch(sourceBatchId),
    queryFn: () => fetchJson<BatchAllocation[]>(`/api/production/allocations?batch_id=${sourceBatchId}`),
  });

  const source = useMemo(() => (allocations ?? []).map(toInput), [allocations]);

  const [editStrings, setEditStrings] = useState<Record<string, string>>({});
  const [draftStrings, setDraftStrings] = useState<Record<number, string>>({});

  const edits = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [id, raw] of Object.entries(editStrings)) {
      const n = parseFloat(raw);
      if (!isNaN(n)) out[id] = n;
    }
    return out;
  }, [editStrings]);

  // Child rows are DERIVED: the source's mix verbatim (the keep-everyone-whole
  // default), with the operator's typed overrides layered on top by index.
  const baseDrafts = useMemo(() => seedChildAllocations(source), [source]);
  const drafts = useMemo(() => {
    return baseDrafts.map((d, i): ChildAllocationDraft => {
      const raw = draftStrings[i];
      const n = raw === undefined ? d.percentage : parseFloat(raw);
      return { ...d, percentage: isNaN(n) ? 0 : n };
    });
  }, [baseDrafts, draftStrings]);

  const validation = useMemo(() => validatePlan(source, edits, drafts), [source, edits, drafts]);
  const tie = useMemo(
    () => partnerTie(source, edits, drafts, sourceVolumeBbl, convertVolumeBbl),
    [source, edits, drafts, sourceVolumeBbl, convertVolumeBbl],
  );

  useEffect(() => {
    if (!allocations) { onPlanChange(null); return; }
    onPlanChange({ sourceAllocations: source, edits, drafts, validation });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allocations, source, edits, drafts, validation]);

  if (isLoading) return <p className="text-xs text-muted">Loading allocations…</p>;
  if (isError) {
    return (
      <p className="text-xs text-[var(--cat-amber-fg)]">
        Allocations could not be loaded (you may not have export access). The conversion proceeds
        without reconciling them — sort the allocations out in the Batch Log afterwards.
      </p>
    );
  }
  if (source.length === 0) {
    return <p className="text-xs text-muted">No allocations on {sourceBeerName} — nothing to reconcile; the converted beer ships ad-hoc until allocated.</p>;
  }

  const rowLabel = (channel: string, partnerName: string | null) => partnerName ?? channel.replace("_", " ");

  return (
    <div className="space-y-3 rounded border border-line-strong bg-surface/40 p-3">
      <p className="text-xs font-medium text-secondary">Allocations &amp; deposits</p>

      <div className="grid grid-cols-2 gap-4">
        {/* ── Source side ── */}
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-wide text-faint">{sourceBeerName} (keeps {Math.max(0, sourceVolumeBbl - convertVolumeBbl).toFixed(2)} BBL)</p>
          {source.map((a) => {
            const state = invoiceState(a);
            const badge = INVOICE_BADGE[state];
            const edited = edits[a.id];
            const consequence = edited != null ? classifySourceEdit(a, edited) : { kind: "unchanged" as const };
            return (
              <div key={a.id} className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-body flex-1 truncate">{rowLabel(a.channel, a.partner_name)}</span>
                  <span className={`text-[10px] ${badge.cls}`}>{badge.label}</span>
                  <input
                    type="number" step="0.01" min="0" max="100"
                    className="inp text-xs w-20 text-right"
                    value={editStrings[a.id] ?? String(a.percentage)}
                    onChange={(e) => setEditStrings((p) => ({ ...p, [a.id]: e.target.value }))}
                  />
                  <span className="text-[10px] text-muted w-3">%</span>
                </div>
                {consequence.kind === "refund" && (
                  <p className="text-[11px] text-[var(--cat-amber-fg)]">
                    ⚠ {fmtUsd(consequence.refundCents / 100)} will be refunded to {a.partner_name ?? "the partner"} at submit.
                  </p>
                )}
                {consequence.kind === "patch_and_revise" && (
                  <p className="text-[11px] text-muted">The unpaid deposit invoice will be revised to the new amount.</p>
                )}
                {(consequence.kind === "blocked_refund" || consequence.kind === "blocked_increase") && (
                  <p className="text-[11px] text-danger">{consequence.reason}</p>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Child side ── */}
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-wide text-faint">{targetLabel} ({convertVolumeBbl.toFixed(2)} BBL) — pre-filled with the same mix</p>
          {drafts.map((d, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-xs text-body flex-1 truncate">{rowLabel(d.channel, d.partner_name)}</span>
              <input
                type="number" step="0.01" min="0" max="100"
                className="inp text-xs w-20 text-right"
                value={draftStrings[i] ?? String(d.percentage)}
                onChange={(e) => setDraftStrings((p) => ({ ...p, [i]: e.target.value }))}
              />
              <span className="text-[10px] text-muted w-3">%</span>
            </div>
          ))}
          <p className="text-[10px] text-faint">Set a row to 0 to keep that party off the new batch — their total below will drop.</p>
        </div>
      </div>

      {/* ── Per-party tie line ── */}
      <div className="border-t border-line pt-2 space-y-1">
        {tie.map((row) => (
          <div key={row.key} className="flex items-center gap-2 text-[11px]">
            <span className={row.dropped ? "text-[var(--cat-amber-fg)]" : "text-emerald-500"}>{row.dropped ? "⚠" : "✓"}</span>
            <span className="text-body flex-1 truncate">{row.label}</span>
            <span className="tabular-nums text-muted">{row.beforeBbl.toFixed(2)} → {row.afterBbl.toFixed(2)} BBL</span>
          </div>
        ))}
        <p className="text-[10px] text-faint">Estimates on booked volume — final entitlements settle on packaged volume.</p>
      </div>

      {/* ── Coverage transfers (no money moves) ── */}
      {validation.coverage.length > 0 && (
        <p className="text-[11px] text-muted">
          {validation.coverage.length === 1 ? "One paid deposit's" : `${validation.coverage.length} paid deposits'`} coverage
          transfers to the new batch (same commitment) — no money moves.
        </p>
      )}

      {/* ── Blockers ── */}
      {validation.blockers.map((b, i) => (
        <p key={i} className="text-[11px] text-danger">{b}</p>
      ))}
    </div>
  );
}
