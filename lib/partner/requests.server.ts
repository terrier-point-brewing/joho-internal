import type { SupabaseClient } from "@supabase/supabase-js";
import { leadTimeDays } from "@/app/production/types";
import { recheckCommitmentFulfillment } from "@/lib/production/commitmentFulfillment";
import { maxTurns, TURN_BBL } from "./capacity";
import { planClaim, visibleToPartner } from "./claimable";
import { loadClaimPools } from "./portal.server";

/**
 * Partner requests: what a partner asked for, and what a brewer did about it.
 *
 * A request is a note in an inbox and nothing more until it is approved — it
 * holds no beer and no tank. Approval is the only place it touches production
 * data, and it does so by creating the same commitment (and, for a claim, the
 * same allocation) a brewer would have created by hand. From that moment the
 * deal is an ordinary commitment and the request is a closed record.
 *
 * A batch request is sized in whole turns, but the partner may want less beer
 * than the turns yield (two turns, thirty barrels). That ask is wanted_bbl and
 * the share of the brew it works out to is share_pct. The brewery can counter
 * with a different share and a note — the request then waits on the partner
 * ('adjusted') until they accept (back to 'submitted' at the offered share) or
 * rescind it ('withdrawn').
 */

export const REQUEST_BUCKET = "partner-requests";
export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const CLAIM_CHANNELS = ["distribution", "wholesale"] as const;
const BATCH_CHANNELS = ["contract_brewing", "distribution", "wholesale"] as const;

export class RequestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface NewBeer {
  name: string;
  style: string | null;
  abv: number | null;
  ingredients: string;
  instructions: string;
  /** Who brings the ingredients — it changes what the deposit covers. */
  ingredient_supply: "partner" | "brewery";
}

export interface RequestFile { path: string; name: string; size: number; type: string }

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The slice of a brew that `wantedBbl` is, as a whole-number-friendly percentage. */
export const shareOf = (wantedBbl: number, brewBbl: number) => round2((wantedBbl / brewBbl) * 100);
/** The barrels a share of a brew comes to. */
export const bblOfShare = (pct: number, brewBbl: number) => round2((pct / 100) * brewBbl);

function parseNewBeer(raw: unknown): NewBeer {
  const b = (raw ?? {}) as Record<string, unknown>;
  const name = text(b.name, 120), ingredients = text(b.ingredients, 8000), instructions = text(b.instructions, 8000);
  if (!name) throw new RequestError("Give the new beer a name.");
  if (!ingredients) throw new RequestError("List the ingredients, with quantities per turn.");
  if (!instructions) throw new RequestError("Add the brew instructions so our brewers can build the recipe.");
  const abv = Number(b.abv);
  return {
    name, ingredients, instructions,
    style: text(b.style, 120) || null,
    abv: Number.isFinite(abv) && abv > 0 && abv < 30 ? abv : null,
    ingredient_supply: b.ingredient_supply === "partner" ? "partner" : "brewery",
  };
}

// ── Submit ──────────────────────────────────────────────────────────────────

