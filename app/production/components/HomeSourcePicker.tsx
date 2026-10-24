"use client";

/**
 * "Where does this beer's share come from?" — the one source list shared by
 * the Ship modal (over-delivery and new-booking cases) and the Partner
 * Ledger's re-home modal. The operator splits the bbl needed across the
 * sources that can give it up: a bbl box per source, "Use rest" to drop the
 * remainder into one, and a running total that must land on the amount
 * needed. The reason a source is greyed out is printed under it, so a locked
 * share never looks like a broken control.
 *
 * A paid partner's share can be drawn on: the slice refunds them the matching
 * part of their deposit, so the row names the amount for the bbl entered and
 * asks for that refund to be confirmed. The parent builds the request from
 * `planPickerDraws` — the server refuses a paid source without the confirmed
 * cents, and refuses if the amount has moved.
 */

import type { HomeSource } from "@/lib/production/rehome";
import { refundCentsForDraw } from "@/lib/production/rehomeMath";
import { fmtUsd } from "@/lib/utils/formatting";

export function homeSourceKey(h: HomeSource): string {
  return h.kind === "unallocated" ? "unallocated" : (h.allocationId ?? "");
}

/** The operator's split: raw bbl text per source key, and which refunds they have ticked. */
export interface PickerDraws {
  bbl: Record<string, string>;
  refundConfirmed: Record<string, boolean>;
}
export const EMPTY_DRAWS: PickerDraws = { bbl: {}, refundConfirmed: {} };

export interface PickerDrawItem {
  key: string;
  source: HomeSource;
  bbl: number;
  refundCents: number;
  /** Why this row blocks the whole split, when it does. */
  problem: string | null;
}

