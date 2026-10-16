import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { claimPool } from "./claimable";

const loadClaimPools = vi.fn();
const recheck = vi.fn().mockResolvedValue(undefined);
vi.mock("./portal.server", () => ({ loadClaimPools: (...a: unknown[]) => loadClaimPools(...a) }));
vi.mock("@/lib/production/commitmentFulfillment", () => ({ recheckCommitmentFulfillment: (...a: unknown[]) => recheck(...a) }));

import { answerOffer, decideRequest, RequestError } from "./requests.server";

/**
 * A tiny in-memory stand-in for the service-role client: enough of the query
 * builder for decideRequest, recording every write so a test can assert what
 * reached the "database" and in which order.
 */
type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>, opts: { failInsertInto?: string } = {}) {
  const writes: Array<{ table: string; op: string; values?: Row; filters: Row }> = [];
  let seq = 0;
  const from = (table: string) => {
    const state: { op: string; values?: Row; filters: Row } = { op: "select", filters: {} };
    const rows = () => (tables[table] ??= []);
    const match = (r: Row) => Object.entries(state.filters).every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v));
    const run = () => {
      if (state.op === "insert") {
        writes.push({ table, ...state });
        if (opts.failInsertInto === table) return { data: null, error: { message: `insert into ${table} failed` } };
        const row = { id: `${table}-${++seq}`, ...state.values };
        rows().push(row);
        return { data: [row], error: null };
      }
      const hit = rows().filter(match);
      if (state.op === "update") { writes.push({ table, ...state }); hit.forEach((r) => Object.assign(r, state.values)); }
      if (state.op === "delete") { writes.push({ table, ...state }); tables[table] = rows().filter((r) => !match(r)); }
      return { data: hit, error: null };
    };
    const b = {
      select: () => b,
      insert: (values: Row) => { state.op = "insert"; state.values = values; return b; },
      update: (values: Row) => { state.op = "update"; state.values = values; return b; },
      delete: () => { state.op = "delete"; return b; },
      eq: (k: string, v: unknown) => { state.filters[k] = v; return b; },
      in: (k: string, v: unknown[]) => { state.filters[k] = v; return b; },
      single: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    };
    return b;
  };
  return { client: { from } as unknown as SupabaseClient, writes, tables };
}

const claimRequest = (over: Row = {}): Row => ({
  id: "req-1", status: "submitted", partner_id: "fortnight", kind: "claim", recipe_id: null, batch_id: "b1",
  volume_bbl: 10, desired_date: null, notes: "kegs please", created_at: "2026-09-18T12:00:00Z", ...over,
});

// 40 bbl batch: 40% contract, 50% taproom, 10% unallocated; 10% reserve → 20 claimable.
const pool = () => claimPool({ planned_bbl: 40, produced_bbl: 0, converted_bbl: 0, bufferPct: 10, allocations: [
  { id: "contract", channel: "contract_brewing", percentage: 40, written_off_at: null, exported_bbl: 0 },
  { id: "taproom", channel: "taproom", percentage: 50, written_off_at: null, exported_bbl: 0 },
] });

beforeEach(() => {
  vi.clearAllMocks();
  loadClaimPools.mockResolvedValue(new Map([["b1", { batch: { id: "b1" }, pool: pool(), readyBy: null, packaged: false }]]));
});

