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
import type { LedgerAllocation, LedgerCommitment, LedgerInvoiceRef, LedgerPartner, LedgerShipment } from "@/lib/production/partnerLedger";
import type { CommitmentStage } from "@/lib/production/commitmentStage";
import { fmtUsd } from "@/lib/utils/formatting";
import { fmtDate } from "@/lib/utils/formatting";
import FilterBar from "@/app/components/ui/FilterBar";
import FilterChips from "@/app/components/ui/FilterChips";
import FilterSelect from "@/app/components/ui/FilterSelect";
import Banner from "@/app/components/ui/Banner";
import { CHANNEL_COLOR } from "../lib/categoryColors";
import { useQueryClient } from "@tanstack/react-query";
import InvoicePreviewModal from "./InvoicePreviewModal";

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
  unplanned:   { label: "Needs a batch", cls: "bg-accent-muted/50 text-accent border-accent-border" },
  planned:     { label: "Planned",       cls: "bg-surface-mid text-secondary border-line-strong" },
  brewing:     { label: "Brewing",       cls: "bg-info-surface/50 text-info border-info-border" },
  packaged:    { label: "Packaged",      cls: "bg-info-surface/50 text-info border-info-border" },
  shipping:    { label: "Shipping",      cls: "bg-info-surface/50 text-info border-info-border" },
  delivered:   { label: "Delivered",     cls: "bg-success-surface/30 text-success border-success-border" },
  fulfilled:   { label: "Fulfilled",     cls: "bg-success-surface/50 text-success border-success-border" },
  written_off: { label: "Written off",   cls: "bg-surface-mid text-muted border-line-strong" },
  cancelled:   { label: "Cancelled",     cls: "bg-danger-surface/40 text-danger border-danger-border" },
};
const STAGE_ORDER: CommitmentStage[] = ["unplanned", "planned", "brewing", "packaged", "shipping", "delivered", "fulfilled", "written_off", "cancelled"];
const OPEN_STAGES = new Set<CommitmentStage>(["unplanned", "planned", "brewing", "packaged", "shipping", "delivered"]);

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
  const anyUncharged = c.allocations.some((a) => a.deposit.state === "uncharged");
  const collecting = c.allocations.some((a) => a.deposit.state === "collecting");
  const hasMoney = t.deposit_paid_cents > 0 || t.deposit_billed_cents > 0 || t.deposit_refunded_cents > 0;
  const label = allSettled
    ? (t.deposit_paid_cents > 0 ? "paid" : "paid · amount not recorded")
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
      <div className={allSettled && t.deposit_paid_cents === 0 ? "text-[var(--cat-amber-fg)]" : anyUncharged ? "text-[var(--cat-amber-fg)]" : "text-muted"}>{label}</div>
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

