"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { usePermissions } from "@/lib/hooks/useUserRole";
import { CAP } from "@/lib/auth/capabilities";
import Banner from "@/app/components/ui/Banner";
import Badge from "@/app/components/ui/Badge";
import Card from "@/app/components/ui/Card";
import ButtonGroup from "@/app/components/ButtonGroup";
import { Modal, Field } from "@/app/components/ui/Modal";
import type { Tone } from "@/app/components/ui/tone";
import type { Recipe } from "@/app/production/types";

/**
 * What partners asked for through the portal, and the one place to answer.
 *
 * Approving does by machine what a brewer would do by hand: it writes the
 * commitment and — for a claim on beer already being brewed — moves the share
 * out of the taproom's allocation into a new one for the partner. Nothing is
 * held for a partner until then, so two partners can ask for the same beer;
 * the second approval is refused if the first took it.
 */

interface InboxRequest {
  id: string; kind: "batch" | "claim"; beer_name: string; is_new_beer: boolean; turns: number | null; volume_bbl: number;
  /** Batch requests: the beer actually wanted and the share of the brew it is. Claims: null. */
  wanted_bbl: number | null; share_pct: number | null;
  offer: { pct: number; bbl: number; note: string | null; offered_at: string | null; answered_at: string | null } | null;
  offered_by: string | null;
  desired_date: string | null; notes: string | null; status: "submitted" | "adjusted" | "approved" | "declined" | "withdrawn";
  decision_note: string | null; decided_at: string | null; created_at: string;
  partner_id: string; partner_name: string; recipe_id: string | null; batch_id: string | null; batch_number: string | null;
  new_beer: { name: string; style: string | null; abv: number | null; ingredients: string; instructions: string; ingredient_supply: "partner" | "brewery" } | null;
  files: Array<{ name: string; size: number }>; channel: string | null; commitment_id: string | null;
  claimable_now_bbl: number | null; suggested_channel: string | null;
  submitted_by: string | null; decided_by: string | null;
}

