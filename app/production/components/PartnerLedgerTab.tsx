"use client";

/**
 * Partner Ledger — every partner's commitments end to end.
 *
 * One row per commitment: booked → batch and % → deposit → shipped → invoiced
 * → remaining. Expand a row for the allocation's share arithmetic, every
 * drop, and every invoice. Over-delivery and ad-hoc drops sit under the
 * partner as their own lines, never folded into a commitment.
 *
 * Read-only. Actions stay on the screens that own them (Batch Log for
 * allocations, Commitments for deposit invoices, Export Bay for shipping,
 * Export Invoices for billing).
 */

import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "../hooks/queries";
import SearchInput from "@/app/components/ui/SearchInput";
import { applyControls } from "@/lib/table/applyControls";
import type { ControlsConfig } from "@/lib/table/types";
import type { LedgerAllocation, LedgerCommitment, LedgerInvoiceRef, LedgerPartner, LedgerShipment } from "@/lib/production/partnerLedger";
import type { CommitmentStage } from "@/lib/production/commitmentStage";
import { fmtUsd } from "@/lib/utils/formatting";
import { fmtDate } from "@/lib/utils/formatting";
import FilterBar from "@/app/components/ui/FilterBar";
import ToggleChip from "@/app/components/ui/ToggleChip";
import FilterSelect from "@/app/components/ui/FilterSelect";
import Banner from "@/app/components/ui/Banner";
import { CHANNEL_COLOR } from "../lib/categoryColors";
import { attentionRank, commitmentAttention, type Attention } from "@/lib/production/ledgerAttention";
import { useQueryClient } from "@tanstack/react-query";
import InvoicePreviewModal from "./InvoicePreviewModal";
import type { HomesForBatch } from "@/lib/production/rehome";
import { Modal } from "./shared";

/**
 * Give a stray shipment (over-delivery or old ad-hoc) a home: pick the
 * partner's allocation on that batch and where its extra share comes from.
 * Same rules and endpoint as the Ship modal uses before shipping.
 */
