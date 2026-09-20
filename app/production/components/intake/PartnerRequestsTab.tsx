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
  desired_date: string | null; notes: string | null; status: "submitted" | "approved" | "declined" | "withdrawn";
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
  approved: { label: "Approved", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};
const QUERY_KEY = ["production", "partner-requests"];
const day = (iso: string | null) => (iso ? new Date(iso.length <= 10 ? `${iso}T12:00:00` : iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");

type View = "open" | "all";

export default function PartnerRequestsTab({ recipes }: { recipes: Recipe[] }) {
  const { can } = usePermissions();
  const canDecide = can(CAP.partnerRequestsDecide);
  const [view, setView] = useState<View>("open");
  const [deciding, setDeciding] = useState<InboxRequest | null>(null);
  const { data = [], isLoading, error } = useQuery({ queryKey: QUERY_KEY, queryFn: () => fetchJson<InboxRequest[]>("/api/production/partner-requests") });

  const rows = view === "open" ? data.filter((r) => r.status === "submitted") : data;

  // The inbox sits above Commitments: loud when something waits, one line when not.
  return (
    <div className="mb-8">
      <h2 className="text-sm font-semibold text-primary mb-2">Partner requests</h2>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <ButtonGroup<View>
          tabs={[{ key: "open", label: `Needs a decision (${data.filter((r) => r.status === "submitted").length})` }, { key: "all", label: "Everything" }]}
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
                {r.notes && <p className="text-xs text-body mt-1">Partner&apos;s note: {r.notes}</p>}
                {r.status !== "submitted" && (
                  <p className="text-xs text-muted mt-1">
                    {r.status === "approved" ? "Approved" : r.status === "declined" ? "Declined" : "Withdrawn"}
                    {r.decided_by ? ` by ${r.decided_by}` : ""}{r.decided_at ? ` on ${day(r.decided_at)}` : ""}
                  </p>
                )}
                {r.decision_note && <p className="text-xs text-muted mt-1">Our reply: {r.decision_note}</p>}
                {r.status === "approved" && r.channel && <p className="text-xs text-muted mt-1">Booked as {CHANNEL_LABEL[r.channel] ?? r.channel} — it is now an ordinary commitment in the list below.</p>}
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                {r.status === "submitted" && (
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
  const channels = isClaim ? ["distribution", "wholesale"] : ["contract_brewing", "distribution", "wholesale"];
  const [channel, setChannel] = useState(r.suggested_channel ?? "");
  const [recipeId, setRecipeId] = useState(r.recipe_id ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);

  const partnerRecipes = recipes.filter((x) => x.partner_id === r.partner_id);
  const short = isClaim && r.claimable_now_bbl != null && r.claimable_now_bbl + 1e-4 < r.volume_bbl;
  const blocked = !channel ? "Choose the partnership model."
    : short ? "There is not enough claimable beer left on that batch. Decline with a note so the partner can ask again."
    : !isClaim && !recipeId ? "Build the recipe under this partner in Recipes, then pick it here."
    : null;

  async function decide(action: "approve" | "decline") {
    setError(null);
    if (action === "decline" && !note.trim()) { setError("Tell the partner why — a declined request needs a note."); return; }
    setBusy(action);
    const res = await fetch(`/api/production/partner-requests/${r.id}/decide`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, note, channel, recipe_id: recipeId || undefined }),
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
                ? "Invoiced at shipment at the product price with the channel discount — no deposit, exactly as any distribution or wholesale deal."
                : channel === "contract_brewing"
                  ? "Approving books the commitment. Schedule its batch from the Commitments list below; the ingredient deposit is raised there once the batch is allocated."
                  : "Approving books the commitment. Schedule its batch from the Commitments list below; it is invoiced at shipment."}
            </p>
            <Field label="Note to the partner" hint="required to decline">
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} className="inp w-full" />
            </Field>
            {blocked && <p className="text-xs text-accent-soft">{blocked}</p>}
            <div className="flex justify-end gap-2 pt-2 border-t border-line mt-2">
              <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
              <button type="button" className="btn-danger" disabled={busy != null} onClick={() => decide("decline")}>{busy === "decline" ? "Saving…" : "Decline"}</button>
              <button type="button" className="btn-primary" disabled={busy != null || blocked != null} onClick={() => decide("approve")}>{busy === "approve" ? "Saving…" : "Approve"}</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
