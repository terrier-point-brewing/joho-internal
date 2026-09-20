"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { useUserRole } from "@/lib/hooks/useUserRole";
import PageHeader from "@/app/components/PageHeader";
import TabBar from "@/app/components/TabBar";
import Banner from "@/app/components/ui/Banner";
import Badge from "@/app/components/ui/Badge";
import Card from "@/app/components/ui/Card";
import type { Tone } from "@/app/components/ui/tone";
import BatchRequestModal from "./BatchRequestModal";
import ClaimModal from "./ClaimModal";
import { bbl, bbl1, dollars, longDate, monthLabel, shortDate, type ClaimableBatch, type Overview, type PaymentStatus, type PortalDeal, type PortalHistory, type PortalInvoice, type PortalRequest, type PortalShipment, PROGRESS_STEPS } from "./types";

type TabKey = "home" | "capacity" | "available" | "requests" | "history";

const TABS: { key: TabKey; label: string }[] = [
  { key: "home", label: "Home" },
  { key: "capacity", label: "Capacity" },
  { key: "available", label: "Available beer" },
  { key: "requests", label: "My requests" },
  { key: "history", label: "History" },
];

const PAYMENT: Record<PaymentStatus, { label: string; tone: Tone }> = {
  paid: { label: "Paid", tone: "success" },
  unpaid: { label: "Invoice unpaid", tone: "danger" },
  not_invoiced: { label: "Not yet invoiced", tone: "neutral" },
};

const STAGE_LABEL: Record<ClaimableBatch["stage"], string> = {
  in_tank: "In tank — not packaged yet",
  packaging: "Packaging under way",
  packaged: "Packaged — ready now",
};