const CHANNEL_LABEL: Record<string, string> = { contract_brewing: "Contract brewing", distribution: "Distribution", wholesale: "Wholesale" };
const STATUS: Record<InboxRequest["status"], { label: string; tone: Tone }> = {
  submitted: { label: "Needs a decision", tone: "accent" },
  adjusted: { label: "Waiting on the partner", tone: "info" },
  approved: { label: "Approved", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};
export const PARTNER_REQUESTS_QUERY_KEY = ["production", "partner-requests"];
const QUERY_KEY = PARTNER_REQUESTS_QUERY_KEY;
const day = (iso: string | null) => (iso ? new Date(iso.length <= 10 ? `${iso}T12:00:00` : iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");

type View = "open" | "all";

export default function PartnerRequestsTab({ recipes }: { recipes: Recipe[] }) {
  const { can } = usePermissions();
  const canDecide = can(CAP.partnerRequestsDecide);
  const [view, setView] = useState<View>("open");
  const [deciding, setDeciding] = useState<InboxRequest | null>(null);
  const { data = [], isLoading, error } = useQuery({ queryKey: QUERY_KEY, queryFn: () => fetchJson<InboxRequest[]>("/api/production/partner-requests") });

  const rows = view === "open" ? data.filter((r) => r.status === "submitted" || r.status === "adjusted") : data;
  /** A partial batch, or a counter-offer the partner came back on — the inbox says which. */
  const sizing = (r: InboxRequest) => {
    if (r.kind !== "batch" || r.share_pct == null || r.wanted_bbl == null) return null;
    if (r.status === "submitted" && r.offer?.answered_at) return `Partner accepted your offer of ${r.share_pct}% (${r.wanted_bbl} bbl) — approve to book it.`;
    if (r.share_pct >= 100) return null;
    return `Wants about ${r.wanted_bbl} bbl — ${r.share_pct}% of the batch. We would carry the other ${Number((r.volume_bbl - r.wanted_bbl).toFixed(2))} bbl.`;
  };

  // The inbox sits above Commitments: loud when something waits, one line when not.
  return (
    <div className="mb-8">
      <h2 className="text-sm font-semibold text-primary mb-2">Partner requests</h2>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <ButtonGroup<View>
          tabs={[{ key: "open", label: `Open (${data.filter((r) => r.status === "submitted" || r.status === "adjusted").length})` }, { key: "all", label: "Everything" }]}
          activeKey={view}
          onSelect={setView}
        />
      </div>
      {error && <Banner className="mb-4">{(error as Error).message}</Banner>}
      {isLoading && <p className="text-sm text-muted">Loading…</p>}
      {!isLoading && rows.length === 0 && (
        <p className="text-sm text-faint">{view === "open" ? "No partner requests are waiting." : "No partner requests yet."}</p>
      )}
      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <Card key={r.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-primary">
                  {r.partner_name} · {r.beer_name}{r.is_new_beer ? " (new beer)" : ""}
                </div>
                <div className="text-xs text-muted mt-0.5">
                  {r.kind === "batch"
                    ? `New batch · ${r.turns} turn${r.turns === 1 ? "" : "s"} (${r.volume_bbl} bbl) · ${r.desired_date ? `brew week of ${day(r.desired_date)}` : "flexible timing"}`
                    : `Claim on ${r.batch_number ?? "a batch"} · ${r.volume_bbl} bbl`}
                  {" · received "}{day(r.created_at)}{r.submitted_by ? ` from ${r.submitted_by}` : ""}
                </div>
                {r.kind === "claim" && r.claimable_now_bbl != null && (
                  <div className={`text-xs mt-1 ${r.claimable_now_bbl + 1e-4 >= r.volume_bbl ? "text-secondary" : "text-danger"}`}>
                    {r.claimable_now_bbl} bbl claimable on that batch right now, after the taproom&apos;s reserve.
                  </div>
                )}
                {sizing(r) && (
                  <div className={`text-xs mt-1 ${r.status === "submitted" && r.offer?.answered_at ? "text-success" : "text-secondary"}`}>{sizing(r)}</div>
                )}
                {r.notes && <p className="text-xs text-body mt-1">Partner&apos;s note: {r.notes}</p>}
                {r.status === "adjusted" && r.offer && (
                  <p className="text-xs text-muted mt-1">
                    Offered {r.offer.pct}% ({r.offer.bbl} bbl){r.offered_by ? ` by ${r.offered_by}` : ""}{r.offer.offered_at ? ` on ${day(r.offer.offered_at)}` : ""} — the partner has not answered yet.
                    {r.offer.note ? ` Note: ${r.offer.note}` : ""}
                  </p>
                )}
                {r.status !== "submitted" && r.status !== "adjusted" && (
                  <p className="text-xs text-muted mt-1">
                    {r.status === "approved" ? "Approved" : r.status === "declined" ? "Declined" : r.offer && !r.offer.answered_at ? "Withdrawn" : r.offer ? "Rescinded by the partner after our offer" : "Withdrawn"}
                    {r.decided_by ? ` by ${r.decided_by}` : ""}{r.decided_at ? ` on ${day(r.decided_at)}` : ""}
                  </p>
                )}
                {r.decision_note && <p className="text-xs text-muted mt-1">Our reply: {r.decision_note}</p>}
                {r.status === "approved" && r.channel && <p className="text-xs text-muted mt-1">Booked as {CHANNEL_LABEL[r.channel] ?? r.channel} — it is now an ordinary commitment in the list below.</p>}
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                {(r.status === "submitted" || r.status === "adjusted") && (
                  <button className="btn-primary btn-xxs" onClick={() => setDeciding(r)}>{canDecide ? "Review" : "View"}</button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
      {deciding && <DecideModal request={deciding} recipes={recipes} canDecide={canDecide} onClose={() => setDeciding(null)} />}
    </div>
  );
}

function DecideModal({ request: r, recipes, canDecide, onClose }: { request: InboxRequest; recipes: Recipe[]; canDecide: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const isClaim = r.kind === "claim";
  const channels = ["contract_brewing", "distribution", "wholesale"];
  const [channel, setChannel] = useState(r.suggested_channel ?? "");
  const [recipeId, setRecipeId] = useState(r.recipe_id ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "decline" | "adjust" | null>(null);
  // Counter-offer: a different share of the brew. Starts at what they asked for.
  const askedPct = r.share_pct ?? 100;
  const [sharePct, setSharePct] = useState(String(askedPct));
  const waiting = r.status === "adjusted";

  const partnerRecipes = recipes.filter((x) => x.partner_id === r.partner_id);
  const short = isClaim && r.claimable_now_bbl != null && r.claimable_now_bbl + 1e-4 < r.volume_bbl;
  const blocked = waiting ? "Waiting on the partner's answer to the offer. You can still decline it."
    : !channel ? "Choose the partnership model."
    : short ? "There is not enough claimable beer left on that batch. Decline with a note so the partner can ask again."
    : !isClaim && !recipeId ? "Build the recipe under this partner in Recipes, then pick it here."
    : null;
  const pctNum = Number(sharePct);
  const pctOk = Number.isFinite(pctNum) && pctNum > 0 && pctNum <= 100;
  const offeredBbl = pctOk ? Math.round((pctNum / 100) * r.volume_bbl * 100) / 100 : null;
  const changed = pctOk && Math.abs(pctNum - askedPct) > 1e-6;

  async function decide(action: "approve" | "decline" | "adjust") {
    setError(null);
    if (action === "decline" && !note.trim()) { setError("Tell the partner why — a declined request needs a note."); return; }
    if (action === "adjust" && !note.trim()) { setError("Tell the partner why — an adjusted share needs a note."); return; }
    setBusy(action);
    const res = await fetch(`/api/production/partner-requests/${r.id}/decide`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, note, channel, recipe_id: recipeId || undefined, ...(action === "adjust" ? { share_pct: pctNum } : {}) }),
    });
    setBusy(null);
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? "Could not save the decision."); return; }
    // An approval writes a commitment and, for a claim, moves allocations.
    qc.invalidateQueries({ queryKey: QUERY_KEY });
    qc.invalidateQueries({ queryKey: ["production"] });
    onClose();
  }

  return (
    <Modal title={`${r.partner_name} — ${isClaim ? "claim" : "new batch"}`} onClose={onClose} wide>
      {error && <Banner className="mb-4">{error}</Banner>}
      <div className="flex flex-col gap-3">
        <div className="text-sm text-body">
          <span className="font-semibold text-primary">{r.beer_name}</span>
          {isClaim
            ? ` — ${r.volume_bbl} bbl from ${r.batch_number ?? "the batch"}`
            : ` — ${r.turns} turn${r.turns === 1 ? "" : "s"} (${r.volume_bbl} bbl), ${r.desired_date ? `brew week of ${day(r.desired_date)}` : "flexible timing"}`}
        </div>
        {isClaim && r.claimable_now_bbl != null && (
          <p className={`text-xs ${short ? "text-danger" : "text-muted"}`}>
            {r.claimable_now_bbl} bbl is claimable right now, after the taproom&apos;s reserve. Approving takes {r.volume_bbl} bbl out of the
            unallocated share first, then the taproom&apos;s allocation, and gives it to a new allocation for {r.partner_name}.
          </p>
        )}
        {!isClaim && r.wanted_bbl != null && r.share_pct != null && (
          <p className={`text-xs ${r.share_pct < 100 ? "text-secondary" : "text-muted"}`}>
            {r.offer?.answered_at && r.status === "submitted"
              ? `The partner accepted your offer of ${r.share_pct}% — about ${r.wanted_bbl} bbl. Approving books that share.`
              : r.share_pct < 100
                ? `They want about ${r.wanted_bbl} bbl — ${r.share_pct}% of the batch. Approving books that share; the other ${Number((r.volume_bbl - r.wanted_bbl).toFixed(2))} bbl is ours to sell.`
                : "They want the whole batch."}
          </p>
        )}
        {waiting && r.offer && (
          <p className="text-xs text-muted">
            Offered {r.offer.pct}% ({r.offer.bbl} bbl){r.offered_by ? ` by ${r.offered_by}` : ""}{r.offer.offered_at ? ` on ${day(r.offer.offered_at)}` : ""}.
            {r.offer.note ? ` Note sent: ${r.offer.note}` : ""}
          </p>
        )}
        {r.notes && <p className="text-xs text-body">Partner&apos;s note: {r.notes}</p>}

        {r.new_beer && (
          <div className="rounded-md border border-line p-3 flex flex-col gap-2 text-xs">
            <div className="text-secondary">
              {[r.new_beer.style, r.new_beer.abv ? `${r.new_beer.abv}% ABV` : null, r.new_beer.ingredient_supply === "partner" ? "Partner supplies ingredients" : "Brewery sources ingredients"].filter(Boolean).join(" · ")}
            </div>
            <div><div className="text-muted mb-0.5">Ingredients</div><pre className="whitespace-pre-wrap font-sans text-body">{r.new_beer.ingredients}</pre></div>
            <div><div className="text-muted mb-0.5">Brew instructions</div><pre className="whitespace-pre-wrap font-sans text-body">{r.new_beer.instructions}</pre></div>
          </div>
        )}
        {r.files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {r.files.map((f, i) => (
              <a key={i} href={`/api/production/partner-requests/${r.id}/file?i=${i}`} target="_blank" rel="noreferrer" className="btn-secondary btn-xxs">{f.name}</a>
            ))}
          </div>
        )}

        {canDecide && (
          <>
            <Field label="Partnership model" required hint={r.suggested_channel ? "prefilled from this partner's last deal" : undefined}>
              <select value={channel} onChange={(e) => setChannel(e.target.value)} className="inp w-full">
                <option value="">Choose…</option>
                {channels.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
              </select>
            </Field>
            {!isClaim && !r.recipe_id && (
              <Field label="Recipe" required hint={`recipes owned by ${r.partner_name}`}>
                <select value={recipeId} onChange={(e) => setRecipeId(e.target.value)} className="inp w-full">
                  <option value="">Choose the recipe you built…</option>
                  {partnerRecipes.map((x) => <option key={x.id} value={x.id}>{x.beer_name}</option>)}
                </select>
              </Field>
            )}
            <p className="text-xs text-muted">
              {isClaim
                ? "Approving books the commitment and their share of the batch."
                : "Approving books the commitment; schedule its batch under Commitments."}
            </p>
            {!isClaim && !waiting && (
              <Field label="Share of the batch" hint={`% — they asked for ${askedPct}%. Change it to send a counter-offer.`}>
                <div className="flex items-center gap-2">
                  <input type="number" inputMode="decimal" min={1} max={100} step={1} value={sharePct} onChange={(e) => setSharePct(e.target.value)} className="inp w-28" />
                  <span className={`text-xs ${pctOk ? "text-muted" : "text-danger"}`}>
                    {!pctOk ? "Between 1 and 100." : `= about ${offeredBbl} bbl of ${r.volume_bbl}${changed ? " — the partner must accept this before it can be booked" : ""}`}
                  </span>
                </div>
              </Field>
            )}
            <Field label="Note to the partner" hint={changed ? "required — it goes in the email with the new share" : "required to decline"}>
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} className="inp w-full" />
            </Field>
            {blocked && <p className="text-xs text-accent-soft">{blocked}</p>}
            <div className="flex justify-end gap-2 pt-2 border-t border-line mt-2">
              <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
              <button type="button" className="btn-danger" disabled={busy != null} onClick={() => decide("decline")}>{busy === "decline" ? "Saving…" : "Decline"}</button>
              {changed ? (
                <button type="button" className="btn-primary" disabled={busy != null || waiting} onClick={() => decide("adjust")}>{busy === "adjust" ? "Sending…" : `Offer ${pctNum}% to the partner`}</button>
              ) : (
                <button type="button" className="btn-primary" disabled={busy != null || blocked != null} onClick={() => decide("approve")}>{busy === "approve" ? "Saving…" : "Approve"}</button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