describe("decideRequest — claims", () => {
  const seed = (req = claimRequest()) => fakeDb({
    partner_requests: [req],
    brew_batches: [{ id: "b1", recipe_id: "recipe-1" }],
    batch_allocations: [{ id: "taproom", percentage: 50 }, { id: "contract", percentage: 40 }],
    commitments: [],
  });

  it("books the commitment and carves the share out of the taproom, leaving the contract partner alone", async () => {
    const db = seed();
    const out = await decideRequest(db.client, "brewer-1", "req-1", { action: "approve", channel: "wholesale" });

    expect(db.tables.commitments).toEqual([expect.objectContaining({
      recipe_id: "recipe-1", partner_id: "fortnight", volume_bbl: 10, channel: "wholesale", status: "open", received_on: "2026-09-18",
    })]);
    // 10 bbl of 40 = 25%: 10% came from the unallocated share, 15% from the taproom.
    expect(db.tables.batch_allocations.find((a) => a.id === "taproom")!.percentage).toBe(35);
    expect(db.tables.batch_allocations.find((a) => a.id === "contract")!.percentage).toBe(40);
    const created = db.tables.batch_allocations.find((a) => a.partner_id === "fortnight")!;
    expect(created).toMatchObject({ batch_id: "b1", channel: "wholesale", percentage: 25, contract_request_id: out.commitment_id });
    expect(db.tables.batch_allocations.reduce((s, a) => s + Number(a.percentage), 0)).toBe(100);

    expect(db.tables.partner_requests[0]).toMatchObject({ status: "approved", decided_by: "brewer-1", channel: "wholesale", commitment_id: out.commitment_id, allocation_id: created.id });
    // The taproom is shrunk BEFORE the new allocation lands, so the batch never reads over 100%.
    const allocWrites = db.writes.filter((w) => w.table === "batch_allocations").map((w) => w.op);
    expect(allocWrites).toEqual(["update", "insert"]);
  });

  it("approves a claim as contract brewing: an ordinary contract allocation, deposit raised on demand", async () => {
    const db = seed();
    const out = await decideRequest(db.client, "brewer-1", "req-1", { action: "approve", channel: "contract_brewing" });
    expect(db.tables.commitments).toEqual([expect.objectContaining({ partner_id: "fortnight", volume_bbl: 10, channel: "contract_brewing", status: "open" })]);
    const created = db.tables.batch_allocations.find((a) => a.partner_id === "fortnight")!;
    // Nothing deposit-related is stamped at approval — the allocation is uninvoiced
    // until someone raises the deposit from it (or the export invoice back-charges it).
    expect(created).toMatchObject({ batch_id: "b1", channel: "contract_brewing", percentage: 25, contract_request_id: out.commitment_id });
    expect(created.invoice_generated_at).toBeUndefined();
    expect(db.tables.batch_allocations.find((a) => a.id === "taproom")!.percentage).toBe(35);
  });

  it("refuses a claim with no model chosen, and hands the request back undecided", async () => {
    const db = seed();
    await expect(decideRequest(db.client, "brewer-1", "req-1", { action: "approve", channel: "retail" }))
      .rejects.toThrow(/Choose the partnership model/);
    expect(db.tables.partner_requests[0]).toMatchObject({ status: "submitted", decided_by: null });
    expect(db.tables.commitments).toEqual([]);
  });

  it("refuses when another approval already took the beer", async () => {
    const db = seed(claimRequest({ volume_bbl: 25 }));
    await expect(decideRequest(db.client, "brewer-1", "req-1", { action: "approve", channel: "distribution" }))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Only 20 bbl/) });
    expect(db.tables.partner_requests[0].status).toBe("submitted");
    expect(db.tables.batch_allocations.find((a) => a.id === "taproom")!.percentage).toBe(50);
  });

  it("puts the taproom's share and the commitment back if the allocation cannot be written", async () => {
    const db = fakeDb({
      partner_requests: [claimRequest()], brew_batches: [{ id: "b1", recipe_id: "recipe-1" }],
      batch_allocations: [{ id: "taproom", percentage: 50 }], commitments: [],
    }, { failInsertInto: "batch_allocations" });
    await expect(decideRequest(db.client, "brewer-1", "req-1", { action: "approve", channel: "wholesale" })).rejects.toBeInstanceOf(RequestError);
    expect(db.tables.batch_allocations.find((a) => a.id === "taproom")!.percentage).toBe(50);
    expect(db.tables.commitments).toEqual([]);
    expect(db.tables.partner_requests[0].status).toBe("submitted");
  });

  it("lets only the first of two decisions through", async () => {
    const db = seed();
    await decideRequest(db.client, "brewer-1", "req-1", { action: "approve", channel: "wholesale" });
    await expect(decideRequest(db.client, "brewer-2", "req-1", { action: "approve", channel: "wholesale" }))
      .rejects.toMatchObject({ status: 409 });
    expect(db.tables.commitments).toHaveLength(1);
  });
});