function ShipmentRows({ shipments, onOpenInvoice }: { shipments: LedgerShipment[]; onOpenInvoice: (id: string) => void }) {
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
              {s.invoice
                ? <InvoiceChip inv={s.invoice} onOpen={onOpenInvoice} />
                : <span className="text-[var(--cat-amber-fg)]">not invoiced</span>}
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
                    {!a.deposit.invoice && a.deposit.backcharge_invoices.length === 0 && a.deposit.state !== "settled" && (
                      <span className={a.deposit.state === "written_off" ? "text-muted" : "text-[var(--cat-amber-fg)]"}>
                        {a.deposit.state === "written_off" ? "written off" : "not charged — will be back-charged on the export invoice"}
                      </span>
                    )}
                    {a.deposit.paid_cents > 0 && <span className="text-muted">· {fmtUsd(a.deposit.paid_cents / 100)} paid</span>}
                    {a.deposit.state === "settled" && a.deposit.paid_cents === 0 && a.deposit.collected_cents === 0 && (
                      <>
                        <span className="text-[var(--cat-amber-fg)]">· paid, amount not recorded</span>
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

export default function PartnerLedgerTab({ onNavigateToInvoice }: { onNavigateToInvoice: (invoiceId: string) => void }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.production.partnerLedger() });
  const { data: ledger = [], isPending, error } = useQuery({
    queryKey: queryKeys.production.partnerLedger(),
    queryFn: () => fetchJson<LedgerPartner[]>("/api/production/partner-ledger"),
  });

  const [partnerFilter, setPartnerFilter] = useState<string[]>([]);
  const [stageFilter, setStageFilter] = useState<string[]>(["open"]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Billing starts from the row that shows what is unbilled: the same preview
  // modal the Shipments tab uses, fed the deal's uninvoiced shipment ids.
  const [invoiceFor, setInvoiceFor] = useState<string[] | null>(null);

  const stageKeep = (stage: CommitmentStage) =>
    stageFilter.length === 0 || stageFilter.includes("open") ? (stageFilter.includes("open") ? OPEN_STAGES.has(stage) : true) : stageFilter.includes(stage);

  const visible = useMemo(() => ledger
    .filter((p) => partnerFilter.length === 0 || partnerFilter.includes(p.partner_id))
    .map((p) => ({ ...p, commitments: p.commitments.filter((c) => stageKeep(c.stage)) }))
    .filter((p) => p.commitments.length > 0 || (p.unallocated.length > 0 && stageFilter.includes("open"))),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stageKeep is a pure closure over stageFilter.
  [ledger, partnerFilter, stageFilter]);

  const summary = useMemo(() => {
    const all = visible.flatMap((p) => p.commitments);
    return {
      commitments: all.length,
      remainingBbl: all.filter((c) => OPEN_STAGES.has(c.stage)).reduce((s, c) => s + c.totals.remaining_bbl, 0),
      uninvoicedBbl: all.reduce((s, c) => s + c.totals.uninvoiced_bbl, 0) + visible.reduce((s, p) => s + p.unallocated.filter((u) => !u.invoice).reduce((x, u) => x + u.volume_bbl, 0), 0),
      depositOutstanding: all.reduce((s, c) => s + Math.max(0, c.totals.deposit_billed_cents - c.totals.deposit_paid_cents), 0),
      exportOutstanding: all.reduce((s, c) => s + Math.max(0, c.totals.export_billed_cents - c.totals.export_paid_cents), 0),
    };
  }, [visible]);

  const filterActiveCount = (partnerFilter.length ? 1 : 0) + (stageFilter.length && !(stageFilter.length === 1 && stageFilter[0] === "open") ? 1 : 0);

  return (
    <div className="space-y-4">
      {invoiceFor && (
        <InvoicePreviewModal
          transactionIds={invoiceFor}
          onClose={() => setInvoiceFor(null)}
          onCreated={() => { setInvoiceFor(null); refresh(); }}
        />
      )}
      <FilterBar activeCount={filterActiveCount} onClear={() => { setPartnerFilter([]); setStageFilter(["open"]); }}>
        <FilterSelect label="Partner" options={ledger.map((p) => ({ value: p.partner_id, label: p.company_name }))}
          value={partnerFilter} onChange={setPartnerFilter} allLabel="All Partners" />
        <FilterChips label="Stage"
          options={[{ value: "open", label: "Open" }, ...STAGE_ORDER.map((s) => ({ value: s, label: STAGE_META[s].label }))]}
          value={stageFilter} onChange={(v) => setStageFilter(v)} allLabel="Everything" />
      </FilterBar>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 bg-surface/60 border border-line rounded text-xs">
        <span className="text-secondary">{summary.commitments} commitment{summary.commitments !== 1 ? "s" : ""}</span>
        <span className="text-muted">|</span>
        <span className="text-secondary"><span className="text-strong font-medium tabular-nums">{bbl(summary.remainingBbl)}</span> bbl still to deliver</span>
        <span className="text-muted">|</span>
        <span className="text-secondary"><span className={`font-medium tabular-nums ${summary.uninvoicedBbl > 0.005 ? "text-[var(--cat-amber-fg)]" : "text-strong"}`}>{bbl(summary.uninvoicedBbl)}</span> bbl shipped, not invoiced</span>
        <span className="text-muted">|</span>
        <span className="text-secondary"><span className="text-accent-soft font-medium tabular-nums">{fmtUsd(summary.depositOutstanding / 100)}</span> deposits outstanding</span>
        <span className="text-muted">|</span>
        <span className="text-secondary"><span className="text-accent-soft font-medium tabular-nums">{fmtUsd(summary.exportOutstanding / 100)}</span> export invoices outstanding</span>
      </div>

      {error ? (
        <Banner>Could not load the ledger: {error instanceof Error ? error.message : "unknown error"}</Banner>
      ) : visible.length === 0 ? (
        <p className="text-sm text-faint">{isPending ? "Loading the ledger…" : "No commitments match the current filters."}</p>
      ) : visible.map((p) => (
        <section key={p.partner_id} className="rounded-lg border border-line overflow-hidden">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5 bg-surface/50 border-b border-line">
            <h3 className="text-sm font-semibold text-strong">{p.company_name}</h3>
            <span className="text-xs text-muted tabular-nums">
              {bbl(p.totals.shipped_bbl)} / {bbl(p.totals.owed_bbl)} bbl shipped
              {p.totals.remaining_bbl > 0.005 && <> · <span className="text-secondary">{bbl(p.totals.remaining_bbl)} to go</span></>}
              {p.unallocated_bbl > 0.005 && <> · <span className="text-[var(--cat-amber-fg)]">{bbl(p.unallocated_bbl)} outside any commitment</span></>}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className="px-4 py-2 w-6" aria-label="Expand" />
                  <th className="px-4 py-2 text-xs font-medium text-muted">Beer</th>
                  <th className="px-4 py-2 text-xs font-medium text-muted">Channel</th>
                  <th className="px-4 py-2 text-xs font-medium text-muted">Stage</th>
                  <th className="px-4 py-2 text-xs font-medium text-muted text-right">Booked</th>
                  <th className="px-4 py-2 text-xs font-medium text-muted">Batch</th>
                  <th className="px-4 py-2 text-xs font-medium text-muted text-right">Owed</th>
                  <th className="px-4 py-2 text-xs font-medium text-muted text-right">Shipped</th>
                  <th className="px-4 py-2 text-xs font-medium text-muted text-right">Remaining</th>
                  <th className="px-4 py-2 text-xs font-medium text-muted">Deposit</th>
                  <th className="px-4 py-2 text-xs font-medium text-muted">Invoiced</th>
                  <th className="px-4 py-2 text-xs font-medium text-muted">Due</th>
                </tr>
              </thead>
              <tbody>
                {p.commitments.map((c) => {
                  const open = expandedId === c.id;
                  const over = c.totals.owed_bbl > 0 && c.totals.shipped_bbl > c.totals.owed_bbl + 0.01;
                  return (
                    <React.Fragment key={c.id}>
                      <tr className="border-b border-line/60 hover:bg-surface/30 cursor-pointer transition-colors" onClick={() => setExpandedId(open ? null : c.id)}>
                        <td className="px-4 py-2 text-muted text-xs">{open ? "▾" : "▸"}</td>
                        <td className="px-4 py-2 text-primary font-medium whitespace-nowrap">
                          {c.recipe_name ?? "—"}
                          {c.is_split && <span className="ml-1.5 text-xs text-muted font-normal">split</span>}
                        </td>
                        <td className="px-4 py-2"><ChannelBadge channel={c.channel} /></td>
                        <td className="px-4 py-2"><StageBadge stage={c.stage} /></td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums text-body">{bbl(c.booked_bbl)}</td>
                        <td className="px-4 py-2 text-secondary text-xs whitespace-nowrap">
                          {c.allocations.length === 0 ? <span className="text-faint">—</span>
                            : c.allocations.map((a) => `#${a.batch_number ?? "?"} ${a.percentage.toFixed(1)}%`).join(", ")}
                        </td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums text-body">{c.totals.owed_bbl > 0 ? bbl(c.totals.owed_bbl) : <span className="text-faint">—</span>}</td>
                        <td className={`px-4 py-2 text-right font-mono tabular-nums ${over ? "text-[var(--cat-amber-fg)] font-medium" : "text-body"}`}>{bbl(c.totals.shipped_bbl)}</td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums">
                          {c.stage === "fulfilled" || c.stage === "written_off" || c.stage === "cancelled"
                            ? <span className="text-faint">—</span>
                            : <span className={c.totals.remaining_bbl > 0.005 ? "text-strong" : "text-success"}>{bbl(c.totals.remaining_bbl)}</span>}
                        </td>
                        <td className="px-4 py-2"><DepositCell c={c} /></td>
                        <td className="px-4 py-2 text-xs leading-4">
                          {c.export_invoices.length === 0 && c.totals.uninvoiced_bbl <= 0.005
                            ? <span className="text-faint">—</span>
                            : (
                              <>
                                <div className="tabular-nums">
                                  <span className={c.totals.export_paid_cents >= c.totals.export_billed_cents ? "text-success" : "text-body"}>{fmtUsd(c.totals.export_paid_cents / 100)}</span>
                                  {c.totals.export_billed_cents > c.totals.export_paid_cents && <span className="text-muted"> of {fmtUsd(c.totals.export_billed_cents / 100)}</span>}
                                </div>
                                {c.totals.uninvoiced_bbl > 0.005
                                  ? (
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-[var(--cat-amber-fg)]">{bbl(c.totals.uninvoiced_bbl)} bbl not invoiced</span>
                                      {(c.totals.uninvoiced_transaction_ids?.length ?? 0) > 0 && (
                                        <button type="button" className="btn-primary btn-xxs"
                                          onClick={(e) => { e.stopPropagation(); setInvoiceFor(c.totals.uninvoiced_transaction_ids ?? []); }}>
                                          Generate invoice
                                        </button>
                                      )}
                                    </div>
                                  )
                                  : <div className="text-muted">{c.export_invoices.length} invoice{c.export_invoices.length !== 1 ? "s" : ""}</div>}
                              </>
                            )}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted whitespace-nowrap">{c.desired_delivery_date ? fmtDate(c.desired_delivery_date) : "—"}</td>
                      </tr>
                      {open && (
                        <tr className="border-b border-line bg-surface/20">
                          <td colSpan={12} className="p-0"><CommitmentPanel c={c} onOpenInvoice={onNavigateToInvoice} onChanged={refresh} /></td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {p.unallocated.length > 0 && stageFilter.includes("open") && (
            <div className="px-4 py-3 border-t border-line bg-surface/20">
              <div className="flex items-center gap-3 mb-1.5">
                <div className="text-xs font-semibold uppercase tracking-wide text-secondary">
                  Outside any commitment <span className="font-normal normal-case tracking-normal text-muted">— over-delivery and ad-hoc drops, {bbl(p.unallocated_bbl)} bbl</span>
                </div>
                {p.unallocated_uninvoiced_transaction_ids.length > 0 && (
                  <button type="button" className="btn-primary btn-xxs" onClick={() => setInvoiceFor(p.unallocated_uninvoiced_transaction_ids)}>
                    Generate invoice
                  </button>
                )}
              </div>
              <ShipmentRows shipments={p.unallocated} onOpenInvoice={onNavigateToInvoice} />
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