const STATUS: Record<PortalRequest["status"], { label: string; tone: Tone }> = {
  submitted: { label: "Awaiting our reply", tone: "info" },
  approved: { label: "Approved", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

export default function PartnerPortal() {
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const { isPartner } = useUserRole();
  // Staff preview: /partner?as=<company id>. Ignored by the API for real partners.
  const as = params.get("as");
  const qs = as ? `?as=${encodeURIComponent(as)}` : "";

  const [tab, setTab] = useState<TabKey>("home");
  const [batchForm, setBatchForm] = useState<{ month: string | null } | null>(null);
  const [claiming, setClaiming] = useState<ClaimableBatch | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const needsCompany = !isPartner && !as;
  const overview = useQuery({
    queryKey: ["partner", "overview", as],
    queryFn: () => fetchJson<Overview>(`/api/partner/overview${qs}`),
    enabled: !needsCompany,
  });
  const requests = useQuery({
    queryKey: ["partner", "requests", as],
    queryFn: () => fetchJson<PortalRequest[]>(`/api/partner/requests${qs}`),
    enabled: !needsCompany,
  });
  const history = useQuery({
    queryKey: ["partner", "history", as],
    queryFn: () => fetchJson<PortalHistory>(`/api/partner/history${qs}`),
    // Home leads with money and open deals, so this loads with the page.
    enabled: !needsCompany,
  });

  function submitted(message: string) {
    setBatchForm(null);
    setClaiming(null);
    setNotice(message);
    setTab("requests");
    qc.invalidateQueries({ queryKey: ["partner"] });
  }

  async function withdraw(id: string) {
    if (!confirm("Withdraw this request?")) return;
    const res = await fetch(`/api/partner/requests/${id}`, { method: "DELETE" });
    if (!res.ok) setNotice((await res.json().catch(() => ({}))).error ?? "Could not withdraw the request.");
    qc.invalidateQueries({ queryKey: ["partner", "requests"] });
  }

  if (needsCompany) return <PreviewPicker onPick={(id) => router.replace(`/partner?as=${id}`)} />;

  const data = overview.data;
  const readOnly = data?.preview ?? false;

  return (
    <div className={`px-4 sm:px-6 pb-8 ${isPartner ? "md:pt-11" : ""}`}>
      <PageHeader
        title={data?.company_name ?? "Partner portal"}
        description="See what we can brew for you, claim beer that's coming available, and track your requests."
      />
      {readOnly && (
        <Banner tone="info" className="mb-3">
          Preview — this is what {data?.company_name} sees. You can open the forms, but a preview cannot submit them.{" "}
          <a href="/production/partners" className="underline">Back to Partners</a>
        </Banner>
      )}
      <TabBar tabs={TABS} activeKey={tab} onSelect={(k) => { setTab(k); setNotice(null); }} />

      {overview.error && <Banner className="mb-4">{(overview.error as Error).message}</Banner>}
      {notice && <Banner tone="success" className="mb-4">{notice}</Banner>}
      {overview.isLoading && <p className="text-sm text-muted">Loading…</p>}

      {data && tab === "home" && (
        <HomeTab
          overview={data}
          history={history.data}
          requests={requests.data ?? []}
          go={setTab}
          onRequestBatch={(month) => setBatchForm({ month })}
        />
      )}

      {data && tab === "capacity" && (
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <p className="text-sm text-secondary">
              Room to start a new brew, month by month. One slot is one free fermenter, good for one brew of up to {data.max_turns} turns.
            </p>
            <button className="btn-primary" onClick={() => setBatchForm({ month: null })}>
              Request a batch
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
            {data.capacity.map((m) => (
              <Card key={m.month}>
                <div className="text-sm font-semibold text-primary">{monthLabel(m.month)}</div>
                {m.open_slots > 0 ? (
                  <>
                    <div className="text-2xl font-semibold text-success mt-2">{m.open_slots}</div>
                    <div className="text-xs text-muted">open brew slot{m.open_slots === 1 ? "" : "s"}</div>
                    <div className="text-xs text-secondary mt-3">
                      Earliest start {shortDate(m.earliest_start)} · up to {m.max_turns} turns ({m.max_turns * data.turn_bbl} bbl)
                    </div>
                    <button className="btn-secondary btn-xxs mt-3" onClick={() => setBatchForm({ month: m.month })}>
                      Request this month
                    </button>
                  </>
                ) : (
                  <>
                    <div className="text-2xl font-semibold text-faint mt-2">Full</div>
                    <div className="text-xs text-muted">no open brew slots</div>
                  </>
                )}
              </Card>
            ))}
          </div>
          <p className="text-xs text-muted mt-4">
            One turn is a {data.turn_bbl} bbl brew, before the shrinkage expected in fermentation and packaging. The earliest
            start is always at least two weeks out, so we have time to approve the brew and order ingredients. Slots are an
            estimate from our brewing schedule; we confirm the date when we approve your request.
          </p>
        </section>
      )}

      {data && tab === "available" && (
        <section>
          <p className="text-sm text-secondary mb-4">
            Beer we are already brewing that has not been spoken for. Claim some and we will confirm.
          </p>
          {data.available.length === 0 ? (
            <Card><p className="text-sm text-muted">Nothing is available to claim right now. Check back as new batches are scheduled.</p></Card>
          ) : (
            <div className="flex flex-col gap-2">
              {data.available.map((b) => (
                <Card key={b.batch_id}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-primary">{b.beer_name}</div>
                      <div className="text-xs text-muted">
                        {[b.style, b.abv ? `${b.abv}% ABV` : null].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <div className="text-sm font-semibold text-strong">{bbl(b.claimable_bbl)} available</div>
                        <div className="text-xs text-muted">{STAGE_LABEL[b.stage]}{b.stage !== "packaged" && b.ready_by ? ` · ready around ${shortDate(b.ready_by)}` : ""}</div>
                      </div>
                      <button className="btn-primary" onClick={() => setClaiming(b)}>Claim some</button>
                    </div>
                  </div>
                  <ReadinessBar batch={b} />
                </Card>
              ))}
            </div>
          )}
          <p className="text-xs text-muted mt-4">
            <span className="text-success">Packaged</span> beer is here and ready to ship. Beer <span className="text-info">still in tank</span> is
            our estimate of what it will package out at — the final amount is confirmed once it is packaged. Availability is first
            approved, first served.
          </p>
        </section>
      )}

      {tab === "requests" && (
        <section>
          <p className="text-sm text-secondary mb-4">
            Everything you have asked for, with the ones still waiting on us first. Once a request is approved it becomes a
            commitment, and its shipments and invoices are tracked under History.
          </p>
          {requests.isLoading && <p className="text-sm text-muted">Loading…</p>}
          {requests.data && requests.data.length === 0 && (
            <Card><p className="text-sm text-muted">No requests yet. Start from Capacity or Available beer.</p></Card>
          )}
          <div className="flex flex-col gap-2">
            {[...(requests.data ?? [])].sort((a, b) => Number(b.status === "submitted") - Number(a.status === "submitted")).map((r) => (
              <Card key={r.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-primary">
                      {r.beer_name}{r.is_new_beer ? " (new beer)" : ""}
                    </div>
                    <div className="text-xs text-muted mt-0.5">
                      {r.kind === "batch"
                        ? `New batch · ${r.turns} turn${r.turns === 1 ? "" : "s"} (${bbl(r.volume_bbl)}) · ${r.desired_date ? `brew week of ${shortDate(r.desired_date)}` : "flexible timing"}`
                        : `Claim · ${bbl(r.volume_bbl)}`}
                      {" · sent "}{longDate(r.created_at)}{r.submitted_by ? ` by ${r.submitted_by}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                    {r.status === "submitted" && !readOnly && (
                      <button className="btn-secondary btn-xxs" onClick={() => withdraw(r.id)}>Withdraw</button>
                    )}
                  </div>
                </div>
                {r.status === "approved" && (
                  <p className="text-xs text-success mt-2">
                    Approved{r.decided_at ? ` ${longDate(r.decided_at)}` : ""} — now a commitment.{" "}
                    <button className="underline" onClick={() => setTab("history")}>Track it in History</button>
                  </p>
                )}
                {r.status === "withdrawn" && r.withdrawn_by && <p className="text-xs text-muted mt-2">Withdrawn by {r.withdrawn_by}{r.decided_at ? ` on ${longDate(r.decided_at)}` : ""}</p>}
                {r.decision_note && <p className="text-xs text-body mt-2">From us: {r.decision_note}</p>}
                {r.notes && <p className="text-xs text-muted mt-1">Your note: {r.notes}</p>}
                {r.file_names.length > 0 && <p className="text-xs text-muted mt-1">Attached: {r.file_names.join(", ")}</p>}
              </Card>
            ))}
          </div>
        </section>
      )}

      {tab === "history" && (
        <section>
          {history.isLoading && <p className="text-sm text-muted">Loading…</p>}
          {history.error && <Banner className="mb-4">{(history.error as Error).message}</Banner>}
          {history.data && (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-4">
                <Stat label="Total shipped" value={bbl(history.data.summary.shipped_bbl)} />
                <Stat label="Invoices paid" value={dollars(history.data.summary.paid_cents)} tone="success" />
                <Stat
                  label="Outstanding"
                  value={dollars(history.data.summary.outstanding_cents)}
                  tone={history.data.summary.outstanding_cents > 0 ? "danger" : undefined}
                  note={history.data.open_invoices.length > 0 ? `${history.data.open_invoices.length} unpaid invoice${history.data.open_invoices.length === 1 ? "" : "s"}` : "Nothing owed"}
                />
                <ExciseStat excise={history.data.excise} />
              </div>
              <p className="text-xs text-muted -mt-2 mb-4">
                Excise tax is the state and federal beer tax we pay on your beer and pass through on your shipment invoices. It is
                already included in the paid and outstanding figures, not added on top.
              </p>
              {history.data.open_invoices.length > 0 && (
                <Card className="mb-4">
                  <div className="text-sm font-semibold text-primary">Unpaid invoices</div>
                  <OpenInvoices invoices={history.data.open_invoices} />
                </Card>
              )}
              {history.data.deals.length === 0 && <Card><p className="text-sm text-muted">No commitments on record yet.</p></Card>}
              <div className="flex flex-col gap-2">
                {history.data.deals.map((d) => <DealCard key={d.id} deal={d} />)}
                {history.data.other_shipments.length > 0 && (
                  <Card>
                    <div className="text-sm font-semibold text-primary">Other shipments</div>
                    <div className="text-xs text-muted mt-0.5">Beer shipped outside a commitment.</div>
                    <ShipmentList shipments={history.data.other_shipments} />
                  </Card>
                )}
              </div>
            </>
          )}
        </section>
      )}

      {batchForm && data && (
        <BatchRequestModal
          overview={data}
          month={batchForm.month}
          previewAs={as}
          onClose={() => setBatchForm(null)}
          onSubmitted={() => submitted("Request sent. We will review it and reply here.")}
        />
      )}
      {claiming && (
        <ClaimModal
          batch={claiming}
          onClose={() => setClaiming(null)}
          onSubmitted={() => submitted("Claim sent. The beer is yours once we approve it.")}
        />
      )}
    </div>
  );
}

/**
 * What an offer is made of: beer on the floor, and beer still to come. The same
 * two-tone reading as the staff ledger's delivery bar, without the batch's size.
 */
function ReadinessBar({ batch: b }: { batch: ClaimableBatch }) {
  const total = Math.max(b.claimable_bbl, 0.0001);
  return (
    <div className="mt-3">
      <div className="h-1.5 rounded-full bg-surface-mid overflow-hidden flex" aria-hidden>
        {b.ready_now_bbl > 0.005 && <div className="h-full bg-success-emphasis" style={{ width: `${(b.ready_now_bbl / total) * 100}%` }} />}
        {b.in_tank_bbl > 0.005 && <div className="h-full bg-info-emphasis" style={{ width: `${(b.in_tank_bbl / total) * 100}%` }} />}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs mt-1.5">
        <span className={b.ready_now_bbl > 0.005 ? "text-success" : "text-faint"}>{bbl(b.ready_now_bbl)} packaged and ready now</span>
        <span className={b.in_tank_bbl > 0.005 ? "text-info" : "text-faint"}>{bbl(b.in_tank_bbl)} still in tank (estimate)</span>
      </div>
    </div>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "success" | "danger" }) {
  return (
    <Card>
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-xl font-semibold mt-1 ${tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-primary"}`}>{value}</div>
      {note && <div className="text-xs text-muted mt-1">{note}</div>}
    </Card>
  );
}

function ExciseStat({ excise }: { excise: PortalHistory["excise"] }) {
  return (
    <Stat
      label="Excise tax charged"
      value={dollars(excise.charged_cents)}
      note={excise.charged_cents === 0 ? "None billed yet"
        : excise.outstanding_cents > 0 ? `${dollars(excise.collected_cents)} collected · ${dollars(excise.outstanding_cents)} on unpaid invoices`
        : `${dollars(excise.collected_cents)} collected — all paid`}
    />
  );
}

function ShipmentList({ shipments }: { shipments: PortalShipment[] }) {
  return (
    <ul className="mt-2 border-t border-line pt-2 flex flex-col gap-2">
      {shipments.map((s, i) => (
        <li key={i} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
          <span className="text-body w-24">{longDate(s.date)}</span>
          <span className="text-muted flex-1 min-w-[10rem]">{s.lines.map((l) => `${l.quantity} × ${l.label ?? "package"}`).join(", ")}</span>
          <span className="text-secondary">{bbl(s.volume_bbl)}</span>
          <span className="flex items-center gap-2">
            {s.kind === "return" ? <Badge tone="neutral">Returned</Badge> : (
              <>
                {s.invoice && (s.invoice.pay_url
                  ? <a href={s.invoice.pay_url} target="_blank" rel="noreferrer" className="text-muted underline">Invoice {s.invoice.number ?? ""} · {dollars(s.invoice.total_cents)}</a>
                  : <span className="text-muted">Invoice {s.invoice.number ?? ""} · {dollars(s.invoice.total_cents)}</span>)}
                <Badge tone={s.invoice?.overdue ? "danger" : PAYMENT[s.payment].tone}>{s.invoice?.overdue ? `Overdue ${s.invoice.days_overdue}d` : PAYMENT[s.payment].label}</Badge>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Six dots: where this deal's beer is between "scheduled" and "ready". */
function ProgressSteps({ deal }: { deal: PortalDeal }) {
  const p = deal.progress;
  return (
    <div className="mt-3">
      <div className="flex items-center gap-1" aria-hidden>
        {PROGRESS_STEPS.map((name, i) => (
          <div key={name} className={`h-1 flex-1 rounded-full ${i <= p.step ? (p.step === 5 ? "bg-success-emphasis" : "bg-info-emphasis") : "bg-surface-mid"}`} title={name} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 text-xs mt-1">
        <span className={p.step === 5 ? "text-success" : p.step < 0 ? "text-muted" : "text-info"}>{p.label}</span>
        {p.step <= 0 && p.brew_date && <span className="text-muted">brew date {longDate(p.brew_date)}</span>}
        {p.ready_by && <span className="text-muted">ready around {longDate(p.ready_by)}</span>}
      </div>
    </div>
  );
}

function DealCard({ deal }: { deal: PortalDeal }) {
  const [open, setOpen] = useState(deal.status === "open");
  const isOpen = deal.status === "open";
  const scale = Math.max(deal.expected_bbl, deal.shipped_bbl, 0.0001);
  const w = (v: number) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;
  const inTank = isOpen ? deal.in_tank_bbl : 0;
  const waiting = Math.max(0, Math.min(deal.produced_bbl, deal.expected_bbl) - deal.shipped_bbl);
  const unpaid = deal.shipments.filter((s) => s.payment === "unpaid").length;
  // The booking is whole turns before shrinkage; what the batch really gave is
  // smaller. Only worth a sentence when the two differ.
  const shrunk = deal.has_batch && deal.booked_bbl - deal.expected_bbl > 0.05;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-primary">
            {deal.beer_name ?? "Beer"}{deal.style ? <span className="font-normal text-muted"> · {deal.style}</span> : null}
          </div>
          <div className="text-xs text-muted mt-0.5">
            {deal.received_on ? `Committed ${longDate(deal.received_on)}` : "Commitment"}
            {deal.desired_delivery_date ? ` · wanted by ${longDate(deal.desired_delivery_date)}` : ""}
            {` · booked ${bbl(deal.booked_bbl)}`}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {unpaid > 0 && <Badge tone="danger">{unpaid} unpaid invoice{unpaid === 1 ? "" : "s"}</Badge>}
          <Badge tone={isOpen ? "info" : deal.status === "closed" ? "success" : "neutral"}>
            {isOpen ? "Open" : deal.status === "closed" ? "Complete" : "Cancelled"}
          </Badge>
        </div>
      </div>

      {isOpen && <ProgressSteps deal={deal} />}

      <div className="mt-3 h-1.5 rounded-full bg-surface-mid overflow-hidden flex" aria-hidden>
        <div className="h-full bg-success-emphasis" style={{ width: w(deal.shipped_bbl) }} />
        {waiting > 0.005 && <div className="h-full bg-info-emphasis" style={{ width: w(waiting) }} />}
        {inTank > 0.005 && <div className="h-full bg-[repeating-linear-gradient(45deg,var(--color-line-subtle)_0_3px,transparent_3px_6px)]" style={{ width: w(inTank) }} />}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-secondary mt-2">
        <span>
          {bbl(deal.shipped_bbl)} shipped of {deal.has_batch ? `${inTank > 0.005 ? "about " : ""}${bbl(deal.expected_bbl)}` : `${bbl(deal.booked_bbl)} booked`}
        </span>
        {waiting > 0.005 && <span className="text-info">{bbl(waiting)} packaged, waiting to ship</span>}
        {inTank > 0.005 && <span>{bbl(inTank)} still in tank (estimate)</span>}
        {deal.deposit && (
          <span className="flex items-center gap-2">
            Deposit{deal.deposit.billed_cents > 0 ? ` ${dollars(deal.deposit.paid_cents)} of ${dollars(deal.deposit.billed_cents)}` : ""}
            <Badge tone={PAYMENT[deal.deposit.status].tone}>{PAYMENT[deal.deposit.status].label}</Badge>
          </span>
        )}
      </div>
      {shrunk && (
        <p className="text-xs text-muted mt-1.5">
          You booked {bbl(deal.booked_bbl)} — that is the brew size before shrinkage. {isOpen && inTank > 0.005 ? "We expect it to package out at about" : "The batch packaged out at"}{" "}
          {bbl(deal.expected_bbl)} for you, after the normal losses in fermentation and packaging.
        </p>
      )}
      {deal.shipments.length > 0 && (
        <button className="btn-secondary btn-xxs mt-3" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Show"} {deal.shipments.length} shipment{deal.shipments.length === 1 ? "" : "s"}
        </button>
      )}
      {open && deal.shipments.length > 0 && <ShipmentList shipments={deal.shipments} />}
    </Card>
  );
}

/** Open invoices in one aligned grid: what each is for, when it is due, and a way to pay it. */
function OpenInvoices({ invoices, limit }: { invoices: PortalInvoice[]; limit?: number }) {
  const rows = limit ? invoices.slice(0, limit) : invoices;
  return (
    <>
      <div className="mt-3 border-t border-line pt-2 grid grid-cols-[auto_1fr_auto_auto_auto] gap-x-4 gap-y-1.5 text-xs items-baseline">
        <span className="text-faint">Invoice</span>
        <span className="text-faint">For</span>
        <span className="text-faint">Due</span>
        <span className="text-faint text-right">Amount</span>
        <span />
        {rows.map((i) => (
          <div key={i.id} className="contents">
            <span className="text-body whitespace-nowrap">{i.number ?? "—"}</span>
            <span className="text-secondary min-w-0">
              {i.kind === "deposit" ? "Ingredient deposit" : "Shipment"}
              {i.beers.length > 0 ? ` · ${i.beers.join(", ")}` : ""}
              {i.bbl > 0 ? ` · ${bbl1(i.bbl)}` : ""}
            </span>
            <span className="whitespace-nowrap">
              {i.overdue
                ? <span className="text-danger font-medium">Overdue {i.days_overdue} day{i.days_overdue === 1 ? "" : "s"} · was due {shortDate(i.due_date)}</span>
                : <span className="text-muted">{i.due_date ? longDate(i.due_date) : "—"}</span>}
            </span>
            <span className="text-strong text-right whitespace-nowrap">{dollars(i.total_cents)}</span>
            <span className="text-right whitespace-nowrap">
              {i.pay_url ? <a href={i.pay_url} target="_blank" rel="noreferrer" className="btn-secondary btn-xxs">View / pay</a> : <span className="text-faint">link on its way</span>}
            </span>
          </div>
        ))}
      </div>
      {limit && invoices.length > limit && <p className="text-xs text-muted mt-2">and {invoices.length - limit} more — see History</p>}
    </>
  );
}

/**
 * The first thing a partner sees: what needs their attention, then where they
 * stand. Every tile leads somewhere — it is a front door, not a report.
 */
function HomeTab({ overview, history, requests, go, onRequestBatch }: {
  overview: Overview; history: PortalHistory | undefined; requests: PortalRequest[];
  go: (tab: TabKey) => void; onRequestBatch: (month: string | null) => void;
}) {
  const next = overview.capacity.find((m) => m.open_slots > 0) ?? null;
  const waiting = requests.filter((r) => r.status === "submitted").length;
  const claimable = overview.available.reduce((s, b) => s + b.claimable_bbl, 0);
  const readyNow = overview.available.reduce((s, b) => s + b.ready_now_bbl, 0);
  const owed = history?.summary.outstanding_cents ?? 0;
  return (
    <section className="flex flex-col gap-4">
      {history && owed > 0 && (
        <Card className="border-danger-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted">Open invoices</div>
              <div className="text-xl font-semibold text-danger mt-1">{dollars(owed)} outstanding</div>
              {history.summary.overdue_cents > 0 && <div className="text-xs text-danger mt-0.5">{dollars(history.summary.overdue_cents)} of it is overdue</div>}
            </div>
            <button className="btn-secondary" onClick={() => go("history")}>See history</button>
          </div>
          <OpenInvoices invoices={history.open_invoices} limit={5} />
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <div className="text-xs text-muted">Next open brew slot</div>
          {next ? (
            <>
              <div className="text-xl font-semibold text-success mt-1">{longDate(next.earliest_start)}</div>
              <div className="text-xs text-secondary mt-1">
                {next.open_slots} slot{next.open_slots === 1 ? "" : "s"} open in {monthLabel(next.month)} · up to {next.max_turns} turns ({next.max_turns * overview.turn_bbl} bbl)
              </div>
            </>
          ) : (
            <div className="text-xl font-semibold text-faint mt-1">Nothing open in the next six months</div>
          )}
          <div className="flex gap-2 mt-3">
            <button className="btn-primary" onClick={() => onRequestBatch(next?.month ?? null)}>Request a batch</button>
            <button className="btn-secondary" onClick={() => go("capacity")}>All months</button>
          </div>
        </Card>
        <Card>
          <div className="text-xs text-muted">Beer you could claim now</div>
          <div className="text-xl font-semibold text-primary mt-1">
            {overview.available.length === 0 ? "None right now" : `${bbl1(claimable)} across ${overview.available.length} beer${overview.available.length === 1 ? "" : "s"}`}
          </div>
          {overview.available.length > 0 && (
            <div className="text-xs mt-1">
              <span className="text-success">{bbl1(readyNow)} packaged and ready now</span>
              <span className="text-faint"> · </span>
              <span className="text-info">{bbl1(claimable - readyNow)} still in tank</span>
            </div>
          )}
          <div className="text-xs text-secondary mt-1">
            {overview.available.slice(0, 3).map((b) => b.beer_name.trim()).join(", ") || "Check back as new batches are scheduled."}
          </div>
          <button className="btn-secondary mt-3" onClick={() => go("available")}>See available beer</button>
        </Card>
      </div>

      {history && history.deals.some((d) => d.status === "open") && (
        <Card>
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-muted">Your beer in progress</div>
            <button className="btn-secondary btn-xxs" onClick={() => go("history")}>Details in History</button>
          </div>
          <div className="mt-2 grid grid-cols-[1fr_auto_auto] sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_auto_auto] gap-x-4 gap-y-2 text-xs items-center">
            {history.deals.filter((d) => d.status === "open").map((d) => (
              <div key={d.id} className="contents">
                <span className="text-body min-w-0 truncate">{d.beer_name ?? "Beer"}</span>
                <span className="hidden sm:flex items-center gap-1" aria-hidden>
                  {PROGRESS_STEPS.map((name, i) => (
                    <span key={name} title={name} className={`h-1 flex-1 rounded-full ${i <= d.progress.step ? (d.progress.step === 5 ? "bg-success-emphasis" : "bg-info-emphasis") : "bg-surface-mid"}`} />
                  ))}
                </span>
                <span className={`whitespace-nowrap ${d.progress.step === 5 ? "text-success" : d.progress.step < 0 ? "text-muted" : "text-info"}`}>
                  {d.progress.label}{d.progress.ready_by ? ` · ~${shortDate(d.progress.ready_by)}` : ""}
                </span>
                <span className="text-secondary text-right whitespace-nowrap">{bbl1(d.shipped_bbl)} of {d.has_batch ? bbl1(d.expected_bbl) : `${bbl1(d.booked_bbl)} booked`}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Stat label="Requests awaiting our reply" value={String(waiting)} note={waiting > 0 ? "We will reply in My requests" : "Nothing pending"} />
        <Stat label="Open commitments" value={String(history?.summary.open_deals ?? "…")} note={history ? `${bbl1(history.summary.to_come_bbl)} still to come` : undefined} />
        <Stat label="Total shipped" value={history ? bbl1(history.summary.shipped_bbl) : "…"} />
        <Stat label="Invoices paid" value={history ? dollars(history.summary.paid_cents) : "…"} tone="success" note={history && owed === 0 ? "Nothing outstanding" : undefined} />
        {history && history.excise.charged_cents > 0 && <ExciseStat excise={history.excise} />}
      </div>
    </section>
  );
}

/** Staff opening /partner with no company chosen: pick whose portal to preview. */
function PreviewPicker({ onPick }: { onPick: (id: string) => void }) {
  const { data: partners = [] } = useQuery({
    queryKey: ["partners", "contract-brewing", "options"],
    queryFn: () => fetchJson<Array<{ id: string; company_name: string }>>("/api/partners/contract-brewing"),
  });
  return (
    <div className="px-4 sm:px-6">
      <PageHeader title="Partner portal preview" description="See the portal exactly as a partner company sees it. Read-only." />
      <select className="inp w-full sm:w-96 mt-2" defaultValue="" onChange={(e) => e.target.value && onPick(e.target.value)} aria-label="Partner company">
        <option value="">Choose a company…</option>
        {partners.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
      </select>
    </div>
  );
}
