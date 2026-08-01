import { describe, it, expect, vi } from "vitest";
import {
  describeConnection,
  listConnections,
  getConnection,
  getConnectionWithSecrets,
  resolveConnection,
  readDailyBalance,
  type IntegrationConnection,
} from "./connections";

type AdminClient = Parameters<typeof listConnections>[0];

function conn(over: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    id: "c1",
    provider: "ramp",
    label: "Ramp · Operating",
    externalId: "acct-1",
    config: {},
    status: "active",
    lastSyncedAt: "2026-08-01T09:00:00Z",
    lastError: null,
    ...over,
  };
}

/** Records every select() string so credential leakage is assertable. */
function stubClient(result: { data?: unknown; error?: { message: string } | null }) {
  const selects: string[] = [];
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  Object.assign(builder, {
    select: (cols: string) => { selects.push(cols); return builder; },
    eq: chain,
    order: chain,
    maybeSingle: async () => result,
    then: (resolve: (v: unknown) => unknown) => resolve(result),
  });
  const client = { from: () => builder } as unknown as AdminClient;
  return { client, selects };
}

describe("describeConnection", () => {
  it("reports a healthy connection with its label and last sync", () => {
    expect(describeConnection(conn())).toEqual({
      connected: true,
      label: "Ramp · Operating",
      lastSyncedAt: "2026-08-01T09:00:00Z",
    });
  });

  it("tells the operator what to do when there is no connection at all", () => {
    const status = describeConnection(null);
    expect(status.connected).toBe(false);
    expect(status.remedy).toMatch(/Choose an account/);
  });

  it("surfaces an expired credential as actionable rather than as an error", () => {
    const status = describeConnection(conn({ status: "needs_reauth" }));
    expect(status.connected).toBe(false);
    expect(status.remedy).toMatch(/expired.*[Rr]econnect/);
    // The last good sync still shows, so the operator can see how stale it is.
    expect(status.lastSyncedAt).toBe("2026-08-01T09:00:00Z");
  });

  it("passes the provider's own error through when a read failed", () => {
    const status = describeConnection(conn({ status: "error", lastError: "429 rate limited" }));
    expect(status.connected).toBe(false);
    expect(status.remedy).toBe("429 rate limited");
  });

  it("falls back to a generic remedy when an errored connection recorded no message", () => {
    expect(describeConnection(conn({ status: "error", lastError: null })).remedy).toMatch(/retry/);
  });

  it("treats a disabled connection as not connected", () => {
    expect(describeConnection(conn({ status: "disabled" })).connected).toBe(false);
  });
});

describe("credential safety", () => {
  it("listConnections never selects the credentials column", async () => {
    const { client, selects } = stubClient({ data: [], error: null });
    await listConnections(client);
    expect(selects).toHaveLength(1);
    expect(selects[0]).not.toContain("credentials");
  });

  it("getConnection never selects the credentials column", async () => {
    const { client, selects } = stubClient({ data: null, error: null });
    await getConnection(client, "c1");
    expect(selects[0]).not.toContain("credentials");
  });

  it("getConnectionWithSecrets is the only reader that asks for them", async () => {
    const { client, selects } = stubClient({ data: null, error: null });
    await getConnectionWithSecrets(client, "c1");
    expect(selects[0]).toContain("credentials");
  });
});

describe("resolveConnection", () => {
  it("returns null when the source declares no connection", async () => {
    const { client } = stubClient({ data: null, error: null });
    expect(await resolveConnection(client, {})).toBeNull();
  });

  it("returns null for a non-string or empty connectionId rather than querying", async () => {
    const { client, selects } = stubClient({ data: null, error: null });
    expect(await resolveConnection(client, { connectionId: 42 })).toBeNull();
    expect(await resolveConnection(client, { connectionId: "" })).toBeNull();
    expect(selects).toEqual([]);
  });

  it("returns null for a dangling id so an unconfigured account reads as unsourced", async () => {
    const { client } = stubClient({ data: null, error: null });
    expect(await resolveConnection(client, { connectionId: "gone" })).toBeNull();
  });
});

describe("readDailyBalance", () => {
  it("returns the captured balance for an exact date", async () => {
    const { client } = stubClient({ data: { balance_cents: 1_250_000 }, error: null });
    expect(await readDailyBalance(client, "coa-1", "2026-07-31")).toBe(1_250_000);
  });

  it("returns null when nothing was captured that day, never an older figure", async () => {
    // No fallback to the nearest earlier capture, on purpose: presenting a
    // stale bank balance as a month-end figure is plausible and undetectable.
    const { client } = stubClient({ data: null, error: null });
    expect(await readDailyBalance(client, "coa-1", "2026-07-31")).toBeNull();
  });

  it("degrades to null rather than throwing when the table is unreachable", async () => {
    const { client } = stubClient({ data: null, error: { message: "relation does not exist" } });
    await expect(readDailyBalance(client, "coa-1", "2026-07-31")).resolves.toBeNull();
  });

  it("queries the requested date, not today", async () => {
    const eq = vi.fn();
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      select: () => builder,
      eq: (col: string, val: unknown) => { eq(col, val); return builder; },
      maybeSingle: async () => ({ data: null, error: null }),
    });
    const client = { from: () => builder } as unknown as AdminClient;

    await readDailyBalance(client, "coa-1", "2026-07-31");
    expect(eq).toHaveBeenCalledWith("as_of_date", "2026-07-31");
  });
});