describe("decideRequest — declining", () => {
  it("needs a note, and touches nothing but the request", async () => {
    const db = fakeDb({ partner_requests: [claimRequest()], commitments: [], batch_allocations: [] });
    await expect(decideRequest(db.client, "brewer-1", "req-1", { action: "decline" })).rejects.toThrow(/needs a note/);
    expect(db.tables.partner_requests[0].status).toBe("submitted");

    await decideRequest(db.client, "brewer-1", "req-1", { action: "decline", note: "Spoken for — try the Brown Ale." });
    expect(db.tables.partner_requests[0]).toMatchObject({ status: "declined", decision_note: "Spoken for — try the Brown Ale." });
    expect(db.writes.every((w) => w.table === "partner_requests")).toBe(true);
  });
});

describe("decideRequest — new batches", () => {
  const batchRequest = (over: Row = {}): Row => ({
    id: "req-2", status: "submitted", partner_id: "fortnight", kind: "batch", recipe_id: "recipe-9", batch_id: null,
    volume_bbl: 40, desired_date: "2026-10-05", notes: null, created_at: "2026-09-18T12:00:00Z", ...over,
  });
  const recipe = { id: "recipe-9", partner_id: "fortnight", days_brewhouse: 1, days_fermenter: 16, days_brite: 5 };

  it("books the commitment only, dated brew week + the recipe's lead time", async () => {
    const db = fakeDb({ partner_requests: [batchRequest()], recipes: [recipe], commitments: [], batch_allocations: [] });
    const out = await decideRequest(db.client, "brewer-1", "req-2", { action: "approve", channel: "contract_brewing" });
    expect(db.tables.commitments[0]).toMatchObject({ recipe_id: "recipe-9", volume_bbl: 40, channel: "contract_brewing", desired_delivery_date: "2026-10-27" });
    expect(out.allocation_id).toBeNull();
    expect(db.tables.batch_allocations).toEqual([]);
  });

  it("will not approve a new beer until a recipe owned by that partner is attached", async () => {
    const db = fakeDb({ partner_requests: [batchRequest({ recipe_id: null })], recipes: [recipe, { id: "argus-recipe", partner_id: "argus" }], commitments: [] });
    await expect(decideRequest(db.client, "brewer-1", "req-2", { action: "approve", channel: "contract_brewing" })).rejects.toThrow(/Build the recipe/);
    await expect(decideRequest(db.client, "brewer-1", "req-2", { action: "approve", channel: "contract_brewing", recipe_id: "argus-recipe" })).rejects.toThrow(/different partner/);
    await decideRequest(db.client, "brewer-1", "req-2", { action: "approve", channel: "contract_brewing", recipe_id: "recipe-9" });
    expect(db.tables.partner_requests[0]).toMatchObject({ status: "approved", recipe_id: "recipe-9" });
  });
});