function RehomeModal({ partner, shipment, onClose, onDone }: {
  partner: LedgerPartner; shipment: LedgerShipment; onClose: () => void; onDone: () => void;
}) {
  const targets = shipment.batch_id ? (partner.allocations_by_batch[shipment.batch_id] ?? []) : [];
  const [targetId, setTargetId] = useState<string>(targets[0]?.allocation_id ?? "");
  const [homes, setHomes] = useState<HomesForBatch | null>(null);
  const [source, setSource] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bblNeeded = shipment.volume_bbl;

  React.useEffect(() => {
    if (!shipment.batch_id || !targetId) return;
    let live = true;
    fetchJson<HomesForBatch>(`/api/production/allocations/rehome?batch_id=${shipment.batch_id}&target_allocation_id=${targetId}`)
      .then((h) => { if (live) setHomes(h); })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : "Couldn't load options"); });
    return () => { live = false; };
  }, [shipment.batch_id, targetId]);

  const chosen = homes?.sources.find((h) => (h.kind === "unallocated" ? "unallocated" : h.allocationId) === source) ?? null;
  const ok = !!chosen && chosen.requires !== "refund" && chosen.freeBbl + 0.0001 >= bblNeeded && !!targetId;

  async function save() {
    if (!chosen) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/production/allocations/rehome", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_allocation_id: targetId,
          source: chosen.kind === "unallocated" ? { kind: "unallocated" } : { kind: "allocation", allocation_id: chosen.allocationId },
          bbl: bblNeeded,
          transaction_ids: shipment.transaction_ids,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Couldn't re-home");
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "Error"); } finally { setBusy(false); }
  }

  return (
    <Modal title={`Give ${bbl(bblNeeded)} bbl a home`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-secondary">
          Shipped {fmtDate(shipment.date)} to {partner.company_name} from #{shipment.batch_number ?? "?"} with no commitment behind it.
          Pick the commitment it belongs to; its booking rises by {bbl(bblNeeded)} bbl and the share comes from the source you choose.
        </p>
        {targets.length === 0 ? (
          <p className="text-xs text-danger">{partner.company_name} has no allocation on this batch. Add one in Batch Log (against their commitment) first, then come back.</p>
        ) : (
          <label className="block text-xs text-secondary">Commitment
            <select className="inp w-full mt-1" value={targetId} onChange={(e) => { setTargetId(e.target.value); setHomes(null); setSource(""); }}>
              {targets.map((t) => <option key={t.allocation_id} value={t.allocation_id}>{t.recipe_name ?? "—"} · #{t.batch_number ?? "?"}</option>)}
            </select>
          </label>
        )}
        {homes && (
          <div className="space-y-1">
            <div className="text-xs text-secondary">Share comes from</div>
            {homes.sources.length === 0 && <p className="text-xs text-danger">Nothing on this batch can give up share.</p>}
            {homes.sources.map((h) => {
              const key = h.kind === "unallocated" ? "unallocated" : (h.allocationId ?? "");
              const enough = h.freeBbl + 0.0001 >= bblNeeded;
              const disabled = h.requires === "refund" || !enough;
              const who = h.kind === "unallocated" ? "Unallocated share of the batch"
                : h.kind === "self" ? "This commitment's own unshipped share (nothing moves; the booking rises)"
                : h.partnerName ?? (h.channel === "taproom" ? "Taproom" : h.channel === "safety_stock" ? "Safety stock" : h.channel ?? "");
              return (
                <label key={key} className={`flex items-start gap-2 text-xs ${disabled ? "text-faint" : "text-body cursor-pointer"}`}>
                  <input type="radio" name="rehome-source" className="mt-0.5" disabled={disabled} checked={source === key} onChange={() => setSource(key)} />
                  <span>
                    {who} · {h.freeBbl.toFixed(2)} bbl free
                    {h.requires === "refund" && " — deposit paid; refund part of it in Batch Log first"}
                    {h.requires === "regenerate_deposit" && " — their draft deposit invoice will need regenerating"}
                    {!enough && h.requires !== "refund" && " — not enough"}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {err && <p className="text-xs text-danger">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" disabled={!ok || busy} onClick={save}>{busy ? "Saving…" : "Give it a home"}</button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The one write on this screen: a deposit marked paid with no amount on
 * record (the spring-cohort backfills) can have its amount entered here,
 * because the fact lives nowhere else and the ledger is where its absence
 * shows. Everything else stays on the screens that own it.
 */
function RecordPaidAmount({ allocationId, onDone }: { allocationId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!open) {
    return <button type="button" className="btn-secondary btn-xxs" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>Record amount</button>;
  }
  async function save(e: React.FormEvent) {
    e.preventDefault(); e.stopPropagation();
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/production/allocations/${allocationId}/invoice`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "record_paid_amount", amount_cents: Math.round(Number(amount) * 100), external_ref: ref }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Couldn't record the amount");
      setOpen(false); onDone();
    } catch (x) { setErr(x instanceof Error ? x.message : "Error"); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={save} onClick={(e) => e.stopPropagation()} className="flex flex-wrap items-center gap-1.5 text-xs">
      <input className="inp-sm w-24" type="number" step="0.01" min="0.01" placeholder="$ paid" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      <input className="inp-sm w-40" placeholder="invoice / payment ref" value={ref} onChange={(e) => setRef(e.target.value)} required />
      <button type="submit" className="btn-primary btn-xxs" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      <button type="button" className="btn-secondary btn-xxs" onClick={() => setOpen(false)}>Cancel</button>
      {err && <span className="text-danger">{err}</span>}
    </form>
  );
}

const STAGE_META: Record<CommitmentStage, { label: string; cls: string }> = {
  open:      { label: "Open",      cls: "bg-info-surface/50 text-info border-info-border" },
  closed:    { label: "Closed",    cls: "bg-success-surface/40 text-success border-success-border" },
  cancelled: { label: "Cancelled", cls: "bg-danger-surface/40 text-danger border-danger-border" },
};

const ATTENTION_CLS: Record<Attention["kind"], string> = {
  not_invoiced:      "bg-[var(--cat-amber-bg)] text-[var(--cat-amber-fg)] border-[var(--cat-amber-bd)]",
  deposit_uncharged: "bg-[var(--cat-amber-bg)] text-[var(--cat-amber-fg)] border-[var(--cat-amber-bd)]",
  deposit_unpaid:    "bg-accent-muted/40 text-accent border-accent-border",
  needs_batch:       "bg-info-surface/40 text-info border-info-border",
  over_delivered:    "bg-[var(--cat-amber-bg)] text-[var(--cat-amber-fg)] border-[var(--cat-amber-bd)]",
  amount_unrecorded: "bg-surface-mid text-secondary border-line-strong",
  under_delivered:   "bg-surface-mid text-muted border-line-strong",
};
/** Closing notes (not actionable) read quieter than things to do. */
const NOTE_CLS = "bg-surface-mid text-muted border-line";

function AttentionChips({ flags }: { flags: Attention[] }) {
  if (flags.length === 0) return <span className="text-faint text-xs">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span key={f.kind} className={`text-xs px-1.5 py-0.5 rounded border whitespace-nowrap ${f.actionable ? ATTENTION_CLS[f.kind] : NOTE_CLS}`}>{f.label}</span>
      ))}
    </div>
  );
}

/**
 * Shipped ÷ owed as one glance: number, bar, and what is left. The bar is
 * three segments on one scale — shipped, packaged-but-unshipped, and the
 * deal's share of what is still in tank — so it also says how much more the
 * batch is going to produce for this partner.
 */
function DeliveryCell({ c }: { c: LedgerCommitment }) {
  const t = c.totals;
  if (c.allocations.length === 0) return <span className="text-faint text-xs">no batch yet</span>;
  const owed = t.owed_bbl;
  const inTank = c.stage === "open" ? t.in_tank_bbl : 0;
  const over = owed > 0 && t.shipped_bbl > owed + 0.01;
  const closed = c.stage !== "open";
  // One scale for the bar: everything this deal will end up with — what is
  // owed so far plus what is still in tank, or what shipped if that is more.
  // NOT the booking: owed is capped at what the batch produced, so on an
  // under-yielding batch a fully delivered deal would never fill the bar.
  const scale = Math.max(t.shipped_bbl, owed + inTank, 0.0001);
  const w = (v: number) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;
  const packagedUnshipped = Math.max(0, owed - t.shipped_bbl);
  return (
    <div className="min-w-[150px]">
      <div className="text-xs tabular-nums font-mono">
        <span className={over ? "text-[var(--cat-amber-fg)] font-medium" : "text-body"}>{bbl(t.shipped_bbl)}</span>
        <span className="text-faint"> / </span>
        <span className="text-body">{owed > 0 ? bbl(owed) : `${bbl(c.booked_bbl)} booked`}</span>
        {!closed && owed > 0 && t.remaining_bbl > 0.005 && <span className="text-muted"> · {bbl(t.remaining_bbl)} to go</span>}
        {inTank > 0.005 && <span className="text-muted"> · {bbl(inTank)} in tank</span>}
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-surface-mid overflow-hidden flex" title={`${bbl(t.shipped_bbl)} shipped · ${bbl(packagedUnshipped)} packaged, not shipped · ${bbl(inTank)} still in tank`}>
        <div className={`h-full ${over ? "bg-[var(--cat-amber-fg)]" : "bg-success-emphasis"}`} style={{ width: w(Math.min(t.shipped_bbl, over ? t.shipped_bbl : owed)) }} />
        {!over && packagedUnshipped > 0.005 && <div className="h-full bg-info-emphasis" style={{ width: w(packagedUnshipped) }} />}
        {inTank > 0.005 && (
          <div className="h-full bg-[repeating-linear-gradient(45deg,var(--color-line-subtle)_0_3px,transparent_3px_6px)]" style={{ width: w(inTank) }} />
        )}
      </div>
      <div className="text-xs text-muted mt-0.5 whitespace-nowrap">
        {c.allocations.map((a) => `#${a.batch_number ?? "?"} ${a.percentage.toFixed(0)}%`).join(", ")}
      </div>
    </div>
  );
}

const INVOICE_BADGE: Record<string, string> = {
  draft: "bg-surface-mid text-secondary",
  open: "bg-accent-muted/40 text-accent",
  unpaid: "bg-accent-muted/40 text-accent",
  paid: "bg-success-surface/40 text-success",
  voided: "bg-danger-surface/40 text-danger",
  partial: "bg-info-surface/40 text-info",
};
const INVOICE_LABEL: Record<string, string> = {
  draft: "Draft", open: "Sent", unpaid: "Sent", paid: "Paid", voided: "Voided", partial: "Partial",
};

const CHANNEL_LABEL: Record<string, string> = {
  contract_brewing: "Contract Brewing", distribution: "Distribution", wholesale: "Wholesale",
};

function StageBadge({ stage }: { stage: CommitmentStage }) {
  const m = STAGE_META[stage];
  return <span className={`text-xs px-1.5 py-0.5 rounded border font-medium whitespace-nowrap ${m.cls}`}>{m.label}</span>;
}

function ChannelBadge({ channel }: { channel: string }) {
  const c = CHANNEL_COLOR[channel] ?? CHANNEL_COLOR.safety_stock;
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border font-medium whitespace-nowrap ${c.bg} ${c.text} ${c.border}`}>
      {CHANNEL_LABEL[channel] ?? channel}
    </span>
  );
}

function InvoiceChip({ inv, onOpen }: { inv: LedgerInvoiceRef; onOpen?: (id: string) => void }) {
  const cls = INVOICE_BADGE[inv.status] ?? "bg-surface-mid text-muted";
  const label = `#${inv.invoice_number ?? "—"} · ${fmtUsd(inv.total_cents / 100)} · ${INVOICE_LABEL[inv.status] ?? inv.status}`;
  return onOpen ? (
    <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(inv.id); }}
      className={`text-xs px-1.5 py-0.5 rounded font-mono ${cls} hover:underline`} title="Open in Export Invoices">
      {label}
    </button>
  ) : (
    <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${cls}`}>{label}</span>
  );
}

function bbl(n: number): string { return n.toFixed(2); }

// ── Deposit cell ─────────────────────────────────────────────────────────────

function DepositCell({ c }: { c: LedgerCommitment }) {
  if (c.channel !== "contract_brewing") return <span className="text-faint text-xs">no deposit</span>;
  if (c.allocations.length === 0) return <span className="text-faint text-xs">—</span>;
  const t = c.totals;
  const allSettled = c.allocations.every((a) => a.deposit.state === "settled" || a.deposit.state === "written_off");
  const anyPaid = c.allocations.some((a) => !!a.deposit.paid_at);
  const anyUncharged = c.allocations.some((a) => a.deposit.state === "uncharged");
  const collecting = c.allocations.some((a) => a.deposit.state === "collecting");
  const hasMoney = t.deposit_paid_cents > 0 || t.deposit_billed_cents > 0 || t.deposit_refunded_cents > 0;
  const label = allSettled
    ? (t.deposit_paid_cents > 0 ? "paid" : anyPaid ? "paid · amount not recorded" : "written off, never paid")
    : anyUncharged ? "not yet charged" : collecting ? "collecting per shipment" : "invoiced, awaiting payment";
  return (
    <div className="text-xs leading-4">
      {hasMoney && (
        <div className="tabular-nums">
          <span className={allSettled ? "text-success" : anyUncharged ? "text-[var(--cat-amber-fg)] font-medium" : "text-body"}>
            {fmtUsd(t.deposit_paid_cents / 100)}
          </span>
          {t.deposit_billed_cents > t.deposit_paid_cents && (
            <span className="text-muted"> of {fmtUsd(t.deposit_billed_cents / 100)}</span>
          )}
          {t.deposit_refunded_cents > 0 && (
            <span className="text-danger"> · {fmtUsd(t.deposit_refunded_cents / 100)} refunded</span>
          )}
        </div>
      )}
      <div className={allSettled && t.deposit_paid_cents === 0 && anyPaid ? "text-[var(--cat-amber-fg)]" : anyUncharged ? "text-[var(--cat-amber-fg)]" : "text-muted"}>{label}</div>
    </div>
  );
}

// ── Expanded panel ───────────────────────────────────────────────────────────

function ShareExplainer({ a, booked, channel }: { a: LedgerAllocation; booked: number; channel: string }) {
  const contract = channel === "contract_brewing";
  const share = (a.percentage / 100) * a.produced_bbl;
  return (
    <div className="text-xs text-muted leading-5">
      <div>
        <span className="text-secondary font-medium">{a.percentage.toFixed(2)}%</span> of #{a.batch_number ?? "?"}
        {a.batch_planned_bbl > 0 && (
          <> — {bbl(booked)} bbl booked ÷ {bbl(a.batch_planned_bbl)} bbl planned</>
        )}
        {a.batch_converted_pct > 0.05 && (
          <span className="text-muted"> · {a.batch_converted_pct.toFixed(1)}% converted to {a.batch_converted_to.join(", ") || "another beer"}</span>
        )}
        {a.batch_unallocated_pct > 0.05 && (
          <span className="text-[var(--cat-amber-fg)]"> · {a.batch_unallocated_pct.toFixed(1)}% of this batch is unallocated</span>
        )}
      </div>
      <div>
        Produced {bbl(a.produced_bbl)} bbl → share {bbl(share)}
        {contract && booked > 0 && share > booked + 0.005 && <> → capped at booked {bbl(booked)}</>}
        {" "}= <span className="text-secondary font-medium">owed {bbl(a.owed_bbl)} bbl</span>
        {" "}· shipped {bbl(a.exported_bbl)} · remaining {bbl(a.remaining_bbl)}
        {a.written_off_bbl != null && (
          <span className="text-muted"> · written off {bbl(a.written_off_bbl)}{a.write_off_note ? ` (“${a.write_off_note}”)` : ""}</span>
        )}
      </div>
    </div>
  );
}

function ShipmentRows({ shipments, onOpenInvoice, onRehome }: { shipments: LedgerShipment[]; onOpenInvoice: (id: string) => void; onRehome?: (s: LedgerShipment) => void }) {
  if (shipments.length === 0) return <p className="text-xs text-faint">Nothing shipped yet.</p>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-muted">
          <th className="pb-1 font-medium">Date</th>
          <th className="pb-1 font-medium">Batch</th>
          <th className="pb-1 font-medium">What</th>
          <th className="pb-1 pr-3 font-medium text-right">BBL</th>
          <th className="pb-1 font-medium">Invoice</th>
        </tr>
      </thead>
      <tbody>
        {shipments.map((s, i) => (
          <tr key={s.shipment_id ?? i} className="border-t border-line/60 align-top">
            <td className="py-1 pr-3 whitespace-nowrap text-secondary">
              {fmtDate(s.date)}
              {s.kind !== "shipment" && <span className="ml-1 text-muted">({s.kind})</span>}
            </td>
            <td className="py-1 pr-3 text-secondary whitespace-nowrap">{s.batch_number ? `#${s.batch_number}` : "—"}</td>
            <td className="py-1 pr-3 text-body">
              {s.lines.map((l, j) => (
                <div key={j}>
                  {l.quantity} × {l.variant_label ?? "—"}
                  {l.over_allocation && <span className="ml-1 text-[var(--cat-amber-fg)]">over-delivery</span>}
                  {l.is_ad_hoc && <span className="ml-1 text-[var(--cat-amber-fg)]">ad-hoc</span>}
                  {l.shipped_before_deposit && <span className="ml-1 text-[var(--cat-amber-fg)]" title="The deposit was unpaid when this left; it back-charges on the export invoice">before deposit</span>}
                </div>
              ))}
            </td>
            <td className="py-1 pr-3 text-right font-mono tabular-nums text-body">{bbl(s.volume_bbl)}</td>
            <td className="py-1">
              <div className="flex flex-wrap items-center gap-1.5">
                {s.invoice
                  ? <InvoiceChip inv={s.invoice} onOpen={onOpenInvoice} />
                  : <span className="text-[var(--cat-amber-fg)]">not invoiced</span>}
                {onRehome && s.volume_bbl > 0.0001 && (
                  <button type="button" className="btn-primary btn-xxs" onClick={(e) => { e.stopPropagation(); onRehome(s); }}>Give it a home</button>
                )}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CommitmentPanel({ c, onOpenInvoice, onChanged }: { c: LedgerCommitment; onOpenInvoice: (id: string) => void; onChanged: () => void }) {
  return (
    <div className="px-6 py-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-secondary mb-1.5">Allocation</div>
          {c.allocations.length === 0
            ? <p className="text-xs text-faint">Not allocated to a batch yet.</p>
            : c.allocations.map((a) => (
              <div key={a.id} className="mb-2 last:mb-0">
                <ShareExplainer a={a} booked={c.booked_bbl} channel={c.channel} />
                {c.channel === "contract_brewing" && (
                  <div className="text-xs mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="text-muted">Deposit:</span>
                    {a.deposit.invoice && <InvoiceChip inv={a.deposit.invoice} />}
                    {a.deposit.backcharge_invoices.map((inv) => <InvoiceChip key={inv.id} inv={inv} onOpen={onOpenInvoice} />)}
                    {!a.deposit.invoice && a.deposit.backcharge_invoices.length === 0 && a.deposit.state !== "settled" && !a.deposit.paid_at && (
                      <span className={a.deposit.state === "written_off" ? "text-muted" : "text-[var(--cat-amber-fg)]"}>
                        {a.deposit.state === "written_off" ? "written off before any deposit was paid" : "not charged — will be back-charged on the export invoice"}
                      </span>
                    )}
                    {a.deposit.paid_cents > 0 && <span className="text-muted">· {fmtUsd(a.deposit.paid_cents / 100)} paid</span>}
                    {a.deposit.paid_at && a.deposit.paid_cents === 0 && a.deposit.collected_cents === 0 && (
                      <>
                        <span className="text-[var(--cat-amber-fg)]">
                          · paid {fmtDate(a.deposit.paid_at)}, amount not recorded
                          {a.deposit.state === "written_off" && " (remaining volume later written off)"}
                        </span>
                        <RecordPaidAmount allocationId={a.id} onDone={onChanged} />
                      </>
                    )}
                    {a.deposit.collected_cents > 0 && <span className="text-muted">· {fmtUsd(a.deposit.collected_cents / 100)} collected on export invoices</span>}
                    {a.deposit.refunded_cents > 0 && <span className="text-danger">· {fmtUsd(a.deposit.refunded_cents / 100)} refunded</span>}
                  </div>
                )}
              </div>
            ))}
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-secondary mb-1.5">Export invoices</div>
          {c.export_invoices.length === 0
            ? <p className="text-xs text-faint">None yet{c.totals.uninvoiced_bbl > 0 ? ` — ${bbl(c.totals.uninvoiced_bbl)} bbl shipped and not invoiced.` : "."}</p>
            : (
              <div className="flex flex-wrap gap-1.5">
                {c.export_invoices.map((inv) => <InvoiceChip key={inv.id} inv={inv} onOpen={onOpenInvoice} />)}
                {c.totals.uninvoiced_bbl > 0 && (
                  <span className="text-xs text-[var(--cat-amber-fg)] self-center">{bbl(c.totals.uninvoiced_bbl)} bbl still not invoiced</span>
                )}
              </div>
            )}
        </div>
        {c.notes && <p className="text-xs text-muted">{c.notes}</p>}
      </div>
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-secondary mb-1.5">Shipments</div>
        <ShipmentRows shipments={c.shipments} onOpenInvoice={onOpenInvoice} />
      </div>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

type View = "attention" | "open" | "all";

const COLUMNS = 8; // expand, beer, stage, attention, delivery, deposit, invoiced, due

const LEDGER_RECIPE_SEARCH: ControlsConfig<LedgerCommitment> = {
  search: [{ param: "q", accessor: (c) => c.recipe_name ?? "" }],
};

export default function PartnerLedgerTab({ onNavigateToInvoice, focusCommitmentId }: {
  onNavigateToInvoice: (invoiceId: string) => void;
  /** Arriving from Intake → Commitments: show this deal, expanded. */
  focusCommitmentId?: string;
}) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.production.partnerLedger() });
  const { data: ledger = [], isPending, error } = useQuery({
    queryKey: queryKeys.production.partnerLedger(),
    queryFn: () => fetchJson<LedgerPartner[]>("/api/production/partner-ledger"),
  });

  // A linked deal may need no attention, so the link opens on "Everything".
  const [view, setView] = useState<View>(focusCommitmentId ? "all" : "attention");
  const [partnerFilter, setPartnerFilter] = useState<string[]>([]);
  const [recipeQ, setRecipeQ] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(focusCommitmentId ?? null);
  // Billing starts from the row that shows what is unbilled: the same preview
  // modal the Shipments tab uses, fed the deal's uninvoiced shipment ids.
  const scrolledToFocus = React.useRef(false);
  const [invoiceFor, setInvoiceFor] = useState<string[] | null>(null);
  const [rehome, setRehome] = useState<{ partner: LedgerPartner; shipment: LedgerShipment } | null>(null);

  // One flat list, then grouped by partner for the header rows — so every
  // partner shares one table and one set of column widths.
  const groups = useMemo(() => {
    type Row = { c: LedgerCommitment; flags: Attention[]; rank: number };
    const out: Array<{ partner: LedgerPartner; rows: Row[]; rank: number }> = [];
    for (const p of ledger) {
      if (partnerFilter.length > 0 && !partnerFilter.includes(p.partner_id)) continue;
      const rows = applyControls(p.commitments, LEDGER_RECIPE_SEARCH, { search: { q: recipeQ }, filters: {}, sort: null })
        .map((c) => ({ c, flags: commitmentAttention(c), rank: attentionRank(c) }))
        .filter((r) => view === "all" ? true : view === "open" ? r.c.stage === "open" : r.rank < 99)
        .sort((x, y) => x.rank - y.rank || (x.c.desired_delivery_date ?? "9999").localeCompare(y.c.desired_delivery_date ?? "9999"));
      // Unallocated volume belongs to no recipe, so a recipe search leaves it out.
      const showUnallocated = view !== "open" && p.unallocated_bbl > 0.0001 && !recipeQ.trim();
      if (rows.length === 0 && !showUnallocated) continue;
      const rank = Math.min(...rows.map((r) => r.rank), p.unallocated_bbl > 0.0001 ? 1 : 99);
      out.push({ partner: p, rows, rank });
    }
    return out.sort((a, b) => a.rank - b.rank || a.partner.company_name.localeCompare(b.partner.company_name));
  }, [ledger, partnerFilter, recipeQ, view]);

  const summary = useMemo(() => {
    const all = ledger.flatMap((p) => p.commitments);
    const attention = all.filter((c) => attentionRank(c) < 99).length
      + ledger.filter((p) => p.unallocated_bbl > 0.0001).length;
    const uninvoiced = all.reduce((s, c) => s + c.totals.uninvoiced_bbl, 0)
      + ledger.reduce((s, p) => s + p.unallocated.filter((u) => !u.invoice).reduce((x, u) => x + u.volume_bbl, 0), 0);
    return {
      attention,
      remainingBbl: all.filter((c) => c.stage === "open").reduce((s, c) => s + c.totals.remaining_bbl, 0),
      uninvoicedBbl: uninvoiced,
      outstandingCents: all.reduce((s, c) =>
        s + Math.max(0, c.totals.deposit_billed_cents - c.totals.deposit_paid_cents)
          + Math.max(0, c.totals.export_billed_cents - c.totals.export_paid_cents), 0),
    };
  }, [ledger]);

  const filterActiveCount = (partnerFilter.length ? 1 : 0) + (view !== "attention" ? 1 : 0) + (recipeQ.trim() ? 1 : 0);

  return (
    <div className="space-y-4">
      {rehome && (
        <RehomeModal partner={rehome.partner} shipment={rehome.shipment} onClose={() => setRehome(null)} onDone={() => { setRehome(null); refresh(); }} />
      )}
      {invoiceFor && (
        <InvoicePreviewModal
          transactionIds={invoiceFor}
          onClose={() => setInvoiceFor(null)}
          onCreated={() => { setInvoiceFor(null); refresh(); }}
        />
      )}
      <FilterBar activeCount={filterActiveCount} onClear={() => { setPartnerFilter([]); setRecipeQ(""); setView("attention"); }}>
        <SearchInput value={recipeQ} onChange={setRecipeQ} placeholder="Search recipes…" />
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted mr-0.5">Show:</span>
          {([
            ["attention", summary.attention > 0 ? `Needs attention (${summary.attention})` : "Needs attention"],
            ["open", "Open deals"],
            ["all", "Everything"],
          ] as Array<[View, string]>).map(([v, label]) => (
            <ToggleChip key={v} active={view === v} onClick={() => setView(v)}>{label}</ToggleChip>
          ))}
        </div>
        <FilterSelect label="Partner" options={ledger.map((p) => ({ value: p.partner_id, label: p.company_name }))}
          value={partnerFilter} onChange={setPartnerFilter} allLabel="All Partners" />

      </FilterBar>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 bg-surface/60 border border-line rounded text-xs">
        <span className="text-secondary"><span className={`font-medium tabular-nums ${summary.uninvoicedBbl > 0.005 ? "text-[var(--cat-amber-fg)]" : "text-strong"}`}>{bbl(summary.uninvoicedBbl)}</span> bbl shipped, not invoiced</span>
        <span className="text-muted">|</span>
        <span className="text-secondary"><span className="text-accent-soft font-medium tabular-nums">{fmtUsd(summary.outstandingCents / 100)}</span> invoiced, unpaid</span>
        <span className="text-muted">|</span>
        <span className="text-secondary"><span className="text-strong font-medium tabular-nums">{bbl(summary.remainingBbl)}</span> bbl still to deliver</span>
      </div>

      {error ? (
        <Banner>Could not load the ledger: {error instanceof Error ? error.message : "unknown error"}</Banner>
      ) : groups.length === 0 ? (
        <p className="text-sm text-faint">
          {isPending ? "Loading the ledger…" : view === "attention" ? "Nothing needs attention." : "No commitments match the current filters."}
        </p>
      ) : (
        <div className="rounded-lg border border-line overflow-x-auto">
          <table className="w-full text-sm">
            <colgroup>
              <col className="w-8" />
              <col className="w-[18%]" />
              <col className="w-[10%]" />
              <col className="w-[20%]" />
              <col className="w-[16%]" />
              <col className="w-[13%]" />
              <col className="w-[13%]" />
              <col className="w-[8%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-line bg-surface/50 text-left">
                <th className="px-3 py-2" aria-label="Expand" />
                <th className="px-3 py-2 text-xs font-medium text-muted">Beer</th>
                <th className="px-3 py-2 text-xs font-medium text-muted">Stage</th>
                <th className="px-3 py-2 text-xs font-medium text-muted">Needs</th>
                <th className="px-3 py-2 text-xs font-medium text-muted">Shipped / owed</th>
                <th className="px-3 py-2 text-xs font-medium text-muted">Deposit</th>
                <th className="px-3 py-2 text-xs font-medium text-muted">Invoiced</th>
                <th className="px-3 py-2 text-xs font-medium text-muted">Due</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(({ partner: p, rows }) => (
                <React.Fragment key={p.partner_id}>
                  <tr className="bg-surface/40 border-b border-line">
                    <td colSpan={COLUMNS} className="px-3 py-2">
                      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                        <h3 className="text-sm font-semibold text-strong">{p.company_name}</h3>
                        <span className="text-xs text-muted tabular-nums">
                          {bbl(p.totals.shipped_bbl)} / {bbl(p.totals.owed_bbl)} bbl shipped
                          {p.totals.remaining_bbl > 0.005 && <> · {bbl(p.totals.remaining_bbl)} to go</>}
                          {p.unallocated_bbl > 0.005 && <> · <span className="text-[var(--cat-amber-fg)]">{bbl(p.unallocated_bbl)} shipped without a commitment</span></>}
                        </span>
                      </div>
                    </td>
                  </tr>
                  {rows.map(({ c, flags }) => {
                    const open = expandedId === c.id;
                    return (
                      <React.Fragment key={c.id}>
                        <tr
                          ref={c.id === focusCommitmentId ? (el) => { if (el && !scrolledToFocus.current) { scrolledToFocus.current = true; el.scrollIntoView({ block: "center" }); } } : undefined}
                          className="border-b border-line/60 hover:bg-surface/30 cursor-pointer transition-colors align-top" onClick={() => setExpandedId(open ? null : c.id)}>
                          <td className="px-3 py-2.5 text-muted text-xs">{open ? "▾" : "▸"}</td>
                          <td className="px-3 py-2.5">
                            <div className="text-primary font-medium">{c.recipe_name ?? "—"}{c.is_split && <span className="ml-1.5 text-xs text-muted font-normal">split</span>}</div>
                            <div className="mt-0.5"><ChannelBadge channel={c.channel} /></div>
                          </td>
                          <td className="px-3 py-2.5"><StageBadge stage={c.stage} /></td>
                          <td className="px-3 py-2.5"><AttentionChips flags={flags} /></td>
                          <td className="px-3 py-2.5"><DeliveryCell c={c} /></td>
                          <td className="px-3 py-2.5"><DepositCell c={c} /></td>
                          <td className="px-3 py-2.5 text-xs leading-4">
                            {c.export_invoices.length === 0 && c.totals.uninvoiced_bbl <= 0.005
                              ? <span className="text-faint">—</span>
                              : (
                                <>
                                  <div className="tabular-nums">
                                    <span className={c.totals.export_paid_cents >= c.totals.export_billed_cents ? "text-success" : "text-body"}>{fmtUsd(c.totals.export_paid_cents / 100)}</span>
                                    {c.totals.export_billed_cents > c.totals.export_paid_cents && <span className="text-muted"> of {fmtUsd(c.totals.export_billed_cents / 100)}</span>}
                                  </div>
                                  {(c.totals.uninvoiced_transaction_ids?.length ?? 0) > 0
                                    ? (
                                      <button type="button" className="btn-primary btn-xxs mt-0.5"
                                        onClick={(e) => { e.stopPropagation(); setInvoiceFor(c.totals.uninvoiced_transaction_ids ?? []); }}>
                                        Generate invoice
                                      </button>
                                    )
                                    : <div className="text-muted">{c.export_invoices.length} invoice{c.export_invoices.length !== 1 ? "s" : ""}</div>}
                                </>
                              )}
                          </td>
                          <td className="px-3 py-2.5 text-xs text-muted whitespace-nowrap">{c.desired_delivery_date ? fmtDate(c.desired_delivery_date) : "—"}</td>
                        </tr>
                        {open && (
                          <tr className="border-b border-line bg-surface/20">
                            <td colSpan={COLUMNS} className="p-0"><CommitmentPanel c={c} onOpenInvoice={onNavigateToInvoice} onChanged={refresh} /></td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                  {view !== "open" && p.unallocated_bbl > 0.0001 && (
                    <tr className="border-b border-line bg-surface/20">
                      <td colSpan={COLUMNS} className="px-4 py-3">
                        <div className="flex items-center gap-3 mb-1.5">
                          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--cat-amber-fg)]">
                            Shipped without a commitment <span className="font-normal normal-case tracking-normal text-muted">— {bbl(p.unallocated_bbl)} bbl that needs a home</span>
                          </div>
                          {p.unallocated_uninvoiced_transaction_ids.length > 0 && (
                            <button type="button" className="btn-primary btn-xxs" onClick={() => setInvoiceFor(p.unallocated_uninvoiced_transaction_ids)}>
                              Generate invoice
                            </button>
                          )}
                        </div>
                        <ShipmentRows
                          shipments={p.unallocated}
                          onOpenInvoice={onNavigateToInvoice}
                          onRehome={(shipment) => setRehome({ partner: p, shipment })}
                        />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
