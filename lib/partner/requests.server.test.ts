import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { claimPool } from "./claimable";

const loadClaimPools = vi.fn();
const recheck = vi.fn().mockResolvedValue(undefined);
vi.mock("./portal.server", () => ({ loadClaimPools: (...a: unknown[]) => loadClaimPools(...a) }));
vi.mock("@/lib/production/commitmentFulfillment", () => ({ recheckCommitmentFulfillment: (...a: unknown[]) => recheck(...a) }));

import { decideRequest, RequestError } from "./requests.server";

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
    const match = (r: Row) => Object.entries(state.filters).every(([k, v]) => r[k] === v);
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

  it("refuses contract brewing for a claim, and hands the request back undecided", async () => {
    const db = seed();
    await expect(decideRequest(db.client, "brewer-1", "req-1", { action: "approve", channel: "contract_brewing" }))
      .rejects.toThrow(/distribution or wholesale/);
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