export async function submitRequest(
  admin: SupabaseClient,
  caller: { partnerId: string; userId: string },
  payload: Record<string, unknown>,
  files: File[],
): Promise<{ id: string }> {
  if (files.length > MAX_FILES) throw new RequestError(`Attach at most ${MAX_FILES} files.`);
  for (const f of files) if (f.size > MAX_FILE_BYTES) throw new RequestError(`${f.name} is larger than 10 MB.`);

  const notes = text(payload.notes, 4000) || null;
  let row: Record<string, unknown>;

  if (payload.kind === "claim") {
    const batchId = text(payload.batch_id, 64);
    const bbl = Math.round(Number(payload.volume_bbl) * 100) / 100;
    if (!batchId || !(bbl > 0)) throw new RequestError("Choose a beer and how much of it you want.");
    const entry = (await loadClaimPools(admin, { batchIds: [batchId] })).get(batchId);
    const owner = { partner_id: entry?.batch.recipes?.partner_id ?? null, exclusive: entry?.batch.recipes?.contract_brewing_partners?.recipes_exclusive ?? false };
    if (!entry || !visibleToPartner(caller.partnerId, owner)) throw new RequestError("That beer is no longer available.", 404);
    if (bbl > entry.pool.claimableBbl + 1e-4) {
      throw new RequestError(`Only ${entry.pool.claimableBbl} bbl of that beer is available right now.`, 409);
    }
    row = { kind: "claim", batch_id: batchId, volume_bbl: bbl };
  } else if (payload.kind === "batch") {
    const turns = Math.round(Number(payload.turns));
    const { data: fermenters } = await admin.from("equipment").select("id, capacity_bbl").eq("type", "fermenter");
    const cap = maxTurns((fermenters ?? []) as Array<{ id: string; capacity_bbl: number | null }>);
    if (!(turns >= 1) || turns > cap) throw new RequestError(`Choose between 1 and ${cap} turns.`);

    const recipeId = text(payload.recipe_id, 64) || null;
    let newBeer: NewBeer | null = null;
    if (recipeId) {
      // Only the partner's own recipes — never someone else's, by id or otherwise.
      const { data: recipe } = await admin.from("recipes").select("id").eq("id", recipeId).eq("partner_id", caller.partnerId).maybeSingle();
      if (!recipe) throw new RequestError("That beer is not one of yours.", 404);
    } else {
      newBeer = parseNewBeer(payload.new_beer);
    }
    const desired = text(payload.desired_date, 10);
    const brewBbl = turns * TURN_BBL;
    // How much of the brew they actually want. Blank means all of it.
    const wanted = payload.wanted_bbl == null || payload.wanted_bbl === "" ? brewBbl : round2(Number(payload.wanted_bbl));
    if (!(wanted > 0)) throw new RequestError("Tell us roughly how many barrels you want.");
    if (wanted > brewBbl + 1e-4) throw new RequestError(`${turns} turn${turns === 1 ? "" : "s"} brews about ${brewBbl} bbl — ask for more turns if you need more beer.`);
    row = {
      kind: "batch", recipe_id: recipeId, new_beer: newBeer, turns, volume_bbl: brewBbl,
      wanted_bbl: wanted, share_pct: shareOf(wanted, brewBbl),
      desired_date: /^\d{4}-\d{2}-\d{2}$/.test(desired) ? desired : null,
    };
  } else {
    throw new RequestError("Unknown request type.");
  }

  const { data: created, error } = await admin.from("partner_requests")
    .insert({ ...row, notes, partner_id: caller.partnerId, created_by: caller.userId })
    .select("id").single();
  if (error || !created) throw new RequestError(error?.message ?? "Could not save the request.", 500);

  const stored: RequestFile[] = [];
  for (const f of files) {
    const safe = (f.name.split(/[\\/]/).pop() ?? "file").replace(/[^\w.\- ]+/g, "_") || "file";
    const path = `${caller.partnerId}/${created.id}/${crypto.randomUUID()}-${safe}`;
    const { error: upErr } = await admin.storage.from(REQUEST_BUCKET).upload(path, f, { contentType: f.type || "application/octet-stream" });
    if (upErr) {
      // Never leave a request that silently lost its recipe.
      if (stored.length > 0) await admin.storage.from(REQUEST_BUCKET).remove(stored.map((s) => s.path));
      await admin.from("partner_requests").delete().eq("id", created.id);
      throw new RequestError(`Could not upload ${f.name}: ${upErr.message}`, 500);
    }
    stored.push({ path, name: f.name, size: f.size, type: f.type });
  }
  if (stored.length > 0) await admin.from("partner_requests").update({ files: stored }).eq("id", created.id);
  return { id: created.id };
}

// ── Read ────────────────────────────────────────────────────────────────────

const REQUEST_SELECT = `id, partner_id, kind, recipe_id, batch_id, turns, volume_bbl, wanted_bbl, share_pct, desired_date, notes, new_beer, files,
  status, channel, decision_note, decided_at, decided_by, created_by, commitment_id, allocation_id, created_at,
  offered_pct, offered_bbl, offer_note, offered_by, offered_at, offer_answered_at,
  recipes(beer_name, style), brew_batches(beer_name, batch_number), contract_brewing_partners(company_name)`;

