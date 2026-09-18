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
import { bbl, dollars, longDate, monthLabel, shortDate, type ClaimableBatch, type Overview, type PortalDeal, type PortalRequest } from "./types";

type TabKey = "capacity" | "available" | "requests" | "history";

const TABS: { key: TabKey; label: string }[] = [
  { key: "capacity", label: "Capacity" },
  { key: "available", label: "Available beer" },
  { key: "requests", label: "My requests" },
  { key: "history", label: "History" },
];

const STATUS: Record<PortalRequest["status"], { label: string; tone: Tone }> = {
  submitted: { label: "Submitted", tone: "info" },
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

  const [tab, setTab] = useState<TabKey>("capacity");
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
    queryFn: () => fetchJson<PortalDeal[]>(`/api/partner/history${qs}`),
    enabled: !needsCompany && tab === "history",
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
    <div className={`px-4 sm:px-6 pb-8 max-w-4xl ${isPartner ? "md:pt-11" : ""}`}>
      <PageHeader
        title={data?.company_name ?? "Partner portal"}
        description="See what we can brew for you, claim beer that's coming available, and track your requests."
      />
      {readOnly && (
        <Banner tone="info" className="mb-3">
          Preview — this is what {data?.company_name} sees. You can open the forms, but a preview cannot submit them.
        </Banner>
      )}
      <TabBar tabs={TABS} activeKey={tab} onSelect={(k) => { setTab(k); setNotice(null); }} />

      {overview.error && <Banner className="mb-4">{(overview.error as Error).message}</Banner>}
      {notice && <Banner tone="success" className="mb-4">{notice}</Banner>}
      {overview.isLoading && <p className="text-sm text-muted">Loading…</p>}

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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
            One turn is a {data.turn_bbl} bbl brew, before the shrinkage expected in fermentation and packaging. Slots are an
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
                <Card key={b.batch_id} className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-primary">{b.beer_name}</div>
                    <div className="text-xs text-muted">
                      {[b.style, b.abv ? `${b.abv}% ABV` : null].filter(Boolean).join(" · ") || "—"}
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="text-sm font-semibold text-strong">{bbl(b.claimable_bbl)} available</div>
                      <div className="text-xs text-muted">{b.packaged ? "Packaged — ready now" : b.ready_by ? `Ready around ${shortDate(b.ready_by)}` : "Ready soon — date to be confirmed"}</div>
                    </div>
                    <button className="btn-primary" onClick={() => setClaiming(b)}>Claim some</button>
                  </div>
                </Card>
              ))}
            </div>
          )}
          <p className="text-xs text-muted mt-4">
            Amounts for beer still in tank are estimates until it is packaged. Availability is first approved, first served.
          </p>
        </section>
      )}

      {tab === "requests" && (
        <section>
          {requests.isLoading && <p className="text-sm text-muted">Loading…</p>}
          {requests.data && requests.data.length === 0 && (
            <Card><p className="text-sm text-muted">No requests yet. Start from Capacity or Available beer.</p></Card>
          )}
          <div className="flex flex-col gap-2">
            {(requests.data ?? []).map((r) => (
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
                      {" · sent "}{longDate(r.created_at)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                    {r.status === "submitted" && !readOnly && (
                      <button className="btn-secondary btn-xxs" onClick={() => withdraw(r.id)}>Withdraw</button>
                    )}
                  </div>
                </div>
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
          {history.data && history.data.length === 0 && <Card><p className="text-sm text-muted">No commitments on record yet.</p></Card>}
          <div className="flex flex-col gap-2">
            {(history.data ?? []).map((d) => <DealCard key={d.id} deal={d} />)}
          </div>
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

function DealCard({ deal }: { deal: PortalDeal }) {
  const [open, setOpen] = useState(false);
  const pct = deal.booked_bbl > 0 ? Math.min(100, (deal.shipped_bbl / deal.booked_bbl) * 100) : 0;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-primary">{deal.beer_name ?? "Beer"}</div>
          <div className="text-xs text-muted mt-0.5">
            {deal.received_on ? `Committed ${longDate(deal.received_on)}` : "Commitment"}
            {deal.desired_delivery_date ? ` · wanted by ${longDate(deal.desired_delivery_date)}` : ""}
          </div>
        </div>
        <Badge tone={deal.status === "open" ? "info" : deal.status === "closed" ? "success" : "neutral"}>
          {deal.status === "open" ? "Open" : deal.status === "closed" ? "Complete" : "Cancelled"}
        </Badge>
      </div>
      <div className="mt-3 h-1.5 rounded-full bg-surface-mid overflow-hidden">
        <div className="h-full bg-success-emphasis" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary mt-2">
        <span>{bbl(deal.shipped_bbl)} shipped of {bbl(deal.booked_bbl)}</span>
        {deal.status === "open" && deal.remaining_bbl > 0 && <span>{bbl(deal.remaining_bbl)} to come</span>}
        {deal.in_tank_bbl > 0 && <span>{bbl(deal.in_tank_bbl)} still in tank</span>}
        {deal.deposit && deal.deposit.billed_cents > 0 && (
          <span>Deposit {dollars(deal.deposit.paid_cents)} paid of {dollars(deal.deposit.billed_cents)}</span>
        )}
      </div>
      {deal.shipments.length > 0 && (
        <button className="btn-secondary btn-xxs mt-3" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Show"} {deal.shipments.length} shipment{deal.shipments.length === 1 ? "" : "s"}
        </button>
      )}
      {open && (
        <ul className="mt-2 border-t border-line pt-2 flex flex-col gap-1">
          {deal.shipments.map((s, i) => (
            <li key={i} className="flex flex-wrap justify-between gap-2 text-xs">
              <span className="text-body">{longDate(s.date)}</span>
              <span className="text-muted">{s.lines.map((l) => `${l.quantity} × ${l.label ?? "package"}`).join(", ")}</span>
              <span className="text-secondary">{bbl(s.volume_bbl)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Staff opening /partner with no company chosen: pick whose portal to preview. */
function PreviewPicker({ onPick }: { onPick: (id: string) => void }) {
  const { data: partners = [] } = useQuery({
    queryKey: ["partners", "contract-brewing", "options"],
    queryFn: () => fetchJson<Array<{ id: string; company_name: string }>>("/api/partners/contract-brewing"),
  });
  return (
    <div className="px-4 sm:px-6 max-w-xl">
      <PageHeader title="Partner portal preview" description="See the portal exactly as a partner company sees it. Read-only." />
      <select className="inp w-full mt-2" defaultValue="" onChange={(e) => e.target.value && onPick(e.target.value)} aria-label="Partner company">
        <option value="">Choose a company…</option>
        {partners.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
      </select>
    </div>
  );
}
