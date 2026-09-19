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
    row = {
      kind: "batch", recipe_id: recipeId, new_beer: newBeer, turns, volume_bbl: turns * TURN_BBL,
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

const REQUEST_SELECT = `id, partner_id, kind, recipe_id, batch_id, turns, volume_bbl, desired_date, notes, new_beer, files,
  status, channel, decision_note, decided_at, commitment_id, allocation_id, created_at,
  recipes(beer_name, style), brew_batches(beer_name, batch_number), contract_brewing_partners(company_name)`;

interface RequestRow {
  id: string; partner_id: string; kind: "batch" | "claim"; recipe_id: string | null; batch_id: string | null;
  turns: number | null; volume_bbl: number | string; desired_date: string | null; notes: string | null;
  new_beer: NewBeer | null; files: RequestFile[]; status: string; channel: string | null;
  decision_note: string | null; decided_at: string | null; commitment_id: string | null; allocation_id: string | null; created_at: string;
  recipes: { beer_name: string | null; style: string | null } | null;
  brew_batches: { beer_name: string | null; batch_number: string | null } | null;
  contract_brewing_partners: { company_name: string } | null;
}

export interface PortalRequest {
  id: string; kind: "batch" | "claim"; beer_name: string; is_new_beer: boolean;
  turns: number | null; volume_bbl: number; desired_date: string | null; notes: string | null;
  status: string; decision_note: string | null; decided_at: string | null; created_at: string; file_names: string[];
}

const beerName = (r: RequestRow) => r.recipes?.beer_name ?? r.new_beer?.name ?? r.brew_batches?.beer_name ?? "Beer";

/** A partner's own requests — no channel, no batch number, no staff identity. */
export async function listRequestsForPartner(admin: SupabaseClient, partnerId: string): Promise<PortalRequest[]> {
  const { data } = await admin.from("partner_requests").select(REQUEST_SELECT).eq("partner_id", partnerId).order("created_at", { ascending: false });
  return ((data ?? []) as unknown as RequestRow[]).map((r) => ({
    id: r.id, kind: r.kind, beer_name: beerName(r), is_new_beer: r.kind === "batch" && !r.recipe_id,
    turns: r.turns, volume_bbl: Number(r.volume_bbl), desired_date: r.desired_date, notes: r.notes,
    status: r.status, decision_note: r.decision_note, decided_at: r.decided_at, created_at: r.created_at,
    file_names: (r.files ?? []).map((f) => f.name),
  }));
}

export interface InboxRequest extends Omit<PortalRequest, "file_names"> {
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
      id: r.id, kind: r.kind, beer_name: beerName(r), is_new_beer: r.kind === "batch" && !r.recipe_id,
      turns: r.turns, volume_bbl: Number(r.volume_bbl), desired_date: r.desired_date, notes: r.notes,
      status: r.status, decision_note: r.decision_note, decided_at: r.decided_at, created_at: r.created_at,
      partner_id: r.partner_id, partner_name: r.contract_brewing_partners?.company_name ?? "Partner",
      recipe_id: r.recipe_id, batch_id: r.batch_id, batch_number: r.brew_batches?.batch_number ?? null,
      new_beer: r.new_beer, files: r.files ?? [], channel: r.channel, commitment_id: r.commitment_id,
      claimable_now_bbl: r.status === "submitted" && r.kind === "claim" && r.batch_id ? (pools.get(r.batch_id)?.pool.claimableBbl ?? 0) : null,
      suggested_channel: (lastChannel.get(r.partner_id) ?? []).find((c) => allowed.includes(c)) ?? null,
    };
  });
}

// ── Withdraw ────────────────────────────────────────────────────────────────

export async function withdrawRequest(admin: SupabaseClient, partnerId: string, id: string): Promise<void> {
  const { data } = await admin.from("partner_requests")
    .update({ status: "withdrawn" }).eq("id", id).eq("partner_id", partnerId).eq("status", "submitted").select("id");
  if (!data || data.length === 0) throw new RequestError("That request has already been decided.", 409);
}

// ── Decide ──────────────────────────────────────────────────────────────────

export interface DecideInput {
  action: "approve" | "decline";
  note?: string;
  channel?: string;
  /** For a new beer: the recipe the brewer built from the partner's write-up. */
  recipe_id?: string;
}

export async function decideRequest(admin: SupabaseClient, deciderId: string, id: string, input: DecideInput): Promise<{ commitment_id: string | null; allocation_id: string | null }> {
  const note = text(input.note, 2000) || null;
  if (input.action === "decline" && !note) throw new RequestError("Tell the partner why — a declined request needs a note.");
  if (input.action !== "approve" && input.action !== "decline") throw new RequestError("Unknown action.");

  // Take the decision first, atomically: two brewers clicking Approve must not
  // both create the deal. Anything that fails below hands the request back.
  const stamp = { decided_by: deciderId, decided_at: new Date().toISOString(), decision_note: note };
  const { data: taken } = await admin.from("partner_requests")
    .update({ status: input.action === "approve" ? "approved" : "declined", ...stamp })
    .eq("id", id).eq("status", "submitted")
    .select("id, partner_id, kind, recipe_id, batch_id, volume_bbl, desired_date, notes, created_at");
  const req = taken?.[0] as { id: string; partner_id: string; kind: "batch" | "claim"; recipe_id: string | null; batch_id: string | null; volume_bbl: number | string; desired_date: string | null; notes: string | null; created_at: string } | undefined;
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

type Taken = { id: string; partner_id: string; recipe_id: string | null; batch_id: string | null; volume_bbl: number | string; desired_date: string | null; notes: string | null; created_at: string };

const dealNotes = (req: Taken) => `Requested through the partner portal.${req.notes ? ` Partner's note: ${req.notes}` : ""}`;

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
  const commitment_id = await insertCommitment(admin, {
    recipe_id: recipeId, partner_id: req.partner_id, volume_bbl: Number(req.volume_bbl), channel: input.channel,
    desired_delivery_date: delivery, received_on: req.created_at.slice(0, 10), notes: dealNotes(req),
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