interface RequestRow {
  id: string; partner_id: string; kind: "batch" | "claim"; recipe_id: string | null; batch_id: string | null;
  turns: number | null; volume_bbl: number | string; wanted_bbl: number | string | null; share_pct: number | string | null;
  desired_date: string | null; notes: string | null;
  new_beer: NewBeer | null; files: RequestFile[]; status: string; channel: string | null;
  decision_note: string | null; decided_at: string | null; decided_by: string | null; created_by: string | null;
  commitment_id: string | null; allocation_id: string | null; created_at: string;
  offered_pct: number | string | null; offered_bbl: number | string | null; offer_note: string | null;
  offered_by: string | null; offered_at: string | null; offer_answered_at: string | null;
  recipes: { beer_name: string | null; style: string | null } | null;
  brew_batches: { beer_name: string | null; batch_number: string | null } | null;
  contract_brewing_partners: { company_name: string } | null;
}

/** The brewery's counter-offer on a batch request: a different share of the brew, and why. */
export interface RequestOffer {
  pct: number; bbl: number; note: string | null; offered_at: string | null;
  /** When the partner accepted or rescinded; null while it waits on them. */
  answered_at: string | null;
}

export interface PortalRequest {
  id: string; kind: "batch" | "claim"; beer_name: string; is_new_beer: boolean;
  turns: number | null; volume_bbl: number; desired_date: string | null; notes: string | null;
  /** Batch requests: the beer actually wanted and the share of the brew it is. Claims: null. */
  wanted_bbl: number | null; share_pct: number | null;
  offer: RequestOffer | null;
  status: string; decision_note: string | null; decided_at: string | null; created_at: string; file_names: string[];
  /** Which of the company's logins sent it — a company can have several. */
  submitted_by: string | null;
  /** Set only when a colleague withdrew it. Staff who approve or decline are never named to a partner. */
  withdrawn_by: string | null;
}

/** user id → email, for the audit trail on a request. */
async function emailsOf(admin: SupabaseClient, ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();
  const { data } = await admin.from("profiles").select("id, email").in("id", wanted);
  return new Map(((data ?? []) as Array<{ id: string; email: string }>).map((p) => [p.id, p.email]));
}

const beerName = (r: RequestRow) => r.recipes?.beer_name ?? r.new_beer?.name ?? r.brew_batches?.beer_name ?? "Beer";
const num = (v: number | string | null) => (v == null ? null : Number(v));
const offerOf = (r: RequestRow): RequestOffer | null => r.offered_pct == null ? null
  : { pct: Number(r.offered_pct), bbl: Number(r.offered_bbl), note: r.offer_note, offered_at: r.offered_at, answered_at: r.offer_answered_at };
const shapeOf = (r: RequestRow) => ({
  id: r.id, kind: r.kind, beer_name: beerName(r), is_new_beer: r.kind === "batch" && !r.recipe_id,
  turns: r.turns, volume_bbl: Number(r.volume_bbl), desired_date: r.desired_date, notes: r.notes,
  wanted_bbl: r.kind === "batch" ? num(r.wanted_bbl) ?? Number(r.volume_bbl) : null,
  share_pct: r.kind === "batch" ? num(r.share_pct) ?? 100 : null,
  offer: offerOf(r),
  status: r.status, decision_note: r.decision_note, decided_at: r.decided_at, created_at: r.created_at,
});

/** A partner's own requests — no channel, no batch number, no staff identity. */
export async function listRequestsForPartner(admin: SupabaseClient, partnerId: string): Promise<PortalRequest[]> {
  const { data } = await admin.from("partner_requests").select(REQUEST_SELECT).eq("partner_id", partnerId).order("created_at", { ascending: false });
  const rows = (data ?? []) as unknown as RequestRow[];
  const emails = await emailsOf(admin, rows.flatMap((r) => [r.created_by, r.status === "withdrawn" ? r.decided_by : null]));
  return rows.map((r) => ({
    ...shapeOf(r),
    submitted_by: r.created_by ? emails.get(r.created_by) ?? null : null,
    withdrawn_by: r.status === "withdrawn" && r.decided_by ? emails.get(r.decided_by) ?? null : null,
    file_names: (r.files ?? []).map((f) => f.name),
  }));
}