export interface PickerPlan {
  items: PickerDrawItem[];
  total: number;
  remaining: number;
  /** The amounts add up: every row is within what is free and the total lands on bblNeeded. */
  amountOk: boolean;
  /** amountOk and every refund the split implies has been confirmed. */
  ok: boolean;
  refundCents: number;
  /** What the request body carries as `draws`. */
  payload: Array<{ source: { kind: "unallocated" } | { kind: "allocation"; allocation_id: string }; bbl: number; refund_cents?: number }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** The one row problem the checkbox under the row already shows; the total line does not repeat it. */
const REFUND_UNCONFIRMED = "Confirm the refund to draw on this share.";

function disabledReason(h: HomeSource): string | null {
  if (h.requires === "refund" && !h.deposit?.refundable) {
    return "Deposit paid before refund tracking — refund it in the Square Dashboard, then reduce their share in Batch Log.";
  }
  if (h.freeBbl <= 0.0001) return "Nothing free here.";
  return null;
}

/** Sizes, prices and validates the split. Pure, so parents can gate submit on it. */
export function planPickerDraws(sources: HomeSource[], draws: PickerDraws, bblNeeded: number, basisBbl: number): PickerPlan {
  const items: PickerDrawItem[] = [];
  for (const h of sources) {
    const key = homeSourceKey(h);
    const raw = draws.bbl[key];
    const bbl = raw == null || raw.trim() === "" ? 0 : round2(Number(raw));
    if (!(bbl > 0)) continue;
    let problem: string | null = disabledReason(h);
    if (!problem && !Number.isFinite(bbl)) problem = "Enter a number of bbl.";
    if (!problem && bbl > h.freeBbl + 0.0001) problem = `Only ${h.freeBbl.toFixed(2)} bbl is free here.`;
    const refundCents = problem ? 0 : refundCentsForDraw(h, bbl, basisBbl);
    if (!problem && refundCents > 0 && !draws.refundConfirmed[key]) problem = REFUND_UNCONFIRMED;
    items.push({ key, source: h, bbl, refundCents, problem });
  }
  const total = round2(items.reduce((s, i) => s + i.bbl, 0));
  const remaining = round2(bblNeeded - total);
  const amountOk = items.length > 0 && items.every((i) => !i.problem || i.problem === REFUND_UNCONFIRMED) && Math.abs(remaining) <= 0.01;
  const ok = amountOk && items.every((i) => !i.problem);
  return {
    items, total, remaining, amountOk, ok,
    refundCents: items.reduce((s, i) => s + i.refundCents, 0),
    payload: items.map((i) => ({
      source: i.source.kind === "unallocated" || !i.source.allocationId ? { kind: "unallocated" as const } : { kind: "allocation" as const, allocation_id: i.source.allocationId },
      bbl: i.bbl,
      ...(i.refundCents > 0 ? { refund_cents: i.refundCents } : {}),
    })),
  };
}

function optionLabel(h: HomeSource): string {
  if (h.kind === "unallocated") return "Unassigned beer";
  if (h.kind === "self") return "This deal's own unshipped share";
  if (h.partnerName) return `${h.partnerName}'s share`;
  if (h.channel === "taproom") return "Taproom's share";
  if (h.channel === "safety_stock") return "Safety stock";
  return h.channel ?? "";
}

export default function HomeSourcePicker({ sources, bblNeeded, basisBbl, draws, onChange, batchNumber }: {
  sources: HomeSource[];
  bblNeeded: number;
  /** HomesForBatch.yieldBbl, or plannedBbl before anything is measured: what a share is a percentage of. */
  basisBbl: number;
  draws: PickerDraws;
  onChange: (next: PickerDraws) => void;
  batchNumber?: string | null;
}) {
  if (sources.length === 0) return <p className="text-xs text-danger">Nothing on this batch can give up share.</p>;
  const plan = planPickerDraws(sources, draws, bblNeeded, basisBbl);
  const setBbl = (key: string, text: string) =>
    onChange({ bbl: { ...draws.bbl, [key]: text }, refundConfirmed: { ...draws.refundConfirmed, [key]: false } });
  const setConfirmed = (key: string, yes: boolean) =>
    onChange({ ...draws, refundConfirmed: { ...draws.refundConfirmed, [key]: yes } });

  return (
    <div className="space-y-1.5">
      {sources.map((h) => {
        const key = homeSourceKey(h);
        const reason = disabledReason(h);
        const item = plan.items.find((i) => i.key === key) ?? null;
        const entered = item?.bbl ?? 0;
        // "Use rest": this row takes whatever is still unassigned, capped at what it has free.
        const rest = round2(Math.min(h.freeBbl, entered + Math.max(0, plan.remaining)));
        const canFill = !reason && plan.remaining > 0.0001 && rest > entered + 0.0001;
        return (
          <div key={key} className="space-y-1">
            <div className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs ${reason ? "text-faint" : "text-body"}`}>
              <span className="min-w-0">{optionLabel(h)}</span>
              <span className="text-faint tabular-nums">{h.freeBbl.toFixed(2)} bbl free</span>
              {!reason && (
                <span className="ml-auto flex items-center gap-1.5">
                  <input
                    type="number" inputMode="decimal" min={0} max={h.freeBbl} step="0.01" placeholder="0"
                    aria-label={`bbl from ${optionLabel(h)}`}
                    className="inp-sm w-20 text-right tabular-nums"
                    value={draws.bbl[key] ?? ""}
                    onChange={(e) => setBbl(key, e.target.value)}
                  />
                  <span className="text-faint">bbl</span>
                  {canFill && (
                    <button type="button" className="btn-secondary btn-xxs whitespace-nowrap" onClick={() => setBbl(key, rest.toFixed(2))}>
                      Use rest
                    </button>
                  )}
                </span>
              )}
              {h.requires === "regenerate_deposit" && !reason && entered > 0 && (
                <span className="basis-full text-faint">· draft deposit invoice will be regenerated</span>
              )}
              {item && item.refundCents > 0 && (
                <span className="basis-full text-faint">· refunds {fmtUsd(item.refundCents / 100)} of their deposit</span>
              )}
              {reason && <span className="basis-full text-faint">{reason}</span>}
              {item?.problem && item.problem !== REFUND_UNCONFIRMED && (
                <span className="basis-full text-danger">{item.problem}</span>
              )}
            </div>
            {item && item.refundCents > 0 && (
              <label className="flex items-start gap-2 rounded border border-danger-border bg-danger-surface/30 px-2 py-1.5 text-xs text-body cursor-pointer">
                <input type="checkbox" className="mt-0.5" checked={!!draws.refundConfirmed[key]} onChange={(e) => setConfirmed(key, e.target.checked)} />
                <span>
                  Refund <span className="font-medium">{fmtUsd(item.refundCents / 100)}</span> to {h.partnerName ?? "this partner"} on their
                  {batchNumber ? ` #${batchNumber}` : ""} deposit and release {item.bbl.toFixed(2)} bbl of their share. The refund goes to Square the moment this is saved.
                </span>
              </label>
            )}
          </div>
        );
      })}
      <p className={`text-xs tabular-nums ${plan.amountOk ? "text-secondary" : "text-danger"}`}>
        {plan.amountOk
          ? `${plan.total.toFixed(2)} of ${bblNeeded.toFixed(2)} bbl assigned`
          : plan.remaining > 0.01
            ? `${plan.remaining.toFixed(2)} bbl still unassigned`
            : plan.remaining < -0.01
              ? `${(-plan.remaining).toFixed(2)} bbl over — only ${bblNeeded.toFixed(2)} bbl is needed`
              : `${plan.total.toFixed(2)} of ${bblNeeded.toFixed(2)} bbl assigned`}
      </p>
    </div>
  );
}