describe("partial batches — a share of the brew, and a counter-offer", () => {
  const partial = (over: Row = {}): Row => ({
    id: "req-3", status: "submitted", partner_id: "fortnight", kind: "batch", recipe_id: "recipe-9", batch_id: null, turns: 2,
    volume_bbl: 40, wanted_bbl: 30, share_pct: 75, desired_date: null, notes: null, created_at: "2026-09-18T12:00:00Z",
    offered_pct: null, offered_bbl: null, offer_note: null, offered_by: null, offered_at: null, offer_answered_at: null, ...over,
  });
  const recipe = { id: "recipe-9", partner_id: "fortnight", days_brewhouse: 1, days_fermenter: 16, days_brite: 5 };
  const seed = (req = partial()) => fakeDb({ partner_requests: [req], recipes: [recipe], commitments: [], batch_allocations: [] });

  it("approving books the beer they want, not the whole brew, and says so on the deal", async () => {
    const db = seed();
    await decideRequest(db.client, "brewer-1", "req-3", { action: "approve", channel: "contract_brewing" });
    expect(db.tables.commitments[0]).toMatchObject({ volume_bbl: 30, channel: "contract_brewing" });
    expect(String(db.tables.commitments[0].notes)).toMatch(/75% of a 2-turn brew \(30 of 40 bbl\)/);
  });

  it("adjusting counters with a share and a note, and hands the offer back for the email", async () => {
    const db = seed();
    await expect(decideRequest(db.client, "brewer-1", "req-3", { action: "adjust", share_pct: 90 })).rejects.toThrow(/needs a note/);
    await expect(decideRequest(db.client, "brewer-1", "req-3", { action: "adjust", share_pct: 75, note: "x" })).rejects.toThrow(/approve it instead/);
    await expect(decideRequest(db.client, "brewer-1", "req-3", { action: "adjust", share_pct: 120, note: "x" })).rejects.toThrow(/between 1% and 100%/);

    const out = await decideRequest(db.client, "brewer-1", "req-3", { action: "adjust", share_pct: 90, note: "We can't place 10 bbl of this style." });
    expect(out.commitment_id).toBeNull();
    expect(out.offer).toMatchObject({ partner_id: "fortnight", pct: 90, bbl: 36, turns: 2, brew_bbl: 40, note: "We can't place 10 bbl of this style." });
    expect(db.tables.partner_requests[0]).toMatchObject({ status: "adjusted", offered_pct: 90, offered_bbl: 36, offered_by: "brewer-1", wanted_bbl: 30, share_pct: 75 });
    expect(db.tables.commitments).toEqual([]);
  });

  it("a claim has no share to adjust", async () => {
    const db = fakeDb({ partner_requests: [claimRequest()], commitments: [] });
    await expect(decideRequest(db.client, "brewer-1", "req-1", { action: "adjust", share_pct: 50, note: "x" })).rejects.toThrow(/Only a batch request/);
  });

  it("while the partner is answering, an approval is refused but a decline still goes through", async () => {
    const db = seed(partial({ status: "adjusted", offered_pct: 90, offered_bbl: 36 }));
    await expect(decideRequest(db.client, "brewer-1", "req-3", { action: "approve", channel: "contract_brewing" })).rejects.toMatchObject({ status: 409 });
    await decideRequest(db.client, "brewer-1", "req-3", { action: "decline", note: "Tank fell through." });
    expect(db.tables.partner_requests[0].status).toBe("declined");
  });

  it("accepting makes the offer the request and sends it back to the inbox", async () => {
    const db = seed(partial({ status: "adjusted", offered_pct: 90, offered_bbl: 36, offer_note: "n" }));
    await answerOffer(db.client, "fortnight", "req-3", "partner-user", "accept");
    expect(db.tables.partner_requests[0]).toMatchObject({ status: "submitted", wanted_bbl: 36, share_pct: 90, offered_pct: 90 });
    expect(db.tables.partner_requests[0].offer_answered_at).toBeTruthy();
    // Now it books at the agreed share.
    await decideRequest(db.client, "brewer-1", "req-3", { action: "approve", channel: "contract_brewing" });
    expect(db.tables.commitments[0]).toMatchObject({ volume_bbl: 36 });
  });

  it("rescinding withdraws it, by the partner's own login; only the right company can answer", async () => {
    const db = seed(partial({ status: "adjusted", offered_pct: 90, offered_bbl: 36 }));
    await expect(answerOffer(db.client, "argus", "req-3", "someone", "accept")).rejects.toMatchObject({ status: 409 });
    await answerOffer(db.client, "fortnight", "req-3", "partner-user", "rescind");
    expect(db.tables.partner_requests[0]).toMatchObject({ status: "withdrawn", decided_by: "partner-user" });
    await expect(answerOffer(db.client, "fortnight", "req-3", "partner-user", "accept")).rejects.toMatchObject({ status: 409 });
  });
});