export interface InboxRequest extends Omit<PortalRequest, "file_names" | "withdrawn_by"> {
  /** Who approved, declined or withdrew it. */
  decided_by: string | null;
  /** Who made the counter-offer. */
  offered_by: string | null;
  partner_id: string; partner_name: string; recipe_id: string | null; batch_id: string | null; batch_number: string | null;
  new_beer: NewBeer | null; files: RequestFile[]; channel: string | null;
  commitment_id: string | null;
  /** For an open claim: what the batch can give up right now. */
  claimable_now_bbl: number | null;
  /** The partner's most recent deal's channel — the approval's starting point. */
  suggested_channel: string | null;
}

export async function listInbox(admin: SupabaseClient): Promise<InboxRequest[]> {
  const { data } = await admin.from("partner_requests").select(REQUEST_SELECT).order("created_at", { ascending: false }).limit(200);
  const rows = (data ?? []) as unknown as RequestRow[];

  const openClaimBatches = [...new Set(rows.filter((r) => r.status === "submitted" && r.kind === "claim" && r.batch_id).map((r) => r.batch_id!))];
  const partnerIds = [...new Set(rows.map((r) => r.partner_id))];
  const emails = await emailsOf(admin, rows.flatMap((r) => [r.created_by, r.decided_by, r.offered_by]));
  const [pools, { data: deals }] = await Promise.all([
    openClaimBatches.length > 0 ? loadClaimPools(admin, { batchIds: openClaimBatches }) : Promise.resolve(new Map()),
    partnerIds.length > 0
      ? admin.from("commitments").select("partner_id, channel, created_at").in("partner_id", partnerIds).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as Array<{ partner_id: string; channel: string }> }),
  ]);
  const lastChannel = new Map<string, string[]>();
  for (const d of (deals ?? []) as Array<{ partner_id: string; channel: string }>) {
    const list = lastChannel.get(d.partner_id) ?? [];
    if (!list.includes(d.channel)) list.push(d.channel);
    lastChannel.set(d.partner_id, list);
  }

  return rows.map((r) => {
    const allowed: readonly string[] = r.kind === "claim" ? CLAIM_CHANNELS : BATCH_CHANNELS;
    return {
      ...shapeOf(r),
      submitted_by: r.created_by ? emails.get(r.created_by) ?? null : null,
      decided_by: r.decided_by ? emails.get(r.decided_by) ?? null : null,
      offered_by: r.offered_by ? emails.get(r.offered_by) ?? null : null,
      partner_id: r.partner_id, partner_name: r.contract_brewing_partners?.company_name ?? "Partner",
      recipe_id: r.recipe_id, batch_id: r.batch_id, batch_number: r.brew_batches?.batch_number ?? null,
      new_beer: r.new_beer, files: r.files ?? [], channel: r.channel, commitment_id: r.commitment_id,
      claimable_now_bbl: r.status === "submitted" && r.kind === "claim" && r.batch_id ? (pools.get(r.batch_id)?.pool.claimableBbl ?? 0) : null,
      suggested_channel: (lastChannel.get(r.partner_id) ?? []).find((c) => allowed.includes(c)) ?? null,
    };
  });
}

// ── Withdraw ────────────────────────────────────────────────────────────────

export async function withdrawRequest(admin: SupabaseClient, partnerId: string, id: string, userId: string): Promise<void> {
  // A withdrawal is a decision too — it records which login made it, and when.
  const { data } = await admin.from("partner_requests")
    .update({ status: "withdrawn", decided_by: userId, decided_at: new Date().toISOString() })
    .eq("id", id).eq("partner_id", partnerId).in("status", ["submitted", "adjusted"]).select("id");
  if (!data || data.length === 0) throw new RequestError("That request has already been decided.", 409);
}

// ── Answer a counter-offer ──────────────────────────────────────────────────

/**
 * The partner's reply to an adjusted share. Accepting makes the offer the
 * request (wanted and share become the offered figures) and sends it back to
 * the inbox for the final approval; rescinding withdraws it. The offer itself
 * stays on the row either way, as the record of what was proposed.
 */
export async function answerOffer(
  admin: SupabaseClient, partnerId: string, id: string, userId: string, action: "accept" | "rescind",
): Promise<void> {
  if (action === "rescind") return withdrawRequest(admin, partnerId, id, userId);
  if (action !== "accept") throw new RequestError("Unknown action.");
  const { data: rows } = await admin.from("partner_requests").select("id, offered_pct, offered_bbl")
    .eq("id", id).eq("partner_id", partnerId).eq("status", "adjusted");
  const row = rows?.[0] as { offered_pct: number | string | null; offered_bbl: number | string | null } | undefined;
  if (!row || row.offered_pct == null) throw new RequestError("There is no offer waiting on this request.", 409);
  const { data } = await admin.from("partner_requests")
    .update({ status: "submitted", share_pct: Number(row.offered_pct), wanted_bbl: Number(row.offered_bbl), offer_answered_at: new Date().toISOString() })
    .eq("id", id).eq("partner_id", partnerId).eq("status", "adjusted").select("id");
  if (!data || data.length === 0) throw new RequestError("That request has already been decided.", 409);
}

/** Every login at a partner company — who to email about their request. */
export async function partnerEmails(admin: SupabaseClient, partnerId: string): Promise<string[]> {
  const { data } = await admin.from("profiles").select("email").eq("partner_id", partnerId);
  return ((data ?? []) as Array<{ email: string | null }>).map((p) => p.email?.trim() ?? "").filter((e) => e.includes("@"));
}

// ── Decide ──────────────────────────────────────────────────────────────────

export interface DecideInput {
  action: "approve" | "decline" | "adjust";
  note?: string;
  channel?: string;
  /** For a new beer: the recipe the brewer built from the partner's write-up. */
  recipe_id?: string;
  /** For adjust: the share of the brew the brewery is willing to book. */
  share_pct?: number;
}

export interface Decision {
  commitment_id: string | null; allocation_id: string | null;
  /** For adjust: what the partner is being offered, for the email. */
  offer?: { partner_id: string; pct: number; bbl: number; turns: number; brew_bbl: number; note: string; beer_name: string };
}

export async function decideRequest(admin: SupabaseClient, deciderId: string, id: string, input: DecideInput): Promise<Decision> {
  const note = text(input.note, 2000) || null;
  if (input.action === "decline" && !note) throw new RequestError("Tell the partner why — a declined request needs a note.");
  if (input.action === "adjust") return adjustRequest(admin, deciderId, id, input.share_pct, note);
  if (input.action !== "approve" && input.action !== "decline") throw new RequestError("Unknown action.");

  // Take the decision first, atomically: two brewers clicking Approve must not
  // both create the deal. Anything that fails below hands the request back.
  // A decline can also end a request still waiting on the partner's answer;
  // an approval cannot — the share is not agreed yet.
  const stamp = { decided_by: deciderId, decided_at: new Date().toISOString(), decision_note: note };
  const { data: taken } = await admin.from("partner_requests")
    .update({ status: input.action === "approve" ? "approved" : "declined", ...stamp })
    .eq("id", id).in("status", input.action === "approve" ? ["submitted"] : ["submitted", "adjusted"])
    .select("id, partner_id, kind, recipe_id, batch_id, turns, volume_bbl, wanted_bbl, share_pct, desired_date, notes, created_at");
  const req = taken?.[0] as Taken | undefined;
  if (!req) throw new RequestError("That request has already been decided or withdrawn.", 409);
  if (input.action === "decline") return { commitment_id: null, allocation_id: null };

  const release = () => admin.from("partner_requests")
    .update({ status: "submitted", decided_by: null, decided_at: null, decision_note: null }).eq("id", id);

  try {
    const result = req.kind === "claim"
      ? await approveClaim(admin, req, input)
      : await approveBatch(admin, req, input);
    await admin.from("partner_requests").update({ channel: input.channel, ...result, ...(req.kind === "batch" && input.recipe_id ? { recipe_id: input.recipe_id } : {}) }).eq("id", id);
    return result;
  } catch (e) {
    await release();
    throw e;
  }
}

type Taken = {
  id: string; partner_id: string; kind: "batch" | "claim"; recipe_id: string | null; batch_id: string | null; turns: number | null;
  volume_bbl: number | string; wanted_bbl: number | string | null; share_pct: number | string | null;
  desired_date: string | null; notes: string | null; created_at: string;
};

const dealNotes = (req: Taken) => `Requested through the partner portal.${req.notes ? ` Partner's note: ${req.notes}` : ""}`;

/**
 * Counter with a different share of the brew. The request leaves the inbox
 * and waits on the partner; nothing is booked until they accept and a brewer
 * approves the agreed share.
 */
async function adjustRequest(admin: SupabaseClient, deciderId: string, id: string, sharePct: number | undefined, note: string | null): Promise<Decision> {
  const pct = round2(Number(sharePct));
  if (!(pct > 0) || pct > 100) throw new RequestError("The share must be between 1% and 100% of the brew.");
  if (!note) throw new RequestError("Tell the partner why — an adjusted share needs a note.");
  const { data: rows } = await admin.from("partner_requests")
    .select("id, kind, turns, volume_bbl, share_pct, wanted_bbl, new_beer, recipes(beer_name)").eq("id", id).eq("status", "submitted");
  const req = rows?.[0] as { kind: string; turns: number | null; volume_bbl: number | string; share_pct: number | string | null; new_beer: { name?: string } | null; recipes: { beer_name: string | null } | { beer_name: string | null }[] | null } | undefined;
  if (!req) throw new RequestError("That request has already been decided or withdrawn.", 409);
  if (req.kind !== "batch") throw new RequestError("Only a batch request has a share to adjust — decline a claim with a note instead.");
  if (Math.abs(pct - Number(req.share_pct ?? 100)) < 1e-6) throw new RequestError("That is the share they asked for — approve it instead.");
  const brewBbl = Number(req.volume_bbl);
  const bbl = bblOfShare(pct, brewBbl);
  const { data } = await admin.from("partner_requests")
    .update({ status: "adjusted", offered_pct: pct, offered_bbl: bbl, offer_note: note, offered_by: deciderId, offered_at: new Date().toISOString(), offer_answered_at: null })
    .eq("id", id).eq("status", "submitted").select("id, partner_id");
  const row = data?.[0] as { partner_id: string } | undefined;
  if (!row) throw new RequestError("That request has already been decided or withdrawn.", 409);
  const recipe = Array.isArray(req.recipes) ? req.recipes[0] : req.recipes;
  return {
    commitment_id: null, allocation_id: null,
    offer: { partner_id: row.partner_id, pct, bbl, turns: req.turns ?? 0, brew_bbl: brewBbl, note, beer_name: recipe?.beer_name ?? req.new_beer?.name ?? "your beer" },
  };
}

async function insertCommitment(admin: SupabaseClient, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from("commitments")
    .insert({ status: "open", last_edited_on: new Date().toISOString(), ...row }).select("id").single();
  if (error || !data) throw new RequestError(error?.message ?? "Could not create the commitment.", 500);
  return data.id as string;
}

async function approveBatch(admin: SupabaseClient, req: Taken, input: DecideInput) {
  if (!(BATCH_CHANNELS as readonly string[]).includes(input.channel ?? "")) throw new RequestError("Choose the partnership model for this deal.");
  const recipeId = req.recipe_id ?? input.recipe_id ?? null;
  if (!recipeId) throw new RequestError("Build the recipe under this partner first, then attach it here.");
  const { data: recipe } = await admin.from("recipes")
    .select("id, partner_id, days_brewhouse, days_fermenter, days_brite").eq("id", recipeId).maybeSingle();
  if (!recipe) throw new RequestError("Recipe not found.", 404);
  if (recipe.partner_id !== req.partner_id) throw new RequestError("That recipe belongs to a different partner.");

  // The partner picked a BREW week; a commitment records when they want the beer.
  const lead = leadTimeDays(recipe);
  const delivery = req.desired_date
    ? new Date(Date.parse(`${req.desired_date}T00:00:00Z`) + lead * 86_400_000).toISOString().slice(0, 10)
    : null;
  // The deal is for the beer they want, not the whole brew. The share is the
  // allocation to write when the batch is scheduled from this commitment.
  const brewBbl = Number(req.volume_bbl);
  const wanted = req.wanted_bbl == null ? brewBbl : Number(req.wanted_bbl);
  const share = req.share_pct == null ? 100 : Number(req.share_pct);
  const sizing = share < 100
    ? ` ${share}% of a ${req.turns ?? Math.round(brewBbl / TURN_BBL)}-turn brew (${wanted} of ${brewBbl} bbl) — allocate that share when the batch is scheduled.`
    : "";
  const commitment_id = await insertCommitment(admin, {
    recipe_id: recipeId, partner_id: req.partner_id, volume_bbl: wanted, channel: input.channel,
    desired_delivery_date: delivery, received_on: req.created_at.slice(0, 10), notes: dealNotes(req) + sizing,
  });
  return { commitment_id, allocation_id: null };
}

async function approveClaim(admin: SupabaseClient, req: Taken, input: DecideInput) {
  if (!(CLAIM_CHANNELS as readonly string[]).includes(input.channel ?? "")) {
    throw new RequestError("A claim on existing beer is a distribution or wholesale deal.");
  }
  if (!req.batch_id) throw new RequestError("This claim no longer points at a batch.");
  const entry = (await loadClaimPools(admin, { batchIds: [req.batch_id] })).get(req.batch_id);
  if (!entry) throw new RequestError("That batch is complete — there is nothing left to claim.", 409);
  const bbl = Number(req.volume_bbl);
  let plan;
  try { plan = planClaim(entry.pool, bbl); } catch (e) { throw new RequestError((e as Error).message, 409); }

  const { data: batch } = await admin.from("brew_batches").select("recipe_id").eq("id", req.batch_id).maybeSingle();
  if (!batch?.recipe_id) throw new RequestError("That batch has no recipe, so a commitment cannot be written for it.");

  const commitment_id = await insertCommitment(admin, {
    recipe_id: batch.recipe_id, partner_id: req.partner_id, volume_bbl: bbl, channel: input.channel,
    received_on: req.created_at.slice(0, 10), notes: dealNotes(req),
  });

  // Shrink the sources BEFORE inserting, so the batch never reads over 100%.
  const undone: Array<{ id: string; pct: number }> = [];
  const undo = async () => {
    for (const u of undone) await admin.from("batch_allocations").update({ percentage: u.pct }).eq("id", u.id);
    await admin.from("commitments").delete().eq("id", commitment_id);
  };
  try {
    for (const d of plan.draws) {
      if (!d.allocationId || d.newPct == null) continue;
      const before = entry.pool.sources.find((s) => s.allocationId === d.allocationId)!.percentage;
      const { error } = await admin.from("batch_allocations").update({ percentage: d.newPct }).eq("id", d.allocationId);
      if (error) throw new RequestError(error.message, 500);
      undone.push({ id: d.allocationId, pct: before });
    }
    const { data: alloc, error } = await admin.from("batch_allocations")
      .insert({ batch_id: req.batch_id, channel: input.channel, contract_request_id: commitment_id, partner_id: req.partner_id, percentage: plan.targetPct, notes: "Claimed through the partner portal." })
      .select("id").single();
    if (error || !alloc) throw new RequestError(error?.message ?? "Could not create the allocation.", 500);

    for (const u of undone) await recheckCommitmentFulfillment(admin, u.id);
    await recheckCommitmentFulfillment(admin, alloc.id as string);
    return { commitment_id, allocation_id: alloc.id as string };
  } catch (e) {
    await undo();
    throw e;
  }
}
